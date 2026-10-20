// Navicat macOS: Common / Main Window hot keys. Windows uses Ctrl+Q
// for New Query; macOS-only bindings must not become conflicting Ctrl aliases.
export type TableShortcut =
  | "all"
  | "copy"
  | "paste"
  | "find"
  | "refresh"
  | "new"
  | "design"
  | "duplicate"
  | "query"
  | "transfer";
type KeyEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};
export function isMacPlatform() {
  return /Mac|iPhone|iPad/.test(navigator.platform);
}
export function tableShortcut(
  event: KeyEvent,
  mac = isMacPlatform(),
): TableShortcut | undefined {
  if (event.altKey) return;
  if (
    !mac &&
    event.key === "F5" &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey
  )
    return "refresh";
  if (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)
    return;
  const key = event.key.toLowerCase();
  if (event.shiftKey) {
    if (mac && key === "d") return "duplicate";
    if (mac && key === "t") return "transfer";
    return;
  }
  const common: Record<string, TableShortcut> = {
    a: "all",
    c: "copy",
    v: "paste",
    f: "find",
    n: "new",
    d: "design",
  };
  if (key === (mac ? "y" : "q")) return "query";
  if (mac && key === "r") return "refresh";
  return common[key];
}
export function tableShortcutLabel(
  action: TableShortcut,
  mac = isMacPlatform(),
): string {
  const common: Partial<Record<TableShortcut, string>> = {
    all: "A",
    copy: "C",
    paste: "V",
    find: "F",
    new: "N",
    design: "D",
  };
  if (common[action]) return `${mac ? "⌘" : "Ctrl+"}${common[action]}`;
  if (action === "refresh") return mac ? "⌘R" : "F5";
  if (action === "query") return mac ? "⌘Y" : "Ctrl+Q";
  if (action === "duplicate") return mac ? "⇧⌘D" : "";
  if (action === "transfer") return mac ? "⇧⌘T" : "";
  return "";
}
