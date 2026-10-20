// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController";
import { openEditorSearch } from "./editor-search";

afterEach(() => vi.restoreAllMocks());
it("opens real Monaco find and replace widgets", async () => {
  window.matchMedia = vi.fn(() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    beginPath() {},
    rect() {},
    fill() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    measureText: () => ({ width: 8 }),
    clearRect() {},
    fillRect() {},
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
  } as unknown as CanvasRenderingContext2D);
  document.queryCommandSupported = () => false;
  const node = document.createElement("div");
  document.body.append(node);
  const instance = monaco.editor.create(node, {
    value: "SELECT name FROM users",
    minimap: { enabled: false },
    overviewRulerLanes: 0,
    dimension: { width: 800, height: 200 },
  });
  try {
    await openEditorSearch(instance, "find");
    await waitFor(() =>
      expect(node.querySelector(".find-widget.visible")).toBeTruthy(),
    );
    await openEditorSearch(instance, "replace");
    await waitFor(() =>
      expect(
        node.querySelector(".find-widget.visible.replaceToggled"),
      ).toBeTruthy(),
    );
  } finally {
    instance.dispose();
    node.remove();
  }
});
