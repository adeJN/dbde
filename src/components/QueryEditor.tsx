import { useEffect, useRef } from "react";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController";
import "monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard";
import "monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2";
import "monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { Driver, TableInfo } from "../types";
import * as api from "../lib/api";
import { createColumnCache } from "../lib/column-cache";
import { completionIdentifier } from "../lib/sql";
import { useTheme } from "../hooks/useTheme";
import { softEditorTheme, systemDarkEditorTheme } from "../lib/editor-theme";
import { openEditorSearch } from "../lib/editor-search";
import { isMacPlatform } from "../lib/table-shortcuts";
import { expandSnippet, type Snippet } from "../lib/snippets";
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
monaco.editor.defineTheme("dbde-light", softEditorTheme);
monaco.editor.defineTheme("dbde-dark", systemDarkEditorTheme);
// A refreshed schema snapshot invalidates completion metadata automatically.
const cachedColumns = createColumnCache(api.columns);
const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export default function QueryEditor({
  id,
  value,
  onChange,
  onRun,
  tables,
  connectionId,
  database,
  driver,
  editorRef,
  snippets = [],
  onSave,
  onSaveAs,
  onExplain,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onRun: (selection?: string) => void;
  tables: TableInfo[];
  connectionId: string;
  database?: string;
  driver: Driver;
  editorRef: React.MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>;
  /** Snippets for this driver, offered by prefix with placeholders. */
  snippets?: Snippet[];
  /** Ctrl/Cmd+S while the editor has focus (the grid keeps its own Ctrl/Cmd+S). */
  onSave?: () => void;
  onSaveAs?: () => void;
  /** Ctrl/Cmd+Shift+E: explain the selection or the statement under the cursor. */
  onExplain?: () => void;
}) {
  const { theme } = useTheme();
  const run = useRef(onRun);
  run.current = onRun;
  const explain = useRef(onExplain);
  explain.current = onExplain;
  const save = useRef({ onSave, onSaveAs });
  save.current = { onSave, onSaveAs };
  useEffect(() => {
    const provider = monaco.languages.registerCompletionItemProvider("sql", {
      provideCompletionItems: async (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        // Offer columns of the tables this query mentions, loaded on demand.
        const text = model.getValue();
        const mentioned = tables
          .filter((t) =>
            new RegExp(`(^|[^\\w])${escapeRegExp(t.name)}($|[^\\w])`, "i").test(
              text,
            ),
          )
          .slice(0, 8);
        const columns = (
          await Promise.all(
            mentioned.map((t) =>
              cachedColumns(tables, connectionId, database, t)
                .then((list) => list.map((column) => ({ table: t, column })))
                .catch(() => []),
            ),
          )
        ).flat();
        return {
          suggestions: [
            ...tables.map((t) => ({
              label: t.name,
              kind: monaco.languages.CompletionItemKind.Struct,
              detail: t.kind,
              insertText: completionIdentifier(t.name, driver),
              range,
            })),
            ...columns.map(({ table, column }) => ({
              label: column.name,
              kind: monaco.languages.CompletionItemKind.Field,
              detail: `${table.name} · ${column.data_type}`,
              insertText: completionIdentifier(column.name, driver),
              range,
            })),
            ...snippets.map((snippet) => ({
              label: snippet.prefix,
              kind: monaco.languages.CompletionItemKind.Snippet,
              detail: snippet.name,
              documentation: expandSnippet(snippet.body),
              insertText: snippet.body,
              insertTextRules:
                monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
              range,
            })),
            ...[
              "SELECT",
              "FROM",
              "WHERE",
              "ORDER BY",
              "GROUP BY",
              "LIMIT",
              "JOIN",
              "INSERT INTO",
              "UPDATE",
              "DELETE FROM",
            ].map((label) => ({
              label,
              kind: monaco.languages.CompletionItemKind.Keyword,
              insertText: label,
              range,
            })),
          ],
        };
      },
    });
    return () => provider.dispose();
  }, [tables, connectionId, database, driver, snippets]);
  const mount: OnMount = (editor) => {
    editorRef.current = editor;
    for (const action of ["find", "replace"] as const) {
      editor.addAction({
        id: `dbde-${action}`,
        label: action === "find" ? "Find in SQL" : "Find and replace in SQL",
        contextMenuGroupId: "1_search",
        contextMenuOrder: action === "find" ? 1 : 2,
        keybindingContext: "editorTextFocus",
        keybindings: [
          action === "find"
            ? monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF
            : isMacPlatform()
              ? monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyF
              : monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyH,
        ],
        run: (instance) => openEditorSearch(instance, action),
      });
    }
    editor.addAction({
      id: "dbde-save-query",
      label: "Save query",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1,
      keybindingContext: "editorTextFocus",
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => save.current.onSave?.(),
    });
    editor.addAction({
      id: "dbde-save-query-as",
      label: "Save query as…",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 2,
      keybindingContext: "editorTextFocus",
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS,
      ],
      run: () => save.current.onSaveAs?.(),
    });
    editor.addAction({
      id: "dbde-explain-query",
      label: "Explain statement",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0.5,
      keybindingContext: "editorTextFocus",
      keybindings: [
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE,
      ],
      run: () => explain.current?.(),
    });
    editor.addAction({
      id: "dbde-run-query",
      label: "Run query or selected SQL",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: (ed) => {
        const selection = ed.getSelection();
        run.current(
          selection ? ed.getModel()?.getValueInRange(selection) : undefined,
        );
      },
    });
  };
  return (
    <Editor
      path={`${id}.sql`}
      language="sql"
      theme={theme === "light" ? "dbde-light" : "dbde-dark"}
      value={value}
      onChange={(v) => onChange(v ?? "")}
      onMount={mount}
      options={{
        contextmenu: true,
        fontSize: 13,
        fontFamily: '"SFMono-Regular", Consolas, monospace',
        minimap: { enabled: false },
        padding: { top: 22, bottom: 16 },
        lineNumbersMinChars: 4,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        renderLineHighlight: "none",
        wordWrap: "on",
        overviewRulerLanes: 0,
        tabSize: 2,
      }}
      loading={<div className="empty-inline">Loading local editor…</div>}
    />
  );
}
