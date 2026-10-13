import { useState, type KeyboardEvent } from "react";
import { Check, Plus } from "lucide-react";

export default function NewRecordRow({
  columns,
  template,
  rowIndex,
  activeColumn,
  busy,
  onFocusCell,
  onCellKeyDown,
  onSave,
}: {
  columns: string[];
  template: string;
  rowIndex: number;
  activeColumn: number | null;
  busy: boolean;
  onFocusCell: (column: number) => void;
  onCellKeyDown: (event: KeyboardEvent<HTMLElement>, column: number) => boolean;
  onSave: (values: Record<string, string | null>) => Promise<number>;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<number | null>(null);
  const [beforeEdit, setBeforeEdit] = useState<{
    column: string;
    value?: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const disabled = busy || saving;
  function focusLater(column: number) {
    window.setTimeout(() => {
      document
        .querySelector<HTMLElement>(
          `[data-grid-row="${rowIndex}"][data-grid-col="${column}"]`,
        )
        ?.focus();
    }, 0);
  }

  function beginEdit(index: number, firstCharacter?: string) {
    if (disabled) return;
    const column = columns[index];
    setBeforeEdit({ column, value: draft[column] });
    if (firstCharacter !== undefined)
      setDraft((current) => ({ ...current, [column]: firstCharacter }));
    setEditing(index);
    onFocusCell(index);
  }
  function cancelEdit() {
    if (beforeEdit) {
      setDraft((current) => {
        const next = { ...current };
        if (beforeEdit.value === undefined) delete next[beforeEdit.column];
        else next[beforeEdit.column] = beforeEdit.value;
        return next;
      });
    }
    setEditing(null);
    setBeforeEdit(null);
  }
  async function saveRecord(values = draft) {
    if (disabled) return;
    setError("");
    setSaving(true);
    try {
      await onSave(values);
      setDraft({});
      setEditing(null);
      setBeforeEdit(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  }
  function inputKeyDown(event: KeyboardEvent<HTMLInputElement>, index: number) {
    event.stopPropagation();
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void saveRecord();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
      focusLater(index);
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      if (event.key === "Enter" || index < columns.length - 1 || event.shiftKey)
        event.preventDefault();
      setEditing(null);
      setBeforeEdit(null);
      if (
        event.key === "Enter" ||
        index < columns.length - 1 ||
        event.shiftKey
      ) {
        const nextColumn = Math.max(
          0,
          Math.min(columns.length - 1, index + (event.shiftKey ? -1 : 1)),
        );
        focusLater(nextColumn);
      }
    }
  }
  return (
    <>
      <div
        className="grid-row grid-new-row"
        role="row"
        aria-label="New record"
        aria-rowindex={rowIndex + 2}
        style={{ gridTemplateColumns: template }}
      >
        <span className="selection-cell">
          <Plus size={13} aria-hidden="true" />
        </span>
        <span className="row-number">
          <button
            className="grid-save-new"
            aria-label="Save new record"
            title="Save new record (Ctrl/⌘+Enter)"
            disabled={disabled}
            onClick={() => void saveRecord()}
          >
            <Check size={15} />
          </button>
        </span>
        {columns.map((column, index) => (
          <span
            key={column}
            role="cell"
            data-grid-row={rowIndex}
            data-grid-col={index}
            tabIndex={activeColumn === index ? 0 : -1}
            aria-label={`New record, ${column}`}
            className="grid-new-cell"
            title={`New record: ${column}. Type or press Enter to edit.`}
            onFocus={() => onFocusCell(index)}
            onClick={(event) => event.currentTarget.focus()}
            onDoubleClick={() => beginEdit(index)}
            onKeyDown={(event) => {
              if (disabled || editing === index) return;
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                void saveRecord();
                return;
              }
              if (onCellKeyDown(event, index)) return;
              if (event.key === "Enter" || event.key === "F2") {
                event.preventDefault();
                beginEdit(index);
              } else if (event.key === "Backspace") {
                event.preventDefault();
                beginEdit(index, "");
              } else if (event.key === "Delete") {
                event.preventDefault();
                setDraft((current) => {
                  const next = { ...current };
                  delete next[column];
                  return next;
                });
              } else if (
                event.key.length === 1 &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey
              ) {
                event.preventDefault();
                beginEdit(index, event.key);
              }
            }}
          >
            {editing === index ? (
              <input
                autoFocus
                aria-label={`New record ${column}`}
                value={draft[column] ?? ""}
                disabled={disabled}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    [column]: event.target.value,
                  }))
                }
                onKeyDown={(event) => inputKeyDown(event, index)}
                onBlur={() => {
                  setEditing(null);
                  setBeforeEdit(null);
                }}
              />
            ) : (
              (draft[column] ?? "")
            )}
          </span>
        ))}
      </div>
      {error && (
        <div className="grid-new-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
