import { useEffect, useRef, useState } from "react";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController";
import "monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard";
import "monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2";
import "monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu";
import "monaco-editor/esm/vs/editor/contrib/folding/browser/folding";
import "monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess";
import "monaco-editor/esm/vs/editor/contrib/comment/browser/comment";
import "monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations";
import "monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor";
import "monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching";
import { Play, Settings2, X, RotateCcw } from "lucide-react";
import {
  analyseSql,
  statementAt,
  currentSql,
  checkedSql,
  tableBindings,
  completionQualifier,
} from "../lib/sql-editor";
import {
  readEditorPreferences,
  saveEditorPreferences,
  defaultEditorPreferences,
} from "../lib/editor-preferences";
import { formatEditorSql } from "../lib/editor-format";
import "./QueryEditor.css";
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
  running = false,
  onError,
}: {
  id: string;
  running?: boolean;
  onError?: (message: string) => void;
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
  const [preferences, setPreferences] = useState(readEditorPreferences);
  const [settings, setSettings] = useState(false);
  const [analysis, setAnalysis] = useState(() => analyseSql(value, driver));
  const [cursor, setCursor] = useState({
    offset: 0,
    line: 1,
    column: 1,
    selected: 0,
  });
  const [checked, setChecked] = useState<number[]>([]);
  const checkedRef = useRef<{ source: string; indexes: number[] }>({
    source: value,
    indexes: [],
  });
  const [queryChoices, setQueryChoices] = useState(false);
  const toggleQueries = (indexes: number[]) => {
    const source = editorRef.current?.getModel()?.getValue() ?? value;
    const previous =
      checkedRef.current.source === source ? checkedRef.current.indexes : [];
    const remove = indexes.every((index) => previous.includes(index));
    const next = remove
      ? previous.filter((index) => !indexes.includes(index))
      : [...new Set([...previous, ...indexes])];
    checkedRef.current = { source, indexes: next };
    setChecked(next);
  };
  const glyphs = useRef<monaco.editor.IEditorDecorationsCollection>();
  const [mounted, setMounted] = useState(0);
  const disposables = useRef<monaco.IDisposable[]>([]);
  const owned = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decoration = useRef<monaco.editor.IEditorDecorationsCollection>();
  const optionsButton = useRef<HTMLButtonElement>(null);
  const settingsPanel = useRef<HTMLDivElement>(null);
  const props = useRef({ driver, running, onError });
  props.current = { driver, running, onError };
  const perform = useRef((scope: "current" | "script" | "checked") => {});
  perform.current = (scope) => {
    if (props.current.running) return;
    const instance = editorRef.current,
      model = instance?.getModel();
    if (!instance || !model) return;
    if (scope === "script") {
      if (model.getValue().trim()) run.current(model.getValue());
      return;
    }
    const selection = instance.getSelection();
    const selected =
      selection && !selection.isEmpty()
        ? model.getValueInRange(selection)
        : undefined;
    if (scope === "checked" && checkedRef.current.indexes.length) {
      const target = checkedSql(
        model.getValue(),
        props.current.driver,
        checkedRef.current.source,
        checkedRef.current.indexes,
      );
      if ("error" in target) props.current.onError?.(target.error);
      else run.current(target.sql);
      return;
    }
    const target = currentSql(
      model.getValue(),
      props.current.driver,
      model.getOffsetAt(instance.getPosition() ?? { lineNumber: 1, column: 1 }),
      selected,
    );
    if ("error" in target) props.current.onError?.(target.error);
    else run.current(target.sql);
  };
  useEffect(() => {
    const timer = window.setTimeout(
      () => setAnalysis(analyseSql(value, driver)),
      120,
    );
    return () => clearTimeout(timer);
  }, [value, driver]);
  useEffect(() => saveEditorPreferences(preferences), [preferences]);
  useEffect(() => {
    if (!settings) return;
    settingsPanel.current?.querySelector<HTMLSelectElement>("select")?.focus();
    const outside = (e: PointerEvent) => {
      if (
        !settingsPanel.current?.contains(e.target as Node) &&
        !optionsButton.current?.contains(e.target as Node)
      )
        setSettings(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [settings]);
  useEffect(() => {
    const instance = editorRef.current,
      model = instance?.getModel();
    if (!instance || !model) return;
    const active = !analysis.unsafe
      ? statementAt(analysis, cursor.offset)
      : undefined;
    const from = active ? model.getPositionAt(active.start) : undefined,
      to = active ? model.getPositionAt(active.end) : undefined;
    decoration.current?.set(
      from && to
        ? [
            {
              range: new monaco.Range(
                from.lineNumber,
                from.column,
                to.lineNumber,
                to.column,
              ),
              options: {
                className: "dbde-current-statement",
                isWholeLine: false,
                stickiness:
                  monaco.editor.TrackedRangeStickiness
                    .NeverGrowsWhenTypingAtEdges,
              },
            },
          ]
        : [],
    );
    glyphs.current?.set(
      analysis.unsafe || analysis.issues.length
        ? []
        : analysis.statements.map((statement, index) => {
            const start = model.getPositionAt(statement.start),
              end = model.getPositionAt(statement.end);
            return {
              range: new monaco.Range(
                start.lineNumber,
                start.column,
                end.lineNumber,
                end.column,
              ),
              options: {
                glyphMarginClassName: checked.includes(index)
                  ? "dbde-query-check is-checked"
                  : "dbde-query-check",
                glyphMarginHoverMessage: {
                  value:
                    "Select query for Run (queries sharing this line are selected together).",
                },
                className: checked.includes(index)
                  ? "dbde-checked-statement"
                  : undefined,
                stickiness:
                  monaco.editor.TrackedRangeStickiness
                    .NeverGrowsWhenTypingAtEdges,
              },
            };
          }),
    );
    monaco.editor.setModelMarkers(
      model,
      "dbde.sql.lexical",
      analysis.issues.slice(0, 30).map((issue) => {
        const at = model.getPositionAt(issue.offset);
        return {
          startLineNumber: at.lineNumber,
          startColumn: at.column,
          endLineNumber: at.lineNumber,
          endColumn: at.column + 1,
          message: issue.message,
          severity: monaco.MarkerSeverity.Warning,
        };
      }),
    );
  }, [analysis, cursor.offset, mounted, editorRef, checked]);
  useEffect(
    () => () => {
      for (const item of disposables.current) item.dispose();
      disposables.current = [];
      decoration.current?.clear();
      glyphs.current?.clear();
      const instance = owned.current;
      const model = instance?.getModel();
      if (model) monaco.editor.setModelMarkers(model, "dbde.sql.lexical", []);
      if (editorRef.current === instance) editorRef.current = null;
      owned.current = null;
    },
    [editorRef],
  );
  useEffect(() => {
    const provider = monaco.languages.registerCompletionItemProvider("sql", {
      triggerCharacters: ["."],
      provideCompletionItems: async (model, position, _context, token) => {
        if (
          owned.current !== editorRef.current ||
          model !== owned.current?.getModel()
        )
          return { suggestions: [] };
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        const text = model.getValue(),
          offset = model.getOffsetAt(position),
          version = model.getVersionId();
        const scan = analyseSql(text, driver);
        if (offset > 0 && scan.completionCode[offset - 1] !== text[offset - 1])
          return { suggestions: [] };
        const active = statementAt(scan, offset);
        const code = active
          ? scan.completionCode.slice(active.start, active.end)
          : scan.completionCode;
        const bindings = tableBindings(code, tables, driver);
        const qualifier = completionQualifier(
          scan.completionCode.slice(0, offset),
          driver,
        );
        const equal = (a: string, b: string) =>
          driver === "postgres" ? a === b : a.toLowerCase() === b.toLowerCase();
        const matched = qualifier
          ? bindings.filter(
              (b) =>
                equal(b.alias, qualifier) || equal(b.table.name, qualifier),
            )
          : bindings;
        const unique = [
          ...new Map(
            matched.map((b) => [
              JSON.stringify([b.table.schema, b.table.name, b.alias]),
              b,
            ]),
          ).values(),
        ].slice(0, 8);
        const columns = (
          await Promise.all(
            unique.map((b) =>
              cachedColumns(tables, connectionId, database, b.table)
                .then((list) => list.map((column) => ({ ...b, column })))
                .catch(() => []),
            ),
          )
        ).flat();
        if (
          token.isCancellationRequested ||
          model.isDisposed() ||
          model.getVersionId() !== version ||
          model !== editorRef.current?.getModel()
        )
          return { suggestions: [] };
        const tableOptions = qualifier
          ? tables.filter((t) => equal(t.schema, qualifier))
          : tables;
        return {
          suggestions: [
            ...tableOptions.map((t) => ({
              label: t.name,
              kind: monaco.languages.CompletionItemKind.Struct,
              detail: `${t.schema ? `${t.schema}.` : ""}${t.name} · ${t.kind}`,
              insertText:
                !qualifier &&
                tables.some(
                  (other) => other.name === t.name && other.schema !== t.schema,
                )
                  ? `${completionIdentifier(t.schema, driver)}.${completionIdentifier(t.name, driver)}`
                  : completionIdentifier(t.name, driver),
              range,
            })),
            ...columns.map(({ alias, table, column }) => ({
              label:
                !qualifier && unique.length > 1
                  ? `${alias}.${column.name}`
                  : column.name,
              filterText: column.name,
              kind: monaco.languages.CompletionItemKind.Field,
              detail: `${table.schema ? table.schema + "." : ""}${table.name} · ${column.data_type}${column.nullable ? "" : " · NOT NULL"}`,
              insertText:
                !qualifier && unique.length > 1
                  ? `${completionIdentifier(alias, driver)}.${completionIdentifier(column.name, driver)}`
                  : completionIdentifier(column.name, driver),
              range,
            })),
            ...(!qualifier
              ? snippets.map((snippet) => ({
                  label: snippet.prefix,
                  kind: monaco.languages.CompletionItemKind.Snippet,
                  detail: snippet.name,
                  documentation: expandSnippet(snippet.body),
                  insertText: snippet.body,
                  insertTextRules:
                    monaco.languages.CompletionItemInsertTextRule
                      .InsertAsSnippet,
                  range,
                }))
              : []),
            ...(!qualifier
              ? [
                  "SELECT",
                  "FROM",
                  "WHERE",
                  "ORDER BY",
                  "GROUP BY",
                  "HAVING",
                  "LIMIT",
                  "OFFSET",
                  "JOIN",
                  "LEFT JOIN",
                  "INNER JOIN",
                  "INSERT INTO",
                  "UPDATE",
                  "DELETE FROM",
                  "WITH",
                  "UNION ALL",
                  "DISTINCT",
                  "RETURNING",
                  "CASE",
                  "COALESCE",
                  "COUNT",
                  "SUM",
                  "AVG",
                  "IS NULL",
                  "EXISTS",
                ].map((label) => ({
                  label,
                  kind: monaco.languages.CompletionItemKind.Keyword,
                  insertText: label,
                  range,
                }))
              : []),
          ],
        };
      },
    });
    return () => provider.dispose();
  }, [tables, connectionId, database, driver, snippets, editorRef]);
  const mount: OnMount = (editor) => {
    editorRef.current = editor;
    owned.current = editor;
    decoration.current = editor.createDecorationsCollection();
    glyphs.current = editor.createDecorationsCollection();
    disposables.current.push(
      editor.onDidChangeModelContent(() => {
        checkedRef.current = { source: editor.getValue(), indexes: [] };
        setChecked([]);
        glyphs.current?.clear();
        setAnalysis(analyseSql(editor.getValue(), props.current.driver));
      }),
    );
    disposables.current.push(
      editor.onMouseDown((event) => {
        if (
          event.target.type !==
            monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
          !event.event.leftButton
        )
          return;
        const model = editor.getModel(),
          line = event.target.position?.lineNumber;
        if (!model || !line) return;
        const scan = analyseSql(model.getValue(), props.current.driver);
        if (scan.unsafe || scan.issues.length) return;
        toggleQueries(
          scan.statements.flatMap((statement, index) =>
            model.getPositionAt(statement.start).lineNumber === line
              ? [index]
              : [],
          ),
        );
        editor.focus();
      }),
    );
    const track = () => {
      const model = editor.getModel(),
        position = editor.getPosition(),
        selection = editor.getSelection();
      if (model && position)
        setCursor({
          offset: model.getOffsetAt(position),
          line: position.lineNumber,
          column: position.column,
          selected: selection ? model.getValueLengthInRange(selection) : 0,
        });
    };
    disposables.current.push(editor.onDidChangeCursorSelection(track));
    track();
    setMounted((n) => n + 1);
    for (const scope of ["current", "script"] as const)
      disposables.current.push(
        editor.addAction({
          id: `dbde-run-${scope}`,
          label:
            scope === "current"
              ? "Run current statement or selection"
              : "Run entire SQL script",
          contextMenuGroupId: "navigation",
          contextMenuOrder: scope === "current" ? 0.1 : 0.2,
          keybindings: [
            monaco.KeyMod.CtrlCmd |
              (scope === "current" ? monaco.KeyMod.Shift : monaco.KeyMod.Alt) |
              monaco.KeyCode.Enter,
          ],
          run: () => perform.current(scope),
        }),
      );
    disposables.current.push(
      editor.addAction({
        id: "dbde-format-sql",
        label: "Format SQL or selection",
        contextMenuGroupId: "2_edit",
        keybindings: [
          monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF,
        ],
        run: () =>
          formatEditorSql(editor, props.current.driver).catch((error) =>
            props.current.onError?.(String(error)),
          ),
      }),
    );
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
      label: "Run checked queries or current statement",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
      run: () => perform.current("checked"),
    });
  };
  const active = statementAt(analysis, cursor.offset);
  const activeIndex = active ? analysis.statements.indexOf(active) : -1;
  return (
    <div className="sql-editor-advanced">
      {queryChoices && (
        <div
          id="sql-query-choices"
          className="sql-query-choices"
          role="region"
          aria-label="Select queries to run"
          onKeyDown={(event) => {
            if (event.key === "Escape") setQueryChoices(false);
          }}
        >
          <header>
            <strong>Select queries to run</strong>
            <button
              className="icon-button"
              aria-label="Close query selection"
              onClick={() => setQueryChoices(false)}
            >
              <X size={14} />
            </button>
          </header>
          <small>
            Run executes checked queries in script order. Editing SQL clears the
            selection.
          </small>
          {analysis.unsafe || analysis.issues.length ? (
            <p>Select SQL text explicitly to run this script.</p>
          ) : (
            analysis.statements.map((statement, index) => (
              <label key={statement.start}>
                <input
                  type="checkbox"
                  checked={checked.includes(index)}
                  onChange={() => toggleQueries([index])}
                />
                <span>
                  {index + 1}.{" "}
                  {statement.text.replace(/\s+/g, " ").slice(0, 160)}
                </span>
              </label>
            ))
          )}
        </div>
      )}
      <div className="sql-editor-code">
        <Editor
          path={`${id}.sql`}
          height="100%"
          language="sql"
          theme={theme === "light" ? "dbde-light" : "dbde-dark"}
          value={value}
          onChange={(v) => onChange(v ?? "")}
          onMount={mount}
          options={{
            contextmenu: true,
            glyphMargin: true,
            fontSize: preferences.fontSize,
            fontFamily: '"SFMono-Regular", Consolas, monospace',
            minimap: { enabled: preferences.minimap },
            padding: { top: 10, bottom: 8 },
            lineNumbersMinChars: 4,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            renderLineHighlight: "gutter",
            lineNumbers: preferences.lineNumbers ? "on" : "off",
            folding: true,
            showFoldingControls: "mouseover",
            matchBrackets: "always",
            bracketPairColorization: { enabled: true },
            autoClosingBrackets: "always",
            quickSuggestions: { other: true, comments: false, strings: false },
            suggest: { showWords: false },
            wordWrap: preferences.wordWrap ? "on" : "off",
            overviewRulerLanes: 2,
            tabSize: preferences.tabSize,
            insertSpaces: true,
          }}
          loading={<div className="empty-inline">Loading local editor…</div>}
        />
      </div>
      <div className="sql-editor-status" aria-label="SQL editor status">
        <select
          aria-label="Statement navigator"
          value={analysis.unsafe ? "" : activeIndex < 0 ? "" : activeIndex}
          disabled={!!analysis.unsafe || !analysis.statements.length}
          title={analysis.unsafe ?? "Jump to a statement"}
          onChange={(event) => {
            const target = analysis.statements[Number(event.target.value)],
              instance = editorRef.current,
              model = instance?.getModel();
            if (target && instance && model) {
              const position = model.getPositionAt(target.start);
              instance.setPosition(position);
              instance.revealPositionInCenter(position);
              instance.focus();
            }
          }}
        >
          {!analysis.statements.length || analysis.unsafe ? (
            <option value="">
              {analysis.unsafe
                ? "Script · select SQL explicitly"
                : "No statements"}
            </option>
          ) : (
            analysis.statements.map((statement, index) => (
              <option key={statement.start} value={index}>
                {index + 1} · {statement.text.replace(/\s+/g, " ").slice(0, 70)}
              </option>
            ))
          )}
        </select>
        <button
          className="sql-editor-run-current"
          disabled={
            running ||
            (!cursor.selected &&
              (!analysis.statements.length ||
                !!analysis.unsafe ||
                !!analysis.issues.length))
          }
          title="Run current statement or selected SQL (⌘/Ctrl+Shift+Enter)"
          onClick={() => perform.current("current")}
        >
          <Play size={11} />
          Run statement
        </button>
        <button
          className="sql-editor-run-current"
          aria-expanded={queryChoices}
          aria-controls="sql-query-choices"
          onClick={() => setQueryChoices(!queryChoices)}
        >
          {checked.length ? `${checked.length} selected` : "Select queries"}
        </button>
        {checked.length > 0 && (
          <button
            className="sql-editor-run-current"
            onClick={() => {
              checkedRef.current = { source: value, indexes: [] };
              setChecked([]);
            }}
          >
            Clear
          </button>
        )}
        <span className="sql-editor-spacer" />
        <span className="sql-editor-position">
          Ln {cursor.line}, Col {cursor.column}
          {cursor.selected ? ` · ${cursor.selected} selected` : ""}
        </span>
        {analysis.issues.length > 0 && (
          <button
            className="sql-editor-issue"
            title={analysis.issues[0].message}
            onClick={() => {
              const instance = editorRef.current,
                model = instance?.getModel();
              if (instance && model) {
                const at = model.getPositionAt(analysis.issues[0].offset);
                instance.setPosition(at);
                instance.revealPositionInCenter(at);
                instance.focus();
              }
            }}
          >
            {analysis.issues.length} checks
          </button>
        )}
        <span className="sql-editor-dialect">
          {driver === "postgres"
            ? "PostgreSQL"
            : driver === "mysql"
              ? "MySQL"
              : "SQLite"}
        </span>
        <button
          ref={optionsButton}
          className="icon-button"
          aria-label="Editor settings"
          aria-expanded={settings}
          aria-controls={`editor-settings-${id}`}
          title="Editor settings"
          onClick={() => setSettings(!settings)}
        >
          <Settings2 size={13} />
        </button>
      </div>
      {settings && (
        <div
          ref={settingsPanel}
          id={`editor-settings-${id}`}
          className="sql-editor-settings"
          role="region"
          aria-label="Editor settings"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setSettings(false);
              optionsButton.current?.focus();
            }
          }}
        >
          <header>
            <strong>Editor settings</strong>
            <button
              className="icon-button"
              aria-label="Close editor settings"
              onClick={() => {
                setSettings(false);
                optionsButton.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          </header>
          <label>
            Font size
            <select
              value={preferences.fontSize}
              onChange={(e) =>
                setPreferences({
                  ...preferences,
                  fontSize: Number(e.target.value),
                })
              }
            >
              {[11, 12, 13, 14, 16, 18].map((size) => (
                <option key={size} value={size}>
                  {size} px
                </option>
              ))}
            </select>
          </label>
          <label>
            Indentation
            <select
              value={preferences.tabSize}
              onChange={(e) =>
                setPreferences({
                  ...preferences,
                  tabSize: Number(e.target.value),
                })
              }
            >
              <option value={2}>2 spaces</option>
              <option value={4}>4 spaces</option>
            </select>
          </label>
          {(
            [
              ["wordWrap", "Word wrap"],
              ["minimap", "Minimap"],
              ["lineNumbers", "Line numbers"],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="checkbox"
                checked={preferences[key]}
                onChange={(e) =>
                  setPreferences({ ...preferences, [key]: e.target.checked })
                }
              />
            </label>
          ))}
          <button
            className="button subtle"
            onClick={() => setPreferences({ ...defaultEditorPreferences })}
          >
            <RotateCcw size={12} />
            Reset editor settings
          </button>
          <small>
            Local settings · Basic checks are not server SQL validation.
          </small>
        </div>
      )}
    </div>
  );
}
