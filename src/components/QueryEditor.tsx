import { useEffect, useRef } from "react";
import Editor, { loader, type OnMount } from "@monaco-editor/react";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution";
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController";
import "monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import type { TableInfo } from "../types";
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
export default function QueryEditor({
  id,
  value,
  onChange,
  onRun,
  tables,
  editorRef,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onRun: (selection?: string) => void;
  tables: TableInfo[];
  editorRef: React.MutableRefObject<monaco.editor.IStandaloneCodeEditor | null>;
}) {
  const run = useRef(onRun);
  run.current = onRun;
  useEffect(() => {
    const provider = monaco.languages.registerCompletionItemProvider("sql", {
      provideCompletionItems: (model, position) => {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: [
            ...tables.map((t) => ({
              label: t.name,
              kind: monaco.languages.CompletionItemKind.Struct,
              insertText: t.name,
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
  }, [tables]);
  const mount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.addAction({
      id: "dbde-run-query",
      label: "Run query",
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
      theme="vs-dark"
      value={value}
      onChange={(v) => onChange(v ?? "")}
      onMount={mount}
      options={{
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
