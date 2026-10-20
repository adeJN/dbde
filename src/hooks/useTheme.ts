import { useSyncExternalStore } from "react";
import {
  setTheme,
  subscribeTheme,
  themeSnapshot,
  type Theme,
  type ThemePreference,
} from "../lib/theme";

export function useTheme() {
  const snapshot = useSyncExternalStore(
    subscribeTheme,
    themeSnapshot,
    () => "system:dark",
  );
  const [preference, theme] = snapshot.split(":") as [ThemePreference, Theme];
  return { theme, preference, setPreference: setTheme };
}
