import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { softEditorTheme, systemDarkEditorTheme } from "./editor-theme";
const palette = readFileSync(new URL("../theme.css", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const values = Object.fromEntries(
  [...palette.matchAll(/(--[\w-]+):\s*(#[\da-f]{6,8});/gi)].map((match) => [
    match[1],
    match[2],
  ]),
);
function luminance(hex: string) {
  const rgb = [1, 3, 5]
    .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
function contrast(a: string, b: string) {
  const [dark, light] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (light + 0.05) / (dark + 0.05);
}
it("defines a light counterpart for every theme token used by application surfaces", () => {
  const used = new Set(
    [...css.matchAll(/var\((--theme-[\w-]+)/g)].map((match) => match[1]),
  );
  for (const name of used) expect(values[name], name).toBeTruthy();
});
it("keeps normal and muted text readable on the warm paper surfaces", () => {
  for (const text of [
    "--theme-text",
    "--theme-text-secondary",
    "--theme-text-muted",
  ])
    for (const surface of [
      "--theme-surface-canvas",
      "--theme-surface-panel",
      "--theme-surface-raised",
      "--theme-surface-hover",
    ])
      expect(
        contrast(values[text], values[surface]),
        `${text} on ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
  for (const state of ["accent", "success", "danger", "info"])
    expect(
      contrast(
        values[`--theme-${state}-text`],
        values[`--theme-${state}-background`],
      ),
      state,
    ).toBeGreaterThanOrEqual(4.5);
  expect(
    contrast(values["--theme-accent-border"], values["--theme-surface-canvas"]),
  ).toBeGreaterThanOrEqual(3);
});
it("uses the same paper background for SQL and leaves dark colors as CSS fallbacks", () => {
  expect(softEditorTheme.base).toBe("vs");
  expect(softEditorTheme.colors["editor.background"].toLowerCase()).toBe(
    values["--theme-surface-canvas"],
  );
  expect(css).toContain("var(--theme-surface-canvas, #111318)");
  expect(palette).toContain(':root[data-theme="light"]');
});

it("uses the requested neutral dark backgrounds with readable text and matching SQL editor", () => {
  const darkBlock = palette.match(
    /:root\[data-theme="dark"\]\s*\{([^}]+)\}/,
  )![1];
  const dark = Object.fromEntries(
    [...darkBlock.matchAll(/(--[\w-]+):\s*(#[\da-f]{6,8});/gi)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  expect(dark["--theme-surface-canvas"]).toBe("#1f1f22");
  expect(dark["--theme-surface-panel"]).toBe("#2b2c2d");
  for (const token of Object.keys(values))
    expect(dark[token], token).toBeTruthy();
  for (const text of [
    "--theme-text",
    "--theme-text-secondary",
    "--theme-text-muted",
  ])
    for (const surface of [
      "--theme-surface-canvas",
      "--theme-surface-panel",
      "--theme-surface-raised",
      "--theme-surface-hover",
    ])
      expect(
        contrast(dark[text], dark[surface]),
        `${text} on ${surface}`,
      ).toBeGreaterThanOrEqual(4.5);
  for (const state of ["accent", "success", "danger", "info"])
    expect(
      contrast(
        dark[`--theme-${state}-text`],
        dark[`--theme-${state}-background`],
      ),
      state,
    ).toBeGreaterThanOrEqual(4.5);
  for (const surface of [
    "--theme-find-background",
    "--theme-find-current-background",
  ])
    expect(
      contrast(dark["--theme-text"], dark[surface]),
      surface,
    ).toBeGreaterThanOrEqual(4.5);
  expect(systemDarkEditorTheme.base).toBe("vs-dark");
  expect(systemDarkEditorTheme.colors["editor.background"].toLowerCase()).toBe(
    dark["--theme-surface-canvas"],
  );
});
