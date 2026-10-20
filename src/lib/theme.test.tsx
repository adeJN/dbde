// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  act,
} from "@testing-library/react";
import ThemeToggle from "../components/ThemeToggle";
import {
  THEME_KEY,
  currentTheme,
  currentThemePreference,
  initializeTheme,
  setTheme,
} from "./theme";

let saved: Map<string, string>;
let darkSystem: boolean;
let changes: EventTarget;
beforeEach(() => {
  saved = new Map();
  darkSystem = false;
  changes = new EventTarget();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return darkSystem;
      },
      addEventListener: changes.addEventListener.bind(changes),
      removeEventListener: changes.removeEventListener.bind(changes),
    })),
  );
  document.head.innerHTML = '<meta name="theme-color" content="#12151b">';
  initializeTheme();
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-preference");
  document.documentElement.style.removeProperty("color-scheme");
  vi.unstubAllGlobals();
});
function systemAppearance(dark: boolean) {
  darkSystem = dark;
  act(() => changes.dispatchEvent(new Event("change")));
}

it("loads an existing manual light preference before the app renders", () => {
  saved.set(THEME_KEY, "light");
  darkSystem = true;
  initializeTheme();
  expect(currentTheme()).toBe("light");
  expect(currentThemePreference()).toBe("light");
  expect(document.documentElement.style.colorScheme).toBe("light");
  expect(
    document.querySelector('meta[name="theme-color"]')?.getAttribute("content"),
  ).toBe("#efeee7");
});
it("defaults to the system and immediately follows OS changes without saving a resolved color", () => {
  render(<ThemeToggle />);
  const select = screen.getByRole("combobox", {
    name: "Appearance mode",
  }) as HTMLSelectElement;
  expect(select.value).toBe("system");
  expect(currentTheme()).toBe("light");
  systemAppearance(true);
  expect(currentTheme()).toBe("dark");
  expect(select.value).toBe("system");
  expect(saved.has(THEME_KEY)).toBe(false);
  systemAppearance(false);
  expect(currentTheme()).toBe("light");
});
it("shares the selected preference with all subscribers and keeps manual choices when the OS changes", () => {
  render(
    <>
      <ThemeToggle />
      <ThemeToggle />
    </>,
  );
  const selects = screen.getAllByRole("combobox", {
    name: "Appearance mode",
  }) as HTMLSelectElement[];
  fireEvent.change(selects[0], { target: { value: "dark" } });
  expect(saved.get(THEME_KEY)).toBe("dark");
  expect(selects[1].value).toBe("dark");
  systemAppearance(false);
  expect(currentTheme()).toBe("dark");
  fireEvent.change(selects[1], { target: { value: "light" } });
  systemAppearance(true);
  expect(currentTheme()).toBe("light");
  fireEvent.change(selects[0], { target: { value: "system" } });
  expect(currentTheme()).toBe("dark");
  expect(selects[1].value).toBe("system");
  expect(saved.get(THEME_KEY)).toBe("system");
});
it("updates the selected mode even when the resolved theme stays the same", () => {
  render(<ThemeToggle />);
  const select = screen.getByRole("combobox", {
    name: "Appearance mode",
  }) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: "light" } });
  expect(currentTheme()).toBe("light");
  fireEvent.change(select, { target: { value: "system" } });
  expect(select.value).toBe("system");
  expect(currentTheme()).toBe("light");
});
it("syncs automatic mode from another window and returns to system when the preference is cleared", () => {
  render(<ThemeToggle />);
  act(() => setTheme("dark"));
  act(() =>
    window.dispatchEvent(
      new StorageEvent("storage", { key: THEME_KEY, newValue: "system" }),
    ),
  );
  expect(currentTheme()).toBe("light");
  expect(currentThemePreference()).toBe("system");
  // Processing a remote update must not echo a new write back to storage.
  expect(saved.get(THEME_KEY)).toBe("dark");
  act(() => setTheme("dark"));
  act(() => window.dispatchEvent(new StorageEvent("storage", { key: null })));
  expect(currentThemePreference()).toBe("system");
  expect(currentTheme()).toBe("light");
});
it("remembers a system preference across initialization", () => {
  setTheme("system");
  darkSystem = true;
  initializeTheme();
  expect(currentThemePreference()).toBe("system");
  expect(currentTheme()).toBe("dark");
});
it("still follows the OS and accepts manual selection when storage is unavailable", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("full");
    },
  });
  initializeTheme();
  render(<ThemeToggle />);
  expect(currentTheme()).toBe("light");
  systemAppearance(true);
  expect(currentTheme()).toBe("dark");
  act(() => setTheme("light"));
  systemAppearance(true);
  expect(currentTheme()).toBe("light");
});
it("falls back to dark if system appearance cannot be detected", () => {
  vi.stubGlobal("matchMedia", undefined);
  initializeTheme();
  expect(currentThemePreference()).toBe("system");
  expect(currentTheme()).toBe("dark");
});
it("removes OS listeners when the selector is unmounted", () => {
  const view = render(<ThemeToggle />);
  view.unmount();
  systemAppearance(true);
  expect(currentTheme()).toBe("light");
});
