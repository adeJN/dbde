import {
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  CalendarClock,
  ChevronLeft,
  Link2,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Plus,
  Trash2,
} from "lucide-react";
import { displayValue } from "../lib/sql";
import { choiceIndex, choicesOf, joinSet, splitSet } from "../lib/cell-editors";
import { ValuePicker, type CellPicker } from "./ValuePicker";

export interface FormField {
  name: string;
  /** Data type from column metadata, when known. */
  type?: string;
  /** Shown value: staged edit or stored value; undefined on a draft means default. */
  value: unknown;
  modified: boolean;
  /**
   * Long or multi-line stored text gets a textarea. Decided from the stored value, so
   * the control does not change (and lose focus) while typing.
   */
  multiline?: boolean;
  /** Why the field cannot be edited; editable when absent. */
  readOnly?: string;
  error?: string;
  /** Special editor (date/time, ENUM, SET, boolean) and foreign key selection. */
  picker?: CellPicker;
}
export type FormMove = "first" | "previous" | "next" | "last";
const isBinary = (value: unknown) =>
  value !== null && typeof value === "object" && "hex" in value;
const LONG_TYPES = /text|json|xml|clob|blob|array|\[\]/i;
const multiLine = (field: FormField) =>
  !isBinary(field.value) &&
  (!!field.multiline || LONG_TYPES.test(field.type ?? ""));

const focusField = (fieldId: string) =>
  window.setTimeout(() => document.getElementById(fieldId)?.focus(), 0);
type Common = {
  id: string;
  value: string;
  readOnly: boolean;
  onChange: (
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  [attribute: string]: unknown;
};
/**
 * The field's control: a dropdown for ENUM and boolean columns, a checklist for SET,
 * otherwise a text box (date/time columns add a picker button next to it).
 */
function control(
  field: FormField,
  fieldId: string,
  common: Common,
  readOnly: boolean,
  isDraft: boolean,
  onChange: (name: string, value: string | null | undefined) => void,
) {
  const spec = field.picker?.spec;
  if (spec && (spec.kind === "enum" || spec.kind === "boolean")) {
    // NULL is the checkbox next to the field, so the list holds values only.
    const choices = choicesOf(spec, field.picker!.driver, false);
    const index = choiceIndex(choices, spec, field.value);
    const {
      onChange: _text,
      value: _value,
      placeholder: _p,
      readOnly: _r,
      ...rest
    } = common;
    const unknown = index < 0 && field.value != null;
    return (
      <select
        {...rest}
        disabled={readOnly}
        value={
          field.value === undefined && isDraft
            ? "default"
            : field.value === null
              ? "null"
              : unknown
                ? "current"
                : String(index)
        }
        onChange={(event) => {
          const choice = event.target.value;
          if (choice === "default") onChange(field.name, undefined);
          else if (/^\d+$/.test(choice))
            onChange(field.name, choices[Number(choice)].value);
        }}
      >
        {isDraft && <option value="default">(default)</option>}
        {field.value === null && (
          <option value="null" disabled>
            NULL
          </option>
        )}
        {unknown && (
          <option value="current" disabled>
            {displayValue(field.value)}
          </option>
        )}
        {choices.map((choice, i) => (
          <option key={i} value={String(i)}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  }
  if (spec?.kind === "set") {
    const chosen =
      field.value == null ? [] : splitSet(displayValue(field.value));
    return (
      <div
        className="form-field-set"
        role="group"
        id={fieldId}
        tabIndex={-1}
        aria-labelledby={common["aria-labelledby"] as string}
        aria-describedby={common["aria-describedby"] as string | undefined}
        onKeyDown={common.onKeyDown}
      >
        {spec.values.map((member, i) => (
          <label key={i}>
            <input
              type="checkbox"
              disabled={readOnly}
              checked={chosen.includes(member)}
              onChange={(event) =>
                onChange(
                  field.name,
                  joinSet(
                    event.target.checked
                      ? [...chosen, member]
                      : chosen.filter((item) => item !== member),
                    spec.values,
                  ),
                )
              }
            />
            {member === "" ? "(empty string)" : member}
          </label>
        ))}
      </div>
    );
  }
  return multiLine(field) ? (
    <textarea rows={4} {...common} />
  ) : (
    <input {...common} />
  );
}

/**
 * One record at a time (Navicat Form View). Values are staged exactly like grid cells;
 * the grid saves them when another record is shown or on Ctrl/⌘+S.
 */
export default function FormView({
  fields,
  title,
  isDraft,
  can,
  busy,
  modified,
  onMove,
  onChange,
  onSave,
  onDiscard,
  onAdd,
  onDelete,
  deleteLabel,
  deleteDisabled,
}: {
  fields: FormField[];
  title: string;
  isDraft: boolean;
  can: Record<FormMove, boolean> & { add: boolean };
  busy: boolean;
  /** Whether the shown record has staged changes. */
  modified: boolean;
  onMove: (move: FormMove) => void;
  /** `undefined` resets a new record's field to the column default. */
  onChange: (name: string, value: string | null | undefined) => void;
  onSave: () => void;
  onDiscard: () => void;
  onAdd: () => void;
  onDelete: () => void;
  deleteLabel: string;
  deleteDisabled?: string;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  // The field whose date/time picker is open.
  const [picking, setPicking] = useState<string | null>(null);
  const pickerAnchor = useRef<HTMLDivElement>(null);
  function keyDown(event: ReactKeyboardEvent<HTMLElement>) {
    const command = event.ctrlKey || event.metaKey;
    const run = (action: () => void) => {
      event.preventDefault();
      event.stopPropagation();
      action();
    };
    if (event.altKey) return;
    if (event.key === "PageUp" || event.key === "PageDown") {
      const move: FormMove =
        event.key === "PageUp"
          ? command
            ? "first"
            : "previous"
          : command
            ? "last"
            : "next";
      if (can[move]) run(() => onMove(move));
      else event.preventDefault();
      return;
    }
    if (command && event.key.toLowerCase() === "s") return run(onSave);
    if (event.key === "Escape" && modified) return run(onDiscard);
  }
  const nav: [FormMove, string, typeof ChevronLeft][] = [
    ["first", "First record", ChevronsLeft],
    ["previous", "Previous record", ChevronLeft],
    ["next", "Next record", ChevronRight],
    ["last", "Last record", ChevronsRight],
  ];
  return (
    <div
      ref={root}
      className="form-view"
      role="region"
      aria-label="Form view"
      onKeyDown={keyDown}
    >
      <div
        className="form-view-nav"
        role="toolbar"
        aria-label="Record navigation"
      >
        {nav.map(([move, label, Icon]) => (
          <button
            key={move}
            className="icon-button"
            aria-label={label}
            title={`${label} (${move === "previous" ? "Page Up" : move === "next" ? "Page Down" : move === "first" ? "Ctrl/⌘+Page Up" : "Ctrl/⌘+Page Down"})`}
            disabled={!can[move]}
            onClick={() => onMove(move)}
          >
            <Icon size={16} />
          </button>
        ))}
        <span className="form-view-position" role="status" aria-live="polite">
          {title}
        </span>
        {modified && <span className="form-view-modified">Unsaved</span>}
        <div className="spacer" />
        <button
          className="button row-action"
          aria-label="Add record in form"
          title="Add a new record (saved when you move to another record or press Ctrl/⌘+S)"
          disabled={!can.add || busy}
          onClick={() => {
            onAdd();
            window.setTimeout(
              () =>
                root.current
                  ?.querySelector<HTMLElement>(
                    ".form-field-control :is(input, textarea):not(:disabled):not([readonly])",
                  )
                  ?.focus(),
              0,
            );
          }}
        >
          <Plus size={14} /> Add
        </button>
        <button
          className="button row-action danger"
          aria-label={deleteLabel}
          title={deleteDisabled || deleteLabel}
          disabled={busy || !!deleteDisabled}
          onClick={onDelete}
        >
          <Trash2 size={14} /> Delete
        </button>
      </div>
      <div className="form-view-fields">
        {!fields.length && (
          <p className="form-view-empty">
            All columns are hidden. Use Columns to show some.
          </p>
        )}
        {fields.map((field, index) => {
          const fieldId = `${id}-${index}`;
          const isNull = field.value === null;
          const text =
            field.value == null
              ? ""
              : typeof field.value === "string"
                ? field.value
                : displayValue(field.value);
          const readOnly = !!field.readOnly || busy;
          const common = {
            id: fieldId,
            value: text,
            readOnly,
            "aria-invalid": !!field.error,
            "aria-labelledby": `${fieldId}-name`,
            "aria-describedby":
              [
                field.type ? `${fieldId}-type` : "",
                field.error ? `${fieldId}-error` : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined,
            placeholder: isNull
              ? "NULL"
              : field.value === undefined && isDraft
                ? "(default)"
                : "",
            title: field.readOnly,
            onChange: (
              event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
            ) => onChange(field.name, event.target.value),
            onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
              if (
                event.altKey &&
                event.key === "ArrowDown" &&
                !readOnly &&
                field.picker
              ) {
                if (field.picker.spec?.kind === "temporal") {
                  event.preventDefault();
                  setPicking(field.name);
                } else if (!field.picker.spec && field.picker.foreignKey) {
                  event.preventDefault();
                  field.picker.foreignKey.onOpen();
                }
              }
            },
          };
          return (
            <div
              key={field.name}
              className={`form-field${field.modified ? " modified" : ""}${isNull ? " null" : ""}`}
            >
              <label className="form-field-label" htmlFor={fieldId}>
                <span id={`${fieldId}-name`} className="form-field-name">
                  {field.name}
                </span>
                {field.type && (
                  <span id={`${fieldId}-type`} className="form-field-type">
                    {field.type}
                  </span>
                )}
              </label>
              <div
                className="form-field-control"
                ref={picking === field.name ? pickerAnchor : undefined}
              >
                {control(field, fieldId, common, readOnly, isDraft, onChange)}
                {field.picker?.spec?.kind === "temporal" && !readOnly && (
                  <button
                    type="button"
                    className="icon-button form-field-picker"
                    aria-label={`Open ${field.name} editor`}
                    title={`Pick a value for ${field.name} (Alt+↓)`}
                    onClick={() => setPicking(field.name)}
                  >
                    <CalendarClock size={15} />
                  </button>
                )}
                {field.picker?.foreignKey && !readOnly && (
                  <button
                    type="button"
                    className="icon-button form-field-picker"
                    aria-label={field.picker.foreignKey.label}
                    title={field.picker.foreignKey.label}
                    onClick={field.picker.foreignKey.onOpen}
                  >
                    <Link2 size={15} />
                  </button>
                )}
                {picking === field.name && field.picker && (
                  <ValuePicker
                    anchor={pickerAnchor}
                    column={field.name}
                    picker={{ ...field.picker, foreignKey: undefined }}
                    value={
                      field.value == null ? null : displayValue(field.value)
                    }
                    onPick={(value) => {
                      setPicking(null);
                      onChange(field.name, value);
                      focusField(fieldId);
                    }}
                    onClose={() => {
                      setPicking(null);
                      focusField(fieldId);
                    }}
                  />
                )}
                <label
                  className="form-field-null"
                  title={field.readOnly ? undefined : "Set this field to NULL"}
                >
                  <input
                    type="checkbox"
                    aria-label={`${field.name} is NULL`}
                    checked={isNull}
                    disabled={readOnly}
                    onChange={(event) =>
                      onChange(
                        field.name,
                        event.target.checked ? null : isDraft ? undefined : "",
                      )
                    }
                  />
                  NULL
                </label>
              </div>
              {field.error && (
                <span
                  id={`${fieldId}-error`}
                  className="form-field-error"
                  role="alert"
                >
                  {field.error}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
