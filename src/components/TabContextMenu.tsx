import { useLayoutEffect, useRef, useState } from "react";
export type TabAction =
  "close" | "others" | "right" | "all" | "move" | "favorite" | "reveal";
export interface TabMenuTarget {
  id: string;
  x: number;
  y: number;
  trigger: HTMLElement;
}
export default function TabContextMenu({
  target,
  name,
  disabled,
  favorite,
  onAction,
  onClose,
}: {
  target: TabMenuTarget;
  name: string;
  disabled: Partial<Record<TabAction, boolean>>;
  favorite: boolean;
  onAction: (action: TabAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: target.x, top: target.y });
  useLayoutEffect(() => {
    const menu = ref.current!;
    const rect = menu.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(target.x, window.innerWidth - rect.width - 8)),
      top: Math.max(
        8,
        Math.min(target.y, window.innerHeight - rect.height - 8),
      ),
    });
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: MouseEvent) => {
      if (!menu.contains(event.target as Node)) onClose();
    };
    const close = () => onClose();
    window.addEventListener("mousedown", outside);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", outside);
      window.removeEventListener("resize", close);
    };
  }, [target, onClose]);
  const item = (label: string, action: TabAction) => (
    <button
      role="menuitem"
      disabled={disabled[action]}
      onClick={() => onAction(action)}
    >
      {label}
    </button>
  );
  return (
    <div
      ref={ref}
      className="grid-context-menu tab-context-menu"
      role="menu"
      aria-label={`${name} tab actions`}
      style={position}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") {
          if (event.key === "Escape") event.preventDefault();
          onClose();
          target.trigger.focus();
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ),
        );
        const current = buttons.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        buttons[
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  buttons.length) %
                buttons.length
        ]?.focus();
      }}
    >
      {item("Close", "close")}
      {item("Close Other Tabs", "others")}
      {item("Close Tabs to the Right", "right")}
      {item("Close All", "all")}
      <div className="context-separator" role="separator" />
      {item("Move Tab to New Window", "move")}
      <div className="context-separator" role="separator" />
      {item(
        favorite ? "Remove from Favorites" : "Add to Favorites",
        "favorite",
      )}
      {item("Reveal in Navigation Pane", "reveal")}
    </div>
  );
}
