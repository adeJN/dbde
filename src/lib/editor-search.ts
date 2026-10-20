import type { editor } from "monaco-editor";
import { isMacPlatform } from "./table-shortcuts";

export type EditorSearch = "find" | "replace";

export function editorSearchFromKey(event: {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): EditorSearch | null {
  const mac = isMacPlatform();
  if (event.shiftKey || !(mac ? event.metaKey : event.ctrlKey)) return null;
  const code = event.code || `Key${event.key.toUpperCase()}`;
  if (code === "KeyF") return event.altKey ? (mac ? "replace" : null) : "find";
  if (!mac && !event.altKey && code === "KeyH") return "replace";
  return null;
}

export function editorSearchShortcut(action: EditorSearch): string {
  if (action === "find") return isMacPlatform() ? "⌘F" : "Ctrl+F";
  return isMacPlatform() ? "⌥⌘F" : "Ctrl+H";
}

export async function openEditorSearch(
  instance: editor.ICodeEditor | null,
  action: EditorSearch,
) {
  if (!instance || instance.getModel() === null) return;
  instance.focus();
  await instance
    .getAction(
      action === "find"
        ? "actions.find"
        : "editor.action.startFindReplaceAction",
    )
    ?.run();
}
