import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronRight, Slash, X } from "lucide-react";
import type { ConnectionConfig } from "../types";
import {
  connectionColors,
  flushCommands,
  type ConnectionAppearance,
} from "../lib/connection-menu";
export type ConnectionAction =
  | "open"
  | "close"
  | "switch"
  | "edit"
  | "new"
  | "delete"
  | "duplicate"
  | "new-database"
  | "query"
  | "execute-file"
  | "flush"
  | "star"
  | "color"
  | "group"
  | "new-group"
  | "share"
  | "refresh";
export interface ConnectionMenuTarget {
  config: ConnectionConfig;
  sessionId?: string;
  x: number;
  y: number;
  trigger: HTMLElement;
}
export default function ConnectionContextMenu({
  target,
  profiles,
  appearance,
  groups,
  onAction,
  onClose,
}: {
  target: ConnectionMenuTarget;
  profiles: ConnectionConfig[];
  appearance: ConnectionAppearance;
  groups: string[];
  onAction: (action: ConnectionAction, value?: string) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null),
    sub = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({
    x: Math.max(8, Math.min(target.x, window.innerWidth - 318)),
    y: 8,
  });
  const [submenu, setSubmenu] = useState<{
    kind: "profiles" | "flush" | "groups";
    x: number;
    y: number;
  } | null>(null);
  const subTrigger = useRef<HTMLButtonElement | null>(null),
    focusSub = useRef(false);
  const mod = /mac/i.test(navigator.platform) ? "⌘" : "Ctrl+";
  useLayoutEffect(() => {
    setPosition({
      x: Math.max(8, Math.min(target.x, window.innerWidth - 318)),
      y: Math.max(
        8,
        Math.min(
          target.y,
          window.innerHeight -
            (root.current?.getBoundingClientRect().height || 510) -
            8,
        ),
      ),
    });
    root.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
  }, [target]);
  useLayoutEffect(() => {
    if (!submenu) return;
    const height = sub.current?.getBoundingClientRect().height || 160;
    const y = Math.max(8, Math.min(submenu.y, window.innerHeight - height - 8));
    if (y !== submenu.y) setSubmenu({ ...submenu, y });
    if (focusSub.current) {
      sub.current
        ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
        ?.focus();
      focusSub.current = false;
    }
  }, [submenu]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (
        !root.current?.contains(event.target as Node) &&
        !sub.current?.contains(event.target as Node)
      )
        onClose();
    };
    const reposition = () => onClose();
    const closeOnScroll = (event: Event) => {
      if (
        event.target instanceof Node &&
        (root.current?.contains(event.target) ||
          sub.current?.contains(event.target))
      )
        return;
      onClose();
    };
    document.addEventListener("pointerdown", close);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [onClose]);
  function act(action: ConnectionAction, value?: string) {
    onClose();
    onAction(action, value);
  }
  function openSub(
    button: HTMLButtonElement,
    kind: "profiles" | "flush" | "groups",
    focus = false,
  ) {
    if (button.disabled) return;
    const rect = button.getBoundingClientRect();
    subTrigger.current = button;
    focusSub.current = focus;
    setSubmenu({
      kind,
      x:
        rect.right + 238 < window.innerWidth
          ? rect.right + 5
          : Math.max(8, rect.left - 238),
      y: rect.top,
    });
  }
  function keyDown(event: React.KeyboardEvent<HTMLDivElement>, nested = false) {
    if (event.key === "Escape" || (nested && event.key === "ArrowLeft")) {
      event.preventDefault();
      event.stopPropagation();
      if (submenu) {
        setSubmenu(null);
        subTrigger.current?.focus();
      } else onClose();
      return;
    }
    if (event.key === "Tab") {
      onClose();
      return;
    }
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      "button",
    );
    if (event.key === "ArrowRight" && button?.dataset.submenu) {
      event.preventDefault();
      openSub(
        button,
        button.dataset.submenu as "profiles" | "flush" | "groups",
        true,
      );
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      act("query");
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") {
      event.preventDefault();
      act("refresh");
      return;
    }
    if (
      (event.metaKey || event.ctrlKey) &&
      event.shiftKey &&
      [".", ">"].includes(event.key)
    ) {
      event.preventDefault();
      act(target.sessionId ? "close" : "open");
      return;
    }
    const horizontalColors =
      button?.dataset.color !== undefined &&
      ["ArrowLeft", "ArrowRight"].includes(event.key);
    if (
      !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
      !horizontalColors
    )
      return;
    event.preventDefault();
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        horizontalColors
          ? "button[data-color]"
          : 'button[role^="menuitem"]:not(:disabled)',
      ),
    );
    const current = items.indexOf(button!);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current +
              (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1) +
              items.length) %
            items.length;
    items[next]?.focus();
  }
  const item = (
    label: string,
    action: ConnectionAction,
    shortcut?: string,
    disabled = false,
  ) => (
    <button
      role="menuitem"
      disabled={disabled}
      onPointerEnter={() => setSubmenu(null)}
      onClick={() => act(action)}
    >
      <span>{label}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
  const branch = (
    label: string,
    kind: "profiles" | "flush" | "groups",
    disabled = false,
  ) => (
    <button
      role="menuitem"
      data-submenu={kind}
      aria-haspopup="menu"
      aria-expanded={submenu?.kind === kind}
      disabled={disabled}
      onPointerEnter={(event) => openSub(event.currentTarget, kind)}
      onClick={(event) => openSub(event.currentTarget, kind, true)}
    >
      <span>{label}</span>
      <ChevronRight size={15} />
    </button>
  );
  const separator = () => (
    <div className="context-separator" role="separator" />
  );
  return (
    <>
      <div
        className="grid-context-menu connection-context-menu"
        role="menu"
        aria-label={`${target.config.name} connection actions`}
        ref={root}
        style={{ left: position.x, top: position.y }}
        onKeyDown={(event) => keyDown(event)}
      >
        {item(
          target.sessionId ? "Close Connection" : "Open Connection",
          target.sessionId ? "close" : "open",
          target.sessionId ? `⇧${mod}.` : undefined,
        )}
        {branch(
          "Switch Connection Profile",
          "profiles",
          !profiles.some((p) => p.id !== target.config.id),
        )}
        {separator()}
        {item("Edit Connection…", "edit")}
        {item("New Connection", "new")}
        {item("Delete Connection", "delete")}
        {item("Duplicate Connection…", "duplicate")}
        {separator()}
        {item(
          "New Database…",
          "new-database",
          undefined,
          target.config.driver === "sqlite",
        )}
        {item("New Query", "query", `${mod}Y`)}
        {separator()}
        {item("Execute SQL File…", "execute-file")}
        {branch(
          "Flush",
          "flush",
          target.config.driver !== "mysql" || !target.sessionId,
        )}
        {separator()}
        {item(appearance.starred ? "Remove Star" : "Add Star", "star")}
        <div className="connection-colors">
          <span>Color:</span>
          <div role="group" aria-label="Connection color">
            <button
              role="menuitem"
              data-color=""
              aria-label="Remove color"
              onClick={() => act("color", "")}
            >
              <X size={14} />
            </button>
            {connectionColors.map((color, index) => (
              <button
                key={color}
                role="menuitemradio"
                aria-checked={appearance.color === color}
                aria-label={`Color ${["red", "amber", "yellow", "green", "blue", "purple", "gray"][index]}`}
                data-color={color}
                style={{ background: color }}
                onClick={() => act("color", color)}
              >
                {appearance.color === color && <Check size={12} />}
              </button>
            ))}
            <button
              role="menuitemradio"
              aria-checked={!appearance.color}
              data-color="none"
              aria-label="No color"
              className="connection-no-color"
              onClick={() => act("color", "")}
            >
              <Slash size={12} />
            </button>
          </div>
        </div>
        {separator()}
        {branch("Manage Group", "groups")}
        {item("Share…", "share")}
        {separator()}
        {item("Refresh", "refresh", `${mod}R`)}
      </div>
      {submenu && (
        <div
          className="grid-context-menu connection-submenu"
          role="menu"
          aria-label={
            submenu.kind === "profiles"
              ? "Connection profiles"
              : submenu.kind === "flush"
                ? "Flush options"
                : "Connection groups"
          }
          ref={sub}
          style={{ left: submenu.x, top: submenu.y }}
          onKeyDown={(event) => keyDown(event, true)}
        >
          {submenu.kind === "profiles" &&
            profiles.map((profile) => (
              <button
                role="menuitemradio"
                aria-checked={profile.id === target.config.id}
                key={profile.id}
                onClick={() => act("switch", profile.id)}
              >
                <span>{profile.name}</span>
                {profile.id === target.config.id && <Check size={13} />}
              </button>
            ))}
          {submenu.kind === "flush" &&
            Object.keys(flushCommands).map((name) => (
              <button
                role="menuitem"
                key={name}
                onClick={() => act("flush", name)}
              >
                {name}
              </button>
            ))}
          {submenu.kind === "groups" && (
            <>
              <button
                role="menuitemradio"
                aria-checked={!appearance.group}
                onClick={() => act("group", "")}
              >
                <span>No Group</span>
                {!appearance.group && <Check size={13} />}
              </button>
              {groups.map((group) => (
                <button
                  key={group}
                  role="menuitemradio"
                  aria-checked={appearance.group === group}
                  onClick={() => act("group", group)}
                >
                  <span>{group}</span>
                  {appearance.group === group && <Check size={13} />}
                </button>
              ))}
              {separator()}
              <button role="menuitem" onClick={() => act("new-group")}>
                New Group…
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
