// Markdown as the chat panel and the file panel show it, with code
// highlighted. As chatwing renders it (its db/markdown.ts), for the
// languages Claude writes here.
import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";

const languages = { bash, css, diff, javascript, json, markdown, plaintext, python, shell, sql, swift, typescript, xml, yaml };
for (const [name, language] of Object.entries(languages)) hljs.registerLanguage(name, language);
hljs.registerAliases(["sh", "zsh"], { languageName: "bash" });
hljs.registerAliases(["ts", "tsx"], { languageName: "typescript" });
hljs.registerAliases(["js", "jsx", "mjs"], { languageName: "javascript" });
hljs.registerAliases(["html"], { languageName: "xml" });

// HTML in a message is text, as the terminal shows it: "<Select>" written
// about the component is that word, not a select box.
const escapeHtml = (html: string) => html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const highlight = () =>
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    },
  });

const marked = new Marked(
  {
    gfm: true,
    renderer: {
      html: ({ text, block }) => (block ? `<p>${escapeHtml(text.trimEnd()).replace(/\n/g, "<br>")}</p>\n` : escapeHtml(text)),
    },
  },
  highlight(),
);

/** Markdown as safe HTML. With `breaks`, each newline is one, as typed (your own messages). */
export function renderMarkdown(text: string, { breaks = false }: { breaks?: boolean } = {}): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, breaks }));
}

// A markdown file, as the file panel shows it: its headings have GitHub's
// ids, so links to them (`#getting-started`) go somewhere.
const slugs = new Map<string, number>();
const documentMarked = new Marked(
  { gfm: true },
  highlight(),
  {
    hooks: {
      preprocess(text) {
        slugs.clear();
        return text;
      },
    },
    renderer: {
      heading({ tokens, depth }) {
        const id = uniqueSlug(slug(unescapeHTML(this.parser.parseInline(tokens, this.parser.textRenderer))), slugs);
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
  },
);

/**
 * A markdown file as safe HTML, its YAML front matter shown as code (it'd
 * otherwise come out as a rule and a heading). Images are left as written:
 * the file panel finds them on the file's Mac, not the window's.
 */
export function renderMarkdownDocument(text: string): string {
  const { frontmatter, body } = splitFrontmatter(text);
  const front =
    frontmatter === null
      ? ""
      : `<pre class="frontmatter"><code class="hljs language-yaml">${hljs.highlight(frontmatter, { language: "yaml" }).value}</code></pre>`;
  // `user-content-` ids, or DOMPurify drops ones the document has a property
  // for (a heading called "Links" or "Title").
  return DOMPurify.sanitize(front + documentMarked.parse(body, { async: false }), { SANITIZE_NAMED_PROPS: true });
}

/** A leading `---` YAML block (Jekyll, Hugo, Astro, Claude Code's skills), and the rest. */
export function splitFrontmatter(text: string): { frontmatter: string | null; body: string } {
  const match = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { frontmatter: null, body: text };
  return { frontmatter: match[1] ?? "", body: text.slice(match[0].length) };
}

/** A heading's id as GitHub makes it: lowercase, punctuation gone, spaces as dashes. */
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** A second heading with the same slug gets `-1`, a third `-2`, as on GitHub. */
function uniqueSlug(base: string, seen: Map<string, number>): string {
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

const unescapeHTML = (html: string) =>
  html.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity]!);

/** Whether the file panel shows a file rendered, by its name. */
export const isMarkdown = (path: string) => /\.(md|markdown|mdown|mkdn?|mdx)$/i.test(path);

/**
 * Where a markdown file's link or image goes, if it's to a file: an absolute
 * path on the file's Mac, resolved from the file's folder. Null for web
 * addresses, `mailto:` and the like, and links within the file (`#…`).
 */
export function resolveLocalPath(href: string, from: string): string | null {
  // Any scheme (DOMPurify takes out `file:` ones), or another host.
  if (href.startsWith("#") || href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  try {
    const base = "file://" + encodeURI(from).replace(/[?#]/g, encodeURIComponent);
    return decodeURIComponent(new URL(href, base).pathname);
  } catch {
    return null;
  }
}

/** A Copy button on each of these blocks of code, which `copyCode` makes work. */
export function addCopyButtons(blocks: Iterable<HTMLPreElement>) {
  for (const pre of [...blocks]) {
    const wrapper = document.createElement("div");
    wrapper.className = "code";
    pre.replaceWith(wrapper);
    const button = document.createElement("button");
    button.className = "copy";
    button.textContent = "Copy";
    wrapper.append(pre, button);
  }
}

/** For a click on a code block's Copy: copies its code, and says so for a moment. Whether it was one. */
export function copyCode(target: HTMLElement): boolean {
  const copy = target.closest("button.copy");
  if (!copy) return false;
  window.miks?.copy(copy.parentElement?.querySelector("pre")?.textContent ?? "");
  copy.textContent = "Copied";
  setTimeout(() => (copy.textContent = "Copy"), 1200);
  return true;
}

/**
 * Markdown as both panels show it: quotes, code (with `addCopyButtons`'),
 * tables, task lists. Each adds its own spacing, headings and links.
 */
export function markdownCSS(): string {
  return `
    ${taskListCSS()}

    blockquote {
      padding-left: 12px;
      border-left: 3px solid ${colors.separator()};
      color: ${colors.textSecondary()};
    }

    hr {
      border: none;
      border-top: 1px solid ${colors.separator()};
    }

    .code {
      position: relative;

      > pre {
        margin: 0;
      }

      > .copy {
        position: absolute;
        top: 6px;
        right: 6px;
        padding: 2px 8px;
        border-radius: 6px;
        border: 1px solid ${colors.separator()};
        background: ${colors.textBackground()};
        color: ${colors.textSecondary()};
        font: ${fonts.display({ size: 11, line: "16px" })};
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.15s;
      }

      &:hover > .copy {
        opacity: 1;
      }
    }

    pre {
      background: ${colors.textBackground()};
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid ${colors.separator()};
      overflow-x: auto;
      font: ${fonts.displayMono({ size: 12, line: "18px" })};
    }

    code:not(pre > code) {
      padding: 1px 4px;
      border-radius: 4px;
      background: ${colors.textBackground()};
      border: 1px solid ${colors.separator()};
      overflow-wrap: anywhere;
      font: ${fonts.displayMono({ size: 12.5, line: "18px" })};
    }

    table {
      border-collapse: collapse;
      display: block;
      overflow-x: auto;
      max-width: 100%;
      font: ${fonts.display({ size: 13, line: "19px" })};

      th,
      td {
        text-align: left;
        vertical-align: top;
        border: 1px solid ${colors.separator()};
      }

      th {
        font: ${fonts.displayBold({ size: 13, line: "19px" })};
        background: ${colors.textBackgroundAlt()};
      }
    }

    ${highlightCSS()}
  `;
}

/** highlight.js's classes, in VS Code's colors (as the terminal's are). */
export function highlightCSS(): string {
  return `
    .hljs-comment, .hljs-quote { color: #008000; }
    .hljs-keyword, .hljs-literal, .hljs-built_in, .hljs-selector-tag { color: #0000ff; }
    .hljs-string, .hljs-attr + .hljs-string, .hljs-regexp { color: #a31515; }
    .hljs-number { color: #098658; }
    .hljs-title, .hljs-title.function_ { color: #795e26; }
    .hljs-attr, .hljs-variable, .hljs-params, .hljs-property { color: #001080; }
    .hljs-type, .hljs-title.class_ { color: #267f99; }
    .hljs-meta { color: #af00db; }
    .hljs-addition { color: #098658; background: rgba(9, 134, 88, 0.08); }
    .hljs-deletion { color: #a31515; background: rgba(163, 21, 21, 0.08); }

    @media (prefers-color-scheme: dark) {
      .hljs-comment, .hljs-quote { color: #6a9955; }
      .hljs-keyword, .hljs-literal, .hljs-built_in, .hljs-selector-tag { color: #569cd6; }
      .hljs-string, .hljs-attr + .hljs-string, .hljs-regexp { color: #ce9178; }
      .hljs-number { color: #b5cea8; }
      .hljs-title, .hljs-title.function_ { color: #dcdcaa; }
      .hljs-attr, .hljs-variable, .hljs-params, .hljs-property { color: #9cdcfe; }
      .hljs-type, .hljs-title.class_ { color: #4ec9b0; }
      .hljs-meta { color: #c586c0; }
      .hljs-addition { color: #b5cea8; background: rgba(181, 206, 168, 0.1); }
      .hljs-deletion { color: #ce9178; background: rgba(206, 145, 120, 0.1); }
    }
  `;
}

/** Task lists ("- [x]") with boxes of their own. */
export function taskListCSS(): string {
  return `
    /* Task lists ("- [x]"): a box of our own instead of a bullet, since
       marked's are disabled checkboxes, which the browser fades. */
    li:has(> input[type="checkbox"]:first-child) {
      list-style: none;
      margin-left: -20px;
    }

    input[type="checkbox"] {
      appearance: none;
      width: 14px;
      height: 14px;
      margin: 0 6px 0 0;
      vertical-align: -2px;
      border-radius: 4px;
      border: 1.5px solid ${colors.textSecondary({ alpha: 0.6 })};
      box-sizing: border-box;

      &:checked {
        border: none;
        background: #5b4fd1
          url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 14'%3E%3Cpath d='M3.5 7.2l2.3 2.3 4.7-4.9' fill='none' stroke='white' stroke-width='1.8' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
          center / 14px 14px no-repeat;

        @media (prefers-color-scheme: dark) {
          background-color: #7d70f0;
        }
      }
    }
  `;
}
