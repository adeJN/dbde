import { useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { Check, Plus, X } from "lucide-react";
import type { DraftRecord } from "../types";
import { blankDraft } from "../lib/staged";
import type { CellMove } from "./CellEditor";
import {
  PickerButton,
  ValuePicker,
  hasPicker,
  type CellPicker,
} from "./ValuePicker";

/** A key press for grid navigation after a picker chose a value. */
const moveKey = (move: CellMove) =>
  ({
    key: move === "down" ? "ArrowDown" : move === "up" ? "ArrowUp" : "Tab",
    shiftKey: move === "left",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault() {},
    stopPropagation() {},
  }) as unknown as KeyboardEvent<HTMLElement>;

/**
 * New records and copies followed by a blank entry row.
 * Every cell edits like a spreadsheet; Ctrl/⌘+Enter saves all drafts in one transaction.
 */
export default function NewRecordRows({
  columns,
  template,
  gridWidth,
  firstRowIndex,
  drafts,
  onDraftsChange,
  active,
  busy,
  onFocusCell,
  onCellKeyDown,
  onSave,
  validate,
  frozen = [],
  pickerFor,
}: {
  /** Date/time, ENUM, SET, boolean and foreign-key pickers for a column of a draft. */
  pickerFor?: (column: string, draft: number) => CellPicker | undefined;
  validate?: (column: string, value: string | null) => string | undefined;
  /** Displayed columns, in displayed order (hidden columns left out). */
  columns: string[];
  /** Left offsets of the leading frozen columns, which stay in place on scroll. */
  frozen?: number[];
  template: string;
  gridWidth: number;
  /** Grid row index of the first draft, after the existing rows. */
  firstRowIndex: number;
  drafts: DraftRecord[];
  onDraftsChange: (drafts: DraftRecord[]) => void;
  active: { row: number; column: number } | null;
  busy: boolean;
  onFocusCell: (draft: number, column: number) => void;
  onCellKeyDown: (
    event: KeyboardEvent<HTMLElement>,
    draft: number,
    column: number,
  ) => boolean;
  /** Saves every pending change, these drafts included, in one transaction. */
  onSave: () => Promise<unknown>;
}) {
  const [editing, setEditing] = useState<{
    draft: number;
    column: number;
    before: string | null | undefined;
    label: string;
    picker?: boolean;
  } | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const disabled = busy || saving;
  const filled = drafts.filter((draft) => Object.keys(draft.values).length);
  const copies = drafts.filter((draft) => draft.copy).length;

  function focusLater(draft: number, column: number) {
    window.setTimeout(() => {
      document
        .querySelector<HTMLElement>(
          `[data-grid-row="${firstRowIndex + draft}"][data-grid-col="${column}"]`,
        )
        ?.focus();
    }, 0);
  }
  function setValue(draft: number, column: string, value?: string | null) {
    const next = drafts.map((item, index) => {
      if (index !== draft) return item;
      const values = { ...item.values };
      if (value === undefined) delete values[column];
      else values[column] = value;
      return { ...item, values };
    });
    if (Object.keys(next[next.length - 1].values).length)
      next.push(blankDraft());
    onDraftsChange(next);
  }

  function removeDraft(draft: number) {
    if (draft < drafts.length - 1)
      onDraftsChange(drafts.filter((_, index) => index !== draft));
    else
      onDraftsChange([
        ...drafts.slice(0, -1),
        { key: drafts[draft].key, values: {} },
      ]);
    setError("");
  }
  function beginEdit(
    draft: number,
    column: number,
    text?: string,
    picker = false,
  ) {
    if (disabled) return;
    const name = columns[column];
    const label =
      draft === drafts.length - 1
        ? "New record"
        : drafts[draft].copy
          ? `Copy ${draft + 1}`
          : `Draft ${draft + 1}`;
    setEditing({
      draft,
      column,
      before: drafts[draft].values[name],
      label,
      picker,
    });
    if (text !== undefined) setValue(draft, name, text);
    else if (drafts[draft].values[name] === null) setValue(draft, name, "");
    onFocusCell(draft, column);
  }
  /** Opens the column's picker, or its foreign key selection when that is all it has. */
  function openPicker(draft: number, column: number) {
    const picker = pickerFor?.(columns[column], draft);
    if (!hasPicker(picker) || disabled) return false;
    if (!picker.spec) picker.foreignKey?.onOpen();
    else if (editing?.draft === draft && editing.column === column)
      setEditing({ ...editing, picker: true });
    else beginEdit(draft, column, undefined, true);
    return true;
  }
  function pick(
    draft: number,
    column: number,
    value: string | null,
    move: CellMove,
  ) {
    const name = columns[column];
    const problem = validate?.(name, value);
    if (problem) {
      setError(problem);
      return;
    }
    setError("");
    setValue(draft, name, value);
    setEditing(null);
    if (move === "stay" || move === "none") focusLater(draft, column);
    else onCellKeyDown(moveKey(move), draft, column);
  }
  function closePicker() {
    if (editing) setEditing({ ...editing, picker: false });
    editorRef.current?.querySelector("input")?.focus();
  }
  function cancelEdit() {
    if (!editing) return;
    setValue(editing.draft, columns[editing.column], editing.before);
    setEditing(null);
  }
  async function save() {
    if (disabled) return;
    setError("");
    setSaving(true);
    try {
      await onSave();
      setEditing(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  }
  function inputKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    draft: number,
    column: number,
  ) {
    event.stopPropagation();
    const command = event.ctrlKey || event.metaKey;
    if (event.altKey && event.key === "ArrowDown") {
      if (openPicker(draft, column)) event.preventDefault();
      return;
    }
    if (command && event.key === "Enter") {
      event.preventDefault();
      void save();
      return;
    }
    if (command && event.shiftKey && event.key === "Backspace") {
      event.preventDefault();
      const error = validate?.(columns[column], null);
      if (error) {
        setError(error);
        return;
      }
      setError("");
      setValue(draft, columns[column], null);
      setEditing(null);
      focusLater(draft, column);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelEdit();
      focusLater(draft, column);
      return;
    }
    if (["Enter", "Tab", "ArrowUp", "ArrowDown"].includes(event.key)) {
      const error = validate?.(
        columns[column],
        drafts[draft].values[columns[column]] ?? "",
      );
      if (error) {
        event.preventDefault();
        setError(error);
        return;
      }
      setError("");
      // Editing and selected cells use the same grid navigation, including row wrap.
      event.preventDefault();
      setEditing(null);
      onCellKeyDown(event, draft, column);
    }
  }

  function cellKeyDown(
    event: KeyboardEvent<HTMLElement>,
    draft: number,
    column: number,
  ) {
    if (disabled || (editing?.draft === draft && editing.column === column))
      return;
    const command = event.ctrlKey || event.metaKey;
    const name = columns[column];
    if (command && event.key === "Enter") {
      event.preventDefault();
      void save();
      return;
    }
    if (
      event.altKey &&
      event.key === "ArrowDown" &&
      openPicker(draft, column)
    ) {
      event.preventDefault();
      return;
    }
    if (event.key !== "Enter" && onCellKeyDown(event, draft, column)) return;
    if (command && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault();
      removeDraft(draft);
      focusLater(Math.min(draft, drafts.length - 2), column);
      return;
    }
    if (event.key === "Escape" && Object.keys(drafts[draft].values).length) {
      event.preventDefault();
      removeDraft(draft);
      return;
    }
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      beginEdit(draft, column);
    } else if (event.key === "Backspace") {
      event.preventDefault();
      beginEdit(draft, column, "");
    } else if (event.key === "Delete") {
      event.preventDefault();
      setValue(draft, name); // Back to the column default.
    } else if (event.key.length === 1 && !command && !event.altKey) {
      event.preventDefault();
      beginEdit(draft, column, event.key);
    }
  }
  function editor(
    draftIndex: number,
    index: number,
    column: string,
    value: string | null | undefined,
  ) {
    const problem = validate?.(column, value ?? "");
    const blur = (event: FocusEvent<HTMLElement>) => {
      const next = event.relatedTarget as Node | null;
      if (
        next &&
        (editorRef.current?.contains(next) ||
          popoverRef.current?.contains(next))
      )
        return;
      if (problem) setError(problem);
      else {
        setError("");
        setEditing(null);
      }
    };
    const picker = pickerFor?.(column, draftIndex);
    const special = hasPicker(picker) ? picker : undefined;
    const input = (
      <input
        autoFocus={!editing?.picker}
        aria-label={`${editing?.label ?? ""} ${column}`.trim()}
        value={value ?? ""}
        disabled={disabled}
        aria-invalid={!!problem}
        aria-description={problem}
        title={problem}
        onChange={(event) => setValue(draftIndex, column, event.target.value)}
        onKeyDown={(event) => inputKeyDown(event, draftIndex, index)}
        onBlur={special ? undefined : blur}
      />
    );
    if (!special) return input;
    // Editing a NULL cell starts from "", so the picker still shows it as NULL.
    const shown =
      editing?.before === null && value === "" ? null : (value ?? null);
    return (
      <div className="grid-cell-editor" ref={editorRef} onBlur={blur}>
        {input}
        <PickerButton
          column={column}
          picker={special}
          disabled={disabled}
          onOpen={() => openPicker(draftIndex, index)}
        />
        {editing?.picker && special.spec && (
          <ValuePicker
            anchor={editorRef}
            popoverRef={popoverRef}
            column={column}
            picker={special}
            value={shown}
            onPick={(next, move) => pick(draftIndex, index, next, move)}
            onClose={closePicker}
          />
        )}
      </div>
    );
  }
  return (
    <>
      {drafts.map((draft, draftIndex) => {
        const blank = draftIndex === drafts.length - 1;
        const label = blank
          ? "New record"
          : draft.copy
            ? `Copy ${draftIndex + 1}`
            : `Draft ${draftIndex + 1}`;
        const rowIndex = firstRowIndex + draftIndex;
        return (
          <div
            key={draft.key}
            className={`grid-row grid-new-row${draft.copy ? " grid-copy-row" : ""}${active?.row === draftIndex ? " active-row" : ""}`}
            role="row"
            aria-label={label}
            aria-rowindex={rowIndex + 2}
            style={{
              gridTemplateColumns: template,
              minWidth: gridWidth,
            }}
          >
            <span className="selection-cell">
              {blank ? (
                <Plus size={13} aria-hidden="true" />
              ) : (
                <button
                  className="grid-remove-draft"
                  aria-label={`Remove ${label}`}
                  title="Remove this draft (Ctrl/⌘+Delete)"
                  disabled={disabled}
                  onClick={() => removeDraft(draftIndex)}
                >
                  <X size={13} />
                </button>
              )}
            </span>
            <span className="row-number">
              {blank && (
                <button
                  className="grid-save-new"
                  aria-label={
                    filled.length > 1
                      ? `Save ${filled.length} new records`
                      : "Save new record"
                  }
                  title={`Save ${filled.length > 1 ? `all ${filled.length} new records in one transaction` : "the new record"} (Ctrl/⌘+Enter)`}
                  disabled={disabled}
                  onClick={() => void save()}
                >
                  <Check size={15} />
                </button>
              )}
            </span>
            {columns.map((column, index) => {
              const value = draft.values[column];
              const isEditing =
                editing?.draft === draftIndex && editing.column === index;
              const isActive =
                active?.row === draftIndex && active.column === index;
              return (
                <span
                  key={column}
                  role="cell"
                  data-grid-row={rowIndex}
                  data-grid-col={index}
                  tabIndex={isActive ? 0 : -1}
                  aria-label={`${label}, ${column}`}
                  style={
                    index < frozen.length ? { left: frozen[index] } : undefined
                  }
                  className={`grid-new-cell${isActive ? " active" : ""}${isEditing ? " editing" : ""}${value === null ? " null" : ""}${index < frozen.length ? ` frozen-cell${index === frozen.length - 1 ? " frozen-last" : ""}` : ""}`}
                  title={`${label}: ${column}. Type or press Enter to edit.`}
                  onFocus={() => onFocusCell(draftIndex, index)}
                  onClick={(event) => event.currentTarget.focus()}
                  onDoubleClick={() => beginEdit(draftIndex, index)}
                  onKeyDown={(event) => cellKeyDown(event, draftIndex, index)}
                >
                  {isEditing
                    ? editor(draftIndex, index, column, value)
                    : value === null
                      ? "NULL"
                      : (value ?? "")}
                </span>
              );
            })}
          </div>
        );
      })}
      {copies > 0 && !error && (
        <div className="grid-new-hint" role="status">
          {copies} cop{copies === 1 ? "y" : "ies"} ready below. Edit them, then
          press Ctrl/⌘+Enter to save all in one transaction.
        </div>
      )}
      {error && (
        <div className="grid-new-error" role="alert">
          {error}
        </div>
      )}
    </>
  );
}
