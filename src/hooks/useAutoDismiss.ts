import { useEffect, useRef, useState, type FocusEvent } from "react";

/** Transient feedback stays visible while the user hovers or focuses it. */
export function useAutoDismiss(
  value: unknown,
  dismiss: () => void,
  enabled = true,
) {
  const latestDismiss = useRef(dismiss);
  latestDismiss.current = dismiss;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!value || !enabled) {
      setHovered(false);
      setFocused(false);
    }
  }, [value, enabled]);
  useEffect(() => {
    if (!value || !enabled || hovered || focused) return;
    const timer = window.setTimeout(() => latestDismiss.current(), 5000);
    return () => window.clearTimeout(timer);
  }, [value, enabled, hovered, focused]);
  return {
    onMouseEnter: () => setHovered(true),
    onMouseLeave: () => setHovered(false),
    onFocusCapture: () => setFocused(true),
    onBlurCapture: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null))
        setFocused(false);
    },
  };
}
