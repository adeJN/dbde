import { useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import {
  PickerButton,
  ValuePicker,
  hasPicker,
  type CellPicker,
} from "./ValuePicker";
/** "none" saves without taking focus back, for a blur caused by clicking elsewhere. */
export type CellMove = "down" | "up" | "left" | "right" | "stay" | "none";
/**
 * In-cell editor for an existing record. Nothing is written until the user commits with
 * Enter, Tab or Ctrl/⌘+Enter; Escape restores the stored value. Columns with a special
 * editor (date/time, ENUM, SET, boolean, foreign key) also get a picker: the button in
 * the cell or Alt+↓.
 */
export default function CellEditor({
  column,
  initial,
  selectAll,
  saving,
  onCommit,
  onCancel,
  onExpand,
  validate,
  onValidationError,
  picker,
  openPicker = false,
  initialNull = false,
}: {
  validate?: (value: string | null) => string | undefined;
  onValidationError?: (error: string) => void;
  column: string;
  initial: string;
  /** Select the stored value (Enter/F2); typing to start keeps the caret after it. */
  selectAll: boolean;
  saving: boolean;
  onCommit: (value: string | null, move: CellMove) => void;
  onCancel: () => void;
  /** Opens the full record dialog with the current draft (long text, NULL control). */
  onExpand: (draft: string) => void;
  picker?: CellPicker;
  /** Open the picker right away (Alt+↓ on a selected cell). */
  openPicker?: boolean;
  /** The cell holds NULL: the picker shows NULL until the text is changed. */
  initialNull?: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  const special = hasPicker(picker) ? picker : undefined;
  const [open, setOpen] = useState(openPicker && !!special?.spec);
  const wrapper = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  function commit(value: string | null, move: CellMove) {
    const error = validate?.(value);
    if (error) {
      onValidationError?.(error);
      return;
    }
    onValidationError?.("");
    onCommit(value, move);
  }
  function openSpecial() {
    if (!special) return;
    if (special.spec) setOpen(true);
    else special.foreignKey?.onOpen();
  }
  function closePicker() {
    setOpen(false);
    input.current?.focus();
  }
  const validationError = validate?.(draft);
  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    // The surrounding cell handles navigation keys; editing owns them here.
    event.stopPropagation();
    const command = event.ctrlKey || event.metaKey;
    let move: CellMove | null = null;
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (special && event.altKey && event.key === "ArrowDown") {
      event.preventDefault();
      openSpecial();
      return;
    }
    if (command && event.shiftKey && event.key === "Backspace") {
      event.preventDefault();
      commit(null, "stay");
      return;
    }
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      onExpand(draft);
      return;
    }
    if (event.key === "Enter") move = command ? "stay" : "down";
    else if (event.key === "Tab") move = event.shiftKey ? "left" : "right";
    if (move) {
      event.preventDefault();
      commit(draft, move);
    }
  }
  function blur(event: FocusEvent<HTMLElement>) {
    // Focus moving into the picker (or back) is still editing.
    const next = event.relatedTarget as Node | null;
    if (
      next &&
      (wrapper.current?.contains(next) || popover.current?.contains(next))
    )
      return;
    // Clicking elsewhere keeps a changed draft, like a spreadsheet. Switching
    // windows also blurs; that must not write anything.
    // The grid skips the write when the value matches what is stored.
    if (saving || !document.hasFocus()) return;
    commit(draft, "none");
  }
  const field = (
    <input
      ref={input}
      className="grid-cell-input"
      autoFocus={!open}
      aria-label={`Edit ${column} in cell`}
      value={draft}
      aria-invalid={!!validationError}
      aria-description={validationError}
      title={validationError}
      disabled={saving}
      onFocus={(event) => {
        const target = event.currentTarget;
        if (selectAll) target.select();
        else target.setSelectionRange(target.value.length, target.value.length);
      }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={keyDown}
      onBlur={special ? undefined : blur}
    />
  );
  if (!special) return field;
  return (
    <div className="grid-cell-editor" ref={wrapper} onBlur={blur}>
      {field}
      <PickerButton
        column={column}
        picker={special}
        disabled={saving}
        onOpen={openSpecial}
      />
      {open && special.spec && (
        <ValuePicker
          anchor={wrapper}
          popoverRef={popover}
          column={column}
          picker={special}
          value={initialNull && draft === initial ? null : draft}
          onPick={(value, move) => commit(value, move)}
          onClose={closePicker}
        />
      )}
    </div>
  );
}
