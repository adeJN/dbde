import {
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

interface Drop {
  id: string;
  target: string;
  after: boolean;
}
interface Gesture {
  id: string;
  pointerId: number;
  x: number;
  y: number;
  lastX: number;
  lastY: number;
  started: boolean;
}

export default function useTabDrag(
  reorder: (id: string, target: string, after: boolean) => void,
  activate: (id: string) => void,
) {
  const strip = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const callbacks = useRef({ reorder, activate });
  callbacks.current = { reorder, activate };
  const suppressClick = useRef(false);
  const resetClick = useRef<ReturnType<typeof setTimeout>>();
  const [drop, setDrop] = useState<Drop | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);

  useEffect(() => {
    let frame = 0;
    let preview: HTMLElement | null = null;
    let grabOffset = 0;
    let previewWidth = 0;
    function lift() {
      const active = gesture.current;
      const source = Array.from(
        strip.current?.querySelectorAll<HTMLElement>("[data-tab-id]") ?? [],
      ).find((tab) => tab.dataset.tabId === active?.id);
      if (!source || !active) return;
      const rect = source.getBoundingClientRect();
      preview = source.cloneNode(true) as HTMLElement;
      preview.classList.add("tab-drag-preview");
      preview.removeAttribute("data-tab-id");
      preview.removeAttribute("data-dragging");
      preview.removeAttribute("data-drop");
      preview.setAttribute("aria-hidden", "true");
      preview.inert = true;
      previewWidth = Math.min(rect.width, 360, window.innerWidth - 16);
      grabOffset = Math.min(active.x - rect.left, previewWidth - 16);
      preview.style.width = `${previewWidth}px`;
      document.body.append(preview);
      setDraggedId(active.id);
    }
    function positionPreview() {
      const active = gesture.current;
      if (!preview || !active) return;
      const x = Math.max(
        8,
        Math.min(
          active.lastX - grabOffset,
          window.innerWidth - previewWidth - 8,
        ),
      );
      const y = Math.max(
        8,
        Math.min(active.lastY + 14, window.innerHeight - 44),
      );
      preview.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
    function target(x: number, y: number): Drop | null {
      const root = strip.current;
      const active = gesture.current;
      if (!root || !active) return null;
      const box = root.getBoundingClientRect();
      if (x < box.left || x > box.right || y < box.top || y > box.bottom)
        return null;
      const tabs = Array.from(
        root.querySelectorAll<HTMLElement>("[data-tab-id]"),
      );
      const tab =
        tabs.find((tab) => x < tab.getBoundingClientRect().right) ??
        tabs.at(-1);
      if (!tab) return null;
      const rect = tab.getBoundingClientRect();
      return {
        id: active.id,
        target: tab.dataset.tabId!,
        after: x > rect.left + rect.width / 2,
      };
    }
    function update() {
      const active = gesture.current;
      if (!active?.started) return;
      positionPreview();
      const next = target(active.lastX, active.lastY);
      setDrop((old) =>
        old?.id === next?.id &&
        old?.target === next?.target &&
        old?.after === next?.after
          ? old
          : next,
      );
    }
    function tick() {
      const active = gesture.current;
      const root = strip.current;
      if (!active?.started || !root) return;
      const rect = root.getBoundingClientRect();
      if (active.lastY >= rect.top && active.lastY <= rect.bottom) {
        const direction =
          active.lastX < rect.left + 32
            ? -1
            : active.lastX > rect.right - 32
              ? 1
              : 0;
        if (direction) root.scrollLeft += direction * 12;
      }
      update();
      frame = requestAnimationFrame(tick);
    }
    function move(event: PointerEvent) {
      const active = gesture.current;
      if (!active || event.pointerId !== active.pointerId) return;
      active.lastX = event.clientX;
      active.lastY = event.clientY;
      if (
        !active.started &&
        Math.hypot(event.clientX - active.x, event.clientY - active.y) >= 5
      ) {
        active.started = true;
        lift();
        document.body.classList.add("tab-dragging");
        frame = requestAnimationFrame(tick);
      }
      if (active.started) {
        event.preventDefault();
        update();
      }
    }
    function stop() {
      gesture.current = null;
      cancelAnimationFrame(frame);
      document.body.classList.remove("tab-dragging");
      preview?.remove();
      preview = null;
      setDraggedId(null);
      setDrop(null);
    }
    function end(event: PointerEvent) {
      const active = gesture.current;
      if (!active || event.pointerId !== active.pointerId) return;
      if (active.started) {
        const next = target(event.clientX, event.clientY);
        suppressClick.current = true;
        resetClick.current = setTimeout(() => {
          suppressClick.current = false;
        }, 0);
        if (next && next.id !== next.target) {
          callbacks.current.reorder(next.id, next.target, next.after);
          callbacks.current.activate(next.id);
        }
      }
      stop();
    }
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === gesture.current?.pointerId) stop();
    };
    const wheel = (event: WheelEvent) => {
      const root = strip.current;
      if (
        !root ||
        !root.contains(event.target as Node) ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      const maximum = root.scrollWidth - root.clientWidth;
      if (maximum <= 0) return;
      const delta =
        Math.abs(event.deltaX) > Math.abs(event.deltaY)
          ? event.deltaX
          : event.deltaY;
      const unit =
        event.deltaMode === 1
          ? 16
          : event.deltaMode === 2
            ? root.clientWidth
            : 1;
      const next = Math.max(
        0,
        Math.min(maximum, root.scrollLeft + delta * unit),
      );
      if (next === root.scrollLeft) return;
      event.preventDefault();
      root.scrollLeft = next;
    };
    window.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("wheel", wheel);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", stop);
      cancelAnimationFrame(frame);
      clearTimeout(resetClick.current);
      document.body.classList.remove("tab-dragging");
      preview?.remove();
    };
  }, []);

  return {
    strip,
    drop,
    draggedId,
    begin(event: ReactPointerEvent<HTMLElement>, id: string) {
      if (
        event.button !== 0 ||
        (event.target as HTMLElement).closest(".tab-close")
      )
        return;
      gesture.current = {
        id,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        started: false,
      };
    },
    click(event: MouseEvent) {
      if (suppressClick.current) {
        event.preventDefault();
        event.stopPropagation();
        suppressClick.current = false;
      }
    },
  };
}
