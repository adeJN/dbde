import { useEffect, useRef, useState, type ReactNode } from "react";

const storageKey = "dbde.sidebar-width";
const defaultWidth = 224;
function bounds(viewport: number) {
  const max = Math.max(
    120,
    Math.min(560, viewport <= 520 ? viewport * 0.8 : viewport - 360),
  );
  return { min: Math.min(180, max), max: Math.floor(max) };
}
function clamp(value: number, min: number, max: number) {
  return Math.round(Math.max(min, Math.min(max, value)));
}

export default function ResizableSidebar({
  children,
}: {
  children: ReactNode;
}) {
  const sidebar = useRef<HTMLElement>(null);
  const [viewport, setViewport] = useState(window.innerWidth);
  const [preferredWidth, setPreferredWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(saved) && saved >= 120 && saved <= 560) return saved;
    } catch {
      /* Storage may be unavailable. */
    }
    return window.innerWidth <= 768
      ? 180
      : window.innerWidth <= 1024
        ? 205
        : defaultWidth;
  });
  const [drag, setDrag] = useState<{
    pointerId: number;
    startX: number;
    width: number;
  } | null>(null);
  const { min, max } = bounds(viewport);
  const width = clamp(preferredWidth, min, max);

  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, String(preferredWidth));
    } catch {
      /* Keep resizing available without storage. */
    }
  }, [preferredWidth]);
  useEffect(() => {
    if (!drag) return;
    const oldCursor = document.body.style.cursor;
    const oldSelection = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (event: PointerEvent) => {
      if (event.pointerId !== drag.pointerId) return;
      const limits = bounds(window.innerWidth);
      setPreferredWidth(
        clamp(drag.width + event.clientX - drag.startX, limits.min, limits.max),
      );
    };
    const stop = () => setDrag(null);
    const end = (event: PointerEvent) => {
      if (event.pointerId === drag.pointerId) stop();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", stop);
      document.body.style.cursor = oldCursor;
      document.body.style.userSelect = oldSelection;
    };
  }, [drag]);

  return (
    <aside
      ref={sidebar}
      id="explorer-sidebar"
      className="sidebar"
      style={{ width }}
    >
      {children}
      <div
        className={`sidebar-resizer${drag ? " is-resizing" : ""}`}
        role="separator"
        tabIndex={0}
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-controls="explorer-sidebar"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={width}
        aria-valuetext={`${width} pixels`}
        title="Drag to resize sidebar · Double-click to reset"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture?.(event.pointerId);
          setDrag({
            pointerId: event.pointerId,
            startX: event.clientX,
            width: sidebar.current?.getBoundingClientRect().width || width,
          });
        }}
        onLostPointerCapture={() => setDrag(null)}
        onDoubleClick={() => setPreferredWidth(clamp(defaultWidth, min, max))}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 40 : 10;
          const next =
            event.key === "ArrowLeft"
              ? width - step
              : event.key === "ArrowRight"
                ? width + step
                : event.key === "Home"
                  ? min
                  : event.key === "End"
                    ? max
                    : event.key === "Enter"
                      ? defaultWidth
                      : undefined;
          if (next === undefined) return;
          event.preventDefault();
          setPreferredWidth(clamp(next, min, max));
        }}
      />
    </aside>
  );
}
