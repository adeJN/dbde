export interface EditorPreferences {
  fontSize: number;
  tabSize: number;
  wordWrap: boolean;
  minimap: boolean;
  lineNumbers: boolean;
}
export const defaultEditorPreferences: EditorPreferences = {
  fontSize: 13,
  tabSize: 2,
  wordWrap: true,
  minimap: false,
  lineNumbers: true,
};
const key = "dbde.editor.preferences.v1";
export function readEditorPreferences(): EditorPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!saved || typeof saved !== "object")
      return { ...defaultEditorPreferences };
    return {
      fontSize: [11, 12, 13, 14, 16, 18].includes(saved.fontSize)
        ? saved.fontSize
        : 13,
      tabSize: [2, 4].includes(saved.tabSize) ? saved.tabSize : 2,
      wordWrap: typeof saved.wordWrap === "boolean" ? saved.wordWrap : true,
      minimap: typeof saved.minimap === "boolean" ? saved.minimap : false,
      lineNumbers:
        typeof saved.lineNumbers === "boolean" ? saved.lineNumbers : true,
    };
  } catch {
    return { ...defaultEditorPreferences };
  }
}
export function saveEditorPreferences(preferences: EditorPreferences) {
  try {
    localStorage.setItem(key, JSON.stringify(preferences));
  } catch {
    /* Session preferences still work if local storage is unavailable. */
  }
}
