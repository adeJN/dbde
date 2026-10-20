import { Fragment, useLayoutEffect, useRef, useState } from "react";
export interface AreaMenuItem {
  label: string;
  action: () => void;
  disabled?: boolean;
  /** Keyboard hint shown at the end of the item. */
  shortcut?: string;
  /** Why the item is disabled, or extra detail. */
  title?: string;
  /** Draws a separator above the item. */
  separatorBefore?: boolean;
}
export interface AreaMenu {
  x: number;
  y: number;
  trigger: HTMLElement;
  label: string;
  items: AreaMenuItem[];
}
export default function AreaContextMenu({
  menu,
  onClose,
}: {
  menu: AreaMenu;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: menu.x, top: menu.y });
  const close = useRef(onClose);
  close.current = onClose;
  useLayoutEffect(() => {
    const node = ref.current!;
    const box = node.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(menu.x, innerWidth - box.width - 8)),
      top: Math.max(8, Math.min(menu.y, innerHeight - box.height - 8)),
    });
    node.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: Event) => {
      if (!node.contains(event.target as Node)) close.current();
    };
    const dismiss = () => close.current();
    document.addEventListener("mousedown", outside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", outside, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", outside, true);
    };
  }, [menu]);
  function dismiss() {
    close.current();
    if (menu.trigger.isConnected) menu.trigger.focus();
  }
  return (
    <div
      ref={ref}
      className="grid-context-menu area-context-menu"
      role="menu"
      aria-label={menu.label}
      style={position}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" || event.key === "Tab") {
          event.preventDefault();
          dismiss();
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
        if (!items.length) return;
        const current = items.indexOf(
          document.activeElement as HTMLButtonElement,
        );
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (current +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  items.length) %
                items.length;
        items[next].focus();
      }}
    >
      {menu.items.map((item) => (
        <Fragment key={item.label}>
          {item.separatorBefore && (
            <div className="context-separator" role="separator" />
          )}
          <button
            role="menuitem"
            disabled={item.disabled}
            title={item.title}
            onClick={() => {
              dismiss();
              item.action();
            }}
          >
            {item.shortcut ? (
              <>
                <span>{item.label}</span>
                <kbd>{item.shortcut}</kbd>
              </>
            ) : (
              item.label
            )}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
