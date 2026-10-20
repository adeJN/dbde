import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  ChevronRight,
  Columns3,
  Copy,
  Download,
  Eraser,
  FileCode2,
  PencilLine,
  Pin,
  RefreshCw,
  Table2,
  Trash2,
  Upload,
  Wrench,
} from "lucide-react";
import type { Driver, TableInfo } from "../types";
import { tableShortcut, tableShortcutLabel } from "../lib/table-shortcuts";
import { maintainOperations, type MaintainOperation } from "../lib/maintain";

export type TableAction =
  | "quick"
  | "view"
  | "structure"
  | "ddl"
  | "rename"
  | "export"
  | "export-data"
  | "import"
  | "dump"
  | "copy"
  | "copy-data"
  | "transfer"
  | "shortcut"
  | "empty"
  | "truncate"
  | "drop"
  | "refresh";
export interface TableMenuTarget {
  x: number;
  y: number;
  trigger: HTMLElement;
}
/** The Maintain submenu: per-driver operations on the selected tables. */
export interface MaintainMenu {
  driver: Driver;
  /** Selected tables the operations apply to (views are skipped). */
  count: number;
  /** False when a selected MySQL table's engine cannot REPAIR (e.g. InnoDB). */
  repairable: boolean;
  onMaintain: (operation: MaintainOperation) => void;
}
export default function TableContextMenu({
  table,
  target,
  onAction,
  onClose,
  clipboardActions,
  maintain,
}: {
  table: TableInfo;
  target: TableMenuTarget;
  onAction: (action: TableAction) => void;
  onClose: () => void;
  clipboardActions?: { copy: () => void; paste: () => void; canPaste: boolean };
  maintain?: MaintainMenu;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const branchRef = useRef<HTMLButtonElement>(null);
  const focusSub = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState({ left: target.x, top: target.y });
  const [sub, setSub] = useState<{ left: number; top: number } | null>(null);
  function close(restore = false) {
    if (restore && target.trigger.isConnected) target.trigger.focus();
    closeRef.current();
  }
  function openSub(focus = false) {
    const button = branchRef.current;
    if (!button || button.disabled) return;
    const rect = button.getBoundingClientRect();
    focusSub.current = focus;
    setSub({
      left:
        rect.right + 250 < window.innerWidth
          ? rect.right + 4
          : Math.max(8, rect.left - 250),
      top: rect.top,
    });
  }
  useLayoutEffect(() => {
    if (!sub) return;
    const height = subRef.current?.getBoundingClientRect().height || 180;
    const top = Math.max(8, Math.min(sub.top, window.innerHeight - height - 8));
    if (top !== sub.top) setSub({ ...sub, top });
    if (focusSub.current) {
      subRef.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
      focusSub.current = false;
    }
  }, [sub]);
  useLayoutEffect(() => {
    const menu = ref.current!;
    const box = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(target.x, window.innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(target.y, window.innerHeight - box.height - 8)),
    });
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const inside = (node: Node) =>
      menu.contains(node) || !!subRef.current?.contains(node);
    const outside = (event: MouseEvent) => {
      if (!inside(event.target as Node)) closeRef.current();
    };
    const scroll = (event: Event) => {
      if (!inside(event.target as Node)) closeRef.current();
    };
    const resize = () => closeRef.current();
    window.addEventListener("mousedown", outside);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    };
  }, [target]);
  const isView = table.kind === "view";
  const item = (
    label: string,
    action: TableAction,
    icon: ReactNode,
    disabled = false,
  ) => (
    <button
      role="menuitem"
      title={
        action === "rename"
          ? "F2"
          : tableShortcutLabel(
              (
                {
                  structure: "design",
                  copy: "duplicate",
                  refresh: "refresh",
                  transfer: "transfer",
                } as const
              )[action as "structure" | "copy" | "refresh" | "transfer"],
            )
      }
      disabled={disabled}
      onPointerEnter={() => setSub(null)}
      onClick={() => {
        close(true);
        onAction(action);
      }}
    >
      <span>{label}</span>
      {icon}
    </button>
  );
  const maintainCount = maintain?.count ?? 0;
  const maintainDisabled =
    !maintain ||
    (maintainCount === 0 &&
      !maintainOperations(maintain.driver).some((op) => op.databaseWide));
  return (
    <>
      <div
        ref={ref}
        className="grid-context-menu table-context-menu"
        role="menu"
        aria-label={`${table.name} actions`}
        style={position}
        onKeyDown={(event) => {
          const shortcut = tableShortcut(event);
          const actions = {
            refresh: "refresh",
            design: "structure",
            duplicate: "copy",
            transfer: "transfer",
          } as const;
          if (shortcut && shortcut in actions) {
            event.preventDefault();
            event.stopPropagation();
            if (isView && ["duplicate", "transfer"].includes(shortcut)) return;
            close(true);
            onAction(actions[shortcut as keyof typeof actions]);
            return;
          }
          if (
            clipboardActions &&
            (shortcut === "copy" || shortcut === "paste")
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (shortcut === "copy" && !isView) {
              close(true);
              clipboardActions.copy();
            }
            if (shortcut === "paste" && clipboardActions.canPaste) {
              close(true);
              clipboardActions.paste();
            }
            return;
          }
          if (event.key === "Escape" || event.key === "Tab") {
            if (event.key === "Escape") event.preventDefault();
            close(true);
            return;
          }
          if (
            event.key === "ArrowRight" &&
            document.activeElement === branchRef.current
          ) {
            event.preventDefault();
            openSub(true);
            return;
          }
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ),
          );
          const index = items.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    items.length) %
                  items.length;
          items[next]?.focus();
        }}
      >
        {item("Open table", "view", <Table2 size={12} />)}
        {item("Open table quick", "quick", <Table2 size={12} />, isView)}
        {item("Design table…", "structure", <Columns3 size={12} />)}
        {item("Rename…", "rename", <PencilLine size={12} />)}
        {item("View DDL", "ddl", <FileCode2 size={12} />)}
        {item("Pin table shortcut", "shortcut", <Pin size={12} />)}
        <div className="context-separator" role="separator" />
        {clipboardActions && (
          <>
            <button
              role="menuitem"
              disabled={isView}
              onClick={() => {
                close(true);
                clipboardActions.copy();
              }}
            >
              <span>Copy</span>
              <Copy size={12} />
            </button>
            <button
              role="menuitem"
              disabled={!clipboardActions.canPaste}
              onClick={() => {
                close(true);
                clipboardActions.paste();
              }}
            >
              <span>Paste tables…</span>
              <Copy size={12} />
            </button>
            <div className="context-separator" role="separator" />
          </>
        )}
        {item("Copy structure only…", "copy", <Copy size={12} />, isView)}
        {item(
          "Copy structure and data…",
          "copy-data",
          <Copy size={12} />,
          isView,
        )}
        {item(
          "Transfer records…",
          "transfer",
          <ArrowUpRight size={12} />,
          isView,
        )}
        <div className="context-separator" role="separator" />
        {item("Import…", "import", <Upload size={12} />, isView)}
        {item("Export…", "export-data", <Download size={12} />)}
        {item("Dump SQL · structure", "export", <Download size={12} />)}
        {item(
          "Dump SQL · structure + data",
          "dump",
          <Download size={12} />,
          isView,
        )}
        {item("Refresh", "refresh", <RefreshCw size={12} />)}
        {maintain && (
          <>
            <div className="context-separator" role="separator" />
            <button
              ref={branchRef}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={!!sub}
              disabled={maintainDisabled}
              title={
                maintainDisabled
                  ? "Maintenance applies to tables, not views"
                  : undefined
              }
              onPointerEnter={() => openSub()}
              onClick={() => openSub(true)}
            >
              <span>
                Maintain
                {maintainCount > 1 ? ` (${maintainCount} tables)` : ""}
              </span>
              <span className="table-menu-branch-icons">
                <Wrench size={12} />
                <ChevronRight size={12} />
              </span>
            </button>
          </>
        )}
        <div className="context-separator" role="separator" />
        {item("Empty table…", "empty", <Eraser size={12} />, isView)}
        {item("Truncate…", "truncate", <Eraser size={12} />, isView)}
        {item(
          `Drop ${isView ? "view" : "table"}…`,
          "drop",
          <Trash2 size={12} />,
        )}
      </div>
      {maintain && sub && (
        <div
          ref={subRef}
          className="grid-context-menu table-context-submenu"
          role="menu"
          aria-label="Maintain"
          style={sub}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Escape" || event.key === "ArrowLeft") {
              event.preventDefault();
              setSub(null);
              branchRef.current?.focus();
              return;
            }
            if (event.key === "Tab") {
              close(true);
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            );
            const index = items.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? items.length - 1
                  : (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      items.length) %
                    items.length;
            items[next]?.focus();
          }}
        >
          {maintainOperations(maintain.driver).map((op) => {
            const blocked =
              (op.operation === "repair" && !maintain.repairable) ||
              (!op.databaseWide && maintainCount === 0);
            return (
              <button
                key={op.operation}
                role="menuitem"
                aria-label={`${op.label}${op.locking ? "…" : ""}`}
                disabled={blocked}
                title={
                  op.operation === "repair" && !maintain.repairable
                    ? "REPAIR TABLE works only on MyISAM, Aria, ARCHIVE and CSV tables. Use Check or Optimize for InnoDB."
                    : op.hint
                }
                onClick={() => {
                  close(true);
                  maintain.onMaintain(op.operation);
                }}
              >
                <span>
                  {op.label}
                  {op.locking ? "…" : ""}
                </span>
                <small>{op.hint}</small>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
