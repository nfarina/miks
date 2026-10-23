// Markdown as the chat panel shows it, with code highlighted. As chatwing
// renders it (its db/markdown.ts), for the languages Claude writes here.
import { colors } from "crosswing/colors";
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

const marked = new Marked(
  {
    gfm: true,
    renderer: {
      html: ({ text, block }) => (block ? `<p>${escapeHtml(text.trimEnd()).replace(/\n/g, "<br>")}</p>\n` : escapeHtml(text)),
    },
  },
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    },
  }),
);

/** Markdown as safe HTML. With `breaks`, each newline is one, as typed (your own messages). */
export function renderMarkdown(text: string, { breaks = false }: { breaks?: boolean } = {}): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, breaks }));
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
