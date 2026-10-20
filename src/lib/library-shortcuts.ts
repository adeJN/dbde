import { isMacPlatform } from "./table-shortcuts";

export type LibraryPanel = "history" | "queries" | "snippets";

/**
 * Window-wide shortcuts for the query library: Ctrl/⌘+Shift+H (history) and
 * Ctrl/⌘+Shift+O (saved queries). On macOS only ⌘ counts so Ctrl+Shift+H stays
 * free; elsewhere only Ctrl. Neither combination is used by the SQL editor, the
 * data grid or the table list.
 */
export function libraryShortcutFromKey(
  event: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  mac = isMacPlatform(),
): LibraryPanel | undefined {
  const command = mac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!command || !event.shiftKey || event.altKey) return undefined;
  const key = event.key.toLowerCase();
  if (key === "h") return "history";
  if (key === "o") return "queries";
  return undefined;
}

export function libraryShortcutLabel(
  panel: "history" | "queries",
  mac = isMacPlatform(),
) {
  const key = panel === "history" ? "H" : "O";
  return mac ? `⇧⌘${key}` : `Ctrl+Shift+${key}`;
}
