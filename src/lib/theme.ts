export type Theme = "dark" | "light";
export type ThemePreference = Theme | "system";
export const THEME_KEY = "dbde.theme";
const CHANGE = "dbde:theme-change";
const SYSTEM_QUERY = "(prefers-color-scheme: dark)";

function preference(value: string | null | undefined): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}
function storedPreference(): ThemePreference {
  try {
    return preference(window.localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}
function systemMedia() {
  try {
    return window.matchMedia?.(SYSTEM_QUERY);
  } catch {
    return undefined;
  }
}
function systemTheme(): Theme {
  return systemMedia()?.matches === false ? "light" : "dark";
}
function applyPreference(choice: ThemePreference) {
  const theme = choice === "system" ? systemTheme() : choice;
  document.documentElement.dataset.themePreference = choice;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "light" ? "#efeee7" : "#12151b");
}
export function initializeTheme() {
  applyPreference(storedPreference());
}
export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}
export function currentThemePreference(): ThemePreference {
  return document.documentElement.dataset.themePreference === undefined
    ? storedPreference()
    : preference(document.documentElement.dataset.themePreference);
}
/** A stable primitive snapshot tracks both the chosen mode and its resolved theme. */
export function themeSnapshot() {
  return `${currentThemePreference()}:${currentTheme()}`;
}
export function setTheme(choice: ThemePreference) {
  applyPreference(choice);
  try {
    window.localStorage.setItem(THEME_KEY, choice);
  } catch {
    /* Keep the choice for this window when storage is unavailable. */
  }
  window.dispatchEvent(new Event(CHANGE));
}
export function subscribeTheme(listener: () => void) {
  // The OS may have changed while a detached workspace was loading.
  applyPreference(currentThemePreference());
  const media = systemMedia();
  function systemChanged() {
    if (currentThemePreference() !== "system") return;
    applyPreference("system");
    listener();
  }
  function sync(event: StorageEvent) {
    if (event.key !== THEME_KEY && event.key !== null) return;
    applyPreference(event.key === null ? "system" : preference(event.newValue));
    listener();
  }
  window.addEventListener(CHANGE, listener);
  window.addEventListener("storage", sync);
  if (media?.addEventListener) media.addEventListener("change", systemChanged);
  else media?.addListener?.(systemChanged);
  return () => {
    window.removeEventListener(CHANGE, listener);
    window.removeEventListener("storage", sync);
    if (media?.removeEventListener)
      media.removeEventListener("change", systemChanged);
    else media?.removeListener?.(systemChanged);
  };
}
