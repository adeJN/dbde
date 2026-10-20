import { ChevronDown, Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "../hooks/useTheme";
import type { ThemePreference } from "../lib/theme";

export default function ThemeToggle() {
  const { theme, preference, setPreference } = useTheme();
  return (
    <label
      className="theme-selector"
      title={
        preference === "system"
          ? `Follow system appearance (currently ${theme})`
          : `${theme === "light" ? "Light" : "Dark"} appearance`
      }
    >
      {preference === "system" ? (
        <Monitor size={15} aria-hidden="true" />
      ) : preference === "light" ? (
        <Sun size={15} aria-hidden="true" />
      ) : (
        <Moon size={15} aria-hidden="true" />
      )}
      <select
        aria-label="Appearance mode"
        value={preference}
        onChange={(event) =>
          setPreference(event.target.value as ThemePreference)
        }
      >
        <option value="system">System (Auto)</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
      <ChevronDown
        size={11}
        className="theme-selector-chevron"
        aria-hidden="true"
      />
    </label>
  );
}
