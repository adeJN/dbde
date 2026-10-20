import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH } from "../lib/column-widths";

type Widths = Record<string, number>;
const clamp = (width: number) =>
  Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(width)));
function read(key: string): Widths {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([, width]) => typeof width === "number" && Number.isFinite(width),
        )
        .map(([name, width]) => [name, clamp(width as number)]),
    );
  } catch {
    return {};
  }
}
function save(key: string, widths: Widths) {
  try {
    window.localStorage.setItem(key, JSON.stringify(widths));
  } catch {
    /* Resizing remains available when storage is full. */
  }
}
export default function useColumnResize(key: string, automatic: number[]) {
  const loaded = useMemo(() => read(key), [key]);
  const [custom, setCustom] = useState<{ key: string; values: Widths }>({
    key,
    values: loaded,
  });
  const values = custom.key === key ? custom.values : loaded;
  const widths = automatic.map((width, index) => values[index] ?? width);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{
    key: string;
    index: number;
    x: number;
    width: number;
    values: Widths;
  } | null>(null);
  useEffect(() => {
    setResizing(false);
    function move(event: globalThis.PointerEvent) {
      const current = drag.current;
      if (!current) return;
      current.values = {
        ...current.values,
        [current.index]: clamp(current.width + event.clientX - current.x),
      };
      setCustom({ key: current.key, values: current.values });
    }
    function finish() {
      if (drag.current) save(drag.current.key, drag.current.values);
      drag.current = null;
      setResizing(false);
    }
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
    return () => {
      if (drag.current) save(drag.current.key, drag.current.values);
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
    };
  }, [key]);
  function begin(event: PointerEvent<HTMLElement>, index: number) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    drag.current = {
      key,
      index,
      x: event.clientX,
      width: widths[index],
      values,
    };
    setResizing(true);
  }
  function change(index: number, width?: number) {
    const next = { ...values };
    if (width === undefined) delete next[index];
    else next[index] = clamp(width);
    setCustom({ key, values: next });
    save(key, next);
  }
  return { widths, resizing, begin, change };
}
