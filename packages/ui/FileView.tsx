import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { Compartment, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { colors } from "crosswing/colors";
import { fonts } from "crosswing/fonts";
import { useMatchMedia } from "crosswing/hooks/useMatchMedia";
import { ModalContext } from "crosswing/modals/context";
import { tooltip } from "crosswing/modals/popup";
import { X } from "lucide-react";
import type { OpenFile, Tab } from "miks/shared/protocol";
import { displayPath } from "miks/shared/settings";
import { use, useEffect, useLayoutEffect, useRef, useState } from "react";
import { styled } from "styled-components";
import { daemon, type FileEvent } from "./daemon";
import { codemirrorDark } from "./highlighting/codemirrorDark";
import { codemirrorLight } from "./highlighting/codemirrorLight";
import { isMarkdown } from "./markdown";
import { headingPending, MarkdownView } from "./MarkdownView";
import { autoFocus, getSettings } from "./settings";
import { terminalScrollbarCSS } from "./TerminalView";

/**
 * The file `miks open` or `miks edit` put in a tab's panel: read-only until
 * you press Edit (or opened with `miks edit`), saved with ⌘S. The daemon
 * reads and writes it, so it's the file on the tab's Mac, in a window on
 * another Mac too. It follows the file on disk; a change there while you
 * have unsaved ones of your own asks which to keep. A markdown file shows
 * rendered (Preview) until you switch to its source or press Edit.
 */
export function FileView({
  tab,
  file,
  focusOnOpen,
  onHide,
}: {
  tab: Tab;
  file: OpenFile;
  focusOnOpen: boolean;
  /** Escape: hides the panel, the file still open in it as it was. */
  onHide: () => void;
}) {
  const { showToast } = use(ModalContext);
  const dark = useMatchMedia("(prefers-color-scheme: dark)");
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [compartments] = useState(() => ({
    theme: new Compartment(),
    language: new Compartment(),
    editable: new Compartment(),
  }));

  // What's on disk, as last read or saved: what a save checks it against.
  const [disk, setDisk] = useState<FileEvent | null>(null);
  const diskRef = useRef<FileEvent | null>(null);
  const [editing, setEditing] = useState(file.edit);
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  // Changed on disk while you had changes of your own.
  const [conflict, setConflict] = useState<FileEvent | null>(null);
  const [saving, setSaving] = useState(false);
  const markdown = isMarkdown(file.path);
  const [preview, setPreview] = useState(markdown && !file.edit);
  const previewRef = useRef(preview);
  // What the preview shows: the editor's text, saved or not.
  const [previewText, setPreviewText] = useState<string | null>(null);

  const name = file.path.split("/").pop() ?? file.path;
  const folder = file.path.slice(0, file.path.length - name.length - 1);
  const home = daemon.getSnapshot().state?.home ?? null;

  function showPreview(value: boolean) {
    previewRef.current = value;
    setPreview(value);
    if (value && viewRef.current) setPreviewText(viewRef.current.state.doc.toString());
  }

  function markDirty(value: boolean) {
    dirtyRef.current = value;
    setDirty(value);
    // Kept open while it has changes, however many more files open.
    daemon.fileUnsaved(tab.id, file.id, value);
  }

  function replaceText(text: string) {
    const view = viewRef.current;
    if (!view) return;
    const cursor = Math.min(view.state.selection.main.head, text.length);
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: cursor } });
  }

  // The file as the daemon has it, now and whenever it changes on disk.
  useEffect(() => {
    return daemon.watchFile(tab.id, file.id, (event) => {
      const before = diskRef.current;
      // What we've seen already (our own save, coming back).
      if (before && event.mtime === before.mtime) return;

      if (!before || !dirtyRef.current) {
        diskRef.current = event;
        setDisk(event);
        if (before && event.content !== null) replaceText(event.content);
      } else {
        setConflict(event);
      }
    });
  }, [tab.id, file.id]);

  // The editor, once there's text to put in it.
  const ready = disk !== null && disk.content !== null;
  useEffect(() => {
    if (!ready || !editorRef.current || !diskRef.current) return;

    const view = new EditorView({
      parent: editorRef.current,
      state: EditorState.create({
        doc: diskRef.current.content ?? "",
        extensions: [
          basicSetup,
          keymap.of([
            {
              key: "Mod-s",
              run: () => {
                void save();
                return true;
              },
            },
          ]),
          // Escape hides the panel, once CodeMirror has nothing of its own
          // to close with it (search, completions).
          Prec.lowest(
            keymap.of([
              {
                key: "Escape",
                run: () => {
                  onHide();
                  return true;
                },
              },
            ]),
          ),
          compartments.theme.of(dark ? codemirrorDark : codemirrorLight),
          compartments.language.of([]),
          compartments.editable.of(editableExtension(editing)),
          // Unsaved: different from the file as it is on disk.
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const text = update.state.doc.toString();
            markDirty(text !== diskRef.current?.content);
            // Only the file changing on disk, while it's the preview on show.
            if (previewRef.current) setPreviewText(text);
          }),
        ],
      }),
    });
    viewRef.current = view;
    // A new editor (the file gone and back): the preview follows its text.
    setPreviewText(null);

    // Highlighting for the file's language, loaded when it's first needed.
    const language = LanguageDescription.matchFilename(languages, name);
    void language?.load().then((support) => {
      if (viewRef.current === view) view.dispatch({ effects: compartments.language.reconfigure(support) });
    });

    if (focusOnOpen && autoFocus()) view.focus();
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [ready, file.id]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.theme.reconfigure(dark ? codemirrorDark : codemirrorLight) });
  }, [dark]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: compartments.editable.reconfigure(editableExtension(editing)) });
    if (editing) viewRef.current?.focus();
  }, [editing]);

  // Open already, and opened again: a link to one of its headings shows it
  // rendered, and `miks edit` (or $EDITOR) to edit, any unsaved changes kept.
  // A layout effect, to see the heading before the preview's own effect takes it.
  const opened = useRef(file.opened);
  useLayoutEffect(() => {
    if (opened.current === file.opened) return;
    opened.current = file.opened;
    if (markdown && headingPending(tab.id, file.path)) {
      showPreview(true);
    } else if (file.edit && !editing) {
      showPreview(false);
      setEditing(true);
    }
  }, [file.opened]);

  /** Saves, asking first if it changed on disk since. Resolves with whether it's saved. */
  async function save(force = false): Promise<boolean> {
    const view = viewRef.current;
    if (!view || saving) return false;
    if (!dirtyRef.current && !force) return true;

    setSaving(true);
    const content = view.state.doc.toString();
    const result = await daemon.saveFile(tab.id, file.id, content, diskRef.current?.mtime ?? null, force);
    setSaving(false);

    if (result.changed) {
      const overwrite = await window.miks?.confirm({
        message: `${name} changed on disk.`,
        detail: "Save over it with yours? Its changes will be lost.",
        button: "Save over it",
      });
      return overwrite ? save(true) : false;
    }
    if (result.error || result.mtime === undefined) {
      showToast({ title: `Couldn't save ${name}`, message: result.error, destructive: true });
      return false;
    }

    const saved = { id: file.id, content, mtime: result.mtime };
    diskRef.current = saved;
    setDisk(saved);
    setConflict(null);
    // Typing while it saved isn't saved.
    markDirty(view.state.doc.toString() !== content);
    return true;
  }

  async function close() {
    if (dirtyRef.current) {
      const discard = await window.miks?.confirm({
        message: `Close ${name} without saving?`,
        detail: "Your changes will be lost.",
        button: "Don't save",
      });
      if (!discard) return;
    }
    daemon.send({ type: "closeFile", tabId: tab.id, fileId: file.id });
  }

  /** A link in the preview to another file: it opens beside this one. */
  function openLinked(path: string) {
    if (!daemon.speaks(10)) {
      const linked = path.split("/").pop() ?? path;
      showToast({ title: `Couldn't open ${linked}`, message: "This tab's Mac has an older Miks. Update it there to follow links to files." });
      return;
    }
    daemon.send({ type: "openFile", tabId: tab.id, path });
  }

  // `--wait` (as $EDITOR): saved, closed, and whatever waited goes on.
  async function done() {
    if (await save()) daemon.send({ type: "closeFile", tabId: tab.id, fileId: file.id });
  }

  function resolveConflict(take: "disk" | "mine") {
    if (!conflict) return;
    diskRef.current = conflict;
    setDisk(conflict);
    if (take === "disk" && conflict.content !== null) replaceText(conflict.content);
    // Keeping yours: still unsaved, and saving goes over the file's.
    else markDirty(true);
    setConflict(null);
  }

  const problem =
    disk?.problem === "binary"
      ? "This isn't a text file."
      : disk?.problem === "large"
        ? "This file is too big to open here (over 5 MB)."
        : disk?.problem === "unreadable"
          ? "This file can't be read."
          : null;

  return (
    <StyledFileView>
      <div className="header">
        <div className="name" title={file.path}>
          <span className="file">
            {name}
            {dirty && <span className="dirty" {...tooltip("Not saved", { delay: true })} />}
          </span>
          <span className="folder">{displayPath(folder || "/", getSettings().hidePathPrefix, home)}</span>
        </div>
        {ready && markdown && (
          <div className="mode">
            <button data-on={preview} onClick={() => showPreview(true)}>
              Preview
            </button>
            <button data-on={!preview} onClick={() => showPreview(false)}>
              Source
            </button>
          </div>
        )}
        {ready && !editing && (
          <button
            className="action"
            onClick={() => {
              showPreview(false);
              setEditing(true);
            }}
          >
            Edit
          </button>
        )}
        {ready && editing && !file.wait && (
          <button className="action" disabled={!dirty || saving} onClick={() => void save()} {...tooltip("Save", { hotkey: "cmd+s", delay: true })}>
            Save
          </button>
        )}
        {file.wait && (
          <button className="action primary" disabled={saving} onClick={() => void done()} {...tooltip("Save and close, and let what's waiting go on", { delay: true })}>
            Done
          </button>
        )}
        <button className="close" onClick={() => void close()} {...tooltip("Close", { delay: true })}>
          <X size={15} />
        </button>
      </div>
      {conflict && (
        <div className="conflict">
          <span>{name} changed on disk.</span>
          <button onClick={() => resolveConflict("disk")}>Use the file's</button>
          <button onClick={() => resolveConflict("mine")}>Keep mine</button>
        </div>
      )}
      {problem ? (
        <div className="note">{problem}</div>
      ) : (
        <>
          {/* Kept while the preview shows, with whatever you haven't saved. */}
          <div className="editor" ref={editorRef} hidden={preview} />
          {preview && ready && (
            <MarkdownView
              tab={tab}
              file={file}
              text={previewText ?? disk?.content ?? ""}
              onOpenFile={openLinked}
              onHide={onHide}
            />
          )}
        </>
      )}
    </StyledFileView>
  );
}

const editableExtension = (editing: boolean) => [EditorView.editable.of(editing), EditorState.readOnly.of(!editing)];

const StyledFileView = styled.div`
  flex-grow: 1;
  min-height: 0;
  display: flex;
  flex-flow: column;

  > .header {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px 8px 16px;
    border-bottom: 1px solid ${colors.separator()};

    > .name {
      flex-grow: 1;
      min-width: 0;
      display: flex;
      flex-flow: column;

      > .file {
        display: flex;
        align-items: center;
        gap: 6px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font: ${fonts.displayBold({ size: 13, line: "18px" })};

        > .dirty {
          flex-shrink: 0;
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: ${colors.textSecondary()};
        }
      }

      > .folder {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: ${colors.textSecondary()};
        font: ${fonts.display({ size: 11, line: "15px" })};
      }
    }

    /* Like the panel's switcher above it. */
    > .mode {
      flex-shrink: 0;
      display: flex;
      gap: 2px;

      > button {
        height: 26px;
        padding: 0 10px;
        border: none;
        border-radius: 13px;
        background: transparent;
        color: ${colors.textSecondary()};
        font: ${fonts.displayMedium({ size: 12, line: "16px" })};
        cursor: pointer;

        &[data-on="true"] {
          background: ${colors.buttonBackgroundGlow()};
          color: ${colors.text()};
        }
      }
    }

    > .action {
      flex-shrink: 0;
      height: 26px;
      padding: 0 12px;
      border-radius: 13px;
      border: 1px solid ${colors.separator()};
      background: ${colors.textBackground()};
      color: ${colors.text()};
      font: ${fonts.displayMedium({ size: 12, line: "16px" })};
      cursor: pointer;

      &:disabled {
        opacity: 0.4;
        cursor: default;
      }

      &.primary {
        border-color: transparent;
        background: #5b4fd1;
        color: #fff;
      }
    }

    > .close {
      flex-shrink: 0;
      width: 26px;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 7px;
      background: transparent;
      color: ${colors.textSecondary()};
      cursor: pointer;

      &:hover {
        background: ${colors.buttonBackgroundGlow()};
        color: ${colors.text()};
      }
    }
  }

  > .conflict {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 16px;
    background: ${colors.yellow({ alpha: 0.2 })};
    border-bottom: 1px solid ${colors.separator()};
    font: ${fonts.display({ size: 12, line: "16px" })};

    > span {
      flex-grow: 1;
    }

    > button {
      border: none;
      background: none;
      color: inherit;
      font: ${fonts.displayBold({ size: 12, line: "16px" })};
      cursor: pointer;
    }
  }

  > .note {
    padding: 24px;
    color: ${colors.textSecondary()};
    text-align: center;
  }

  > .editor[hidden] {
    display: none;
  }

  > .editor {
    flex-grow: 1;
    min-height: 0;
    display: flex;

    > .cm-editor {
      flex-grow: 1;
      min-width: 0;
      font: ${fonts.displayMono({ size: 12.5, line: "19px" })};

      &.cm-focused {
        outline: none;
      }

      .cm-scroller {
        font: inherit;
        ${terminalScrollbarCSS()}
      }
    }
  }
`;
