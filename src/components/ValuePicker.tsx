import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Link2 } from "lucide-react";
import type { Driver } from "../types";
import {
  choiceIndex,
  choicesOf,
  formatTemporal,
  joinSet,
  nowValue,
  parseTemporal,
  splitSet,
  zoneNote,
  type EditorSpec,
  type TemporalParts,
} from "../lib/cell-editors";
import type { CellMove } from "./CellEditor";

/** What a cell or form field offers besides typing. */
export interface CellPicker {
  spec: EditorSpec | null;
  nullable: boolean;
  driver: Driver;
  /** Foreign Key Data Selection for this column, when it is part of a foreign key. */
  foreignKey?: { label: string; onOpen: () => void };
}
export const hasPicker = (picker?: CellPicker): picker is CellPicker =>
  !!picker && (!!picker.spec || !!picker.foreignKey);
export const pickerLabel = (column: string, picker: CellPicker) =>
  picker.spec ? `Open ${column} editor` : picker.foreignKey!.label;

/** Small button inside an editing cell; it never takes focus from the text input. */
export function PickerButton({
  column,
  picker,
  onOpen,
  disabled,
}: {
  column: string;
  picker: CellPicker;
  onOpen: () => void;
  disabled?: boolean;
}) {
  const label = pickerLabel(column, picker);
  return (
    <button
      type="button"
      className="cell-picker-button"
      tabIndex={-1}
      aria-label={label}
      title={`${label} (Alt+↓)`}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {picker.spec ? <ChevronDown size={13} /> : <Link2 size={13} />}
    </button>
  );
}

/**
 * Popover with the column's picker (date/time inputs, ENUM/boolean list or SET
 * checklist), rendered over the grid. Picking calls `onPick` with the new text and how
 * the cursor should move; Escape calls `onClose`.
 */
export function ValuePicker({
  anchor,
  column,
  picker,
  value,
  onPick,
  onClose,
  popoverRef,
}: {
  anchor: RefObject<HTMLElement>;
  column: string;
  picker: CellPicker;
  /** Current text of the cell or field; null is NULL. */
  value: string | null;
  onPick: (value: string | null, move: CellMove) => void;
  onClose: () => void;
  popoverRef?: RefObject<HTMLDivElement>;
}) {
  const own = useRef<HTMLDivElement>(null);
  const root = popoverRef ?? own;
  const [place, setPlace] = useState({ top: 0, left: 0 });
  useLayoutEffect(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 300;
    const height = root.current?.offsetHeight || 260;
    const below = rect.bottom + 2;
    setPlace({
      top:
        below + height > window.innerHeight && rect.top > height
          ? rect.top - height - 2
          : below,
      left: Math.max(4, Math.min(rect.left, window.innerWidth - width - 4)),
    });
  }, []);
  useEffect(() => {
    root.current
      ?.querySelector<HTMLElement>(
        "[data-autofocus], input:not(:disabled), [role='listbox'], button:not(:disabled)",
      )
      ?.focus();
  }, []);
  const { spec } = picker;
  let body: ReactNode = null;
  if (spec?.kind === "enum" || spec?.kind === "boolean")
    body = (
      <ChoiceList
        column={column}
        spec={spec}
        picker={picker}
        value={value}
        onPick={onPick}
      />
    );
  else if (spec?.kind === "set")
    body = (
      <SetChecklist
        column={column}
        values={spec.values}
        nullable={picker.nullable}
        value={value}
        onPick={onPick}
        onClose={onClose}
      />
    );
  else if (spec?.kind === "temporal")
    body = (
      <TemporalPanel
        column={column}
        spec={spec}
        nullable={picker.nullable}
        value={value}
        onPick={onPick}
        onClose={onClose}
      />
    );
  return createPortal(
    <div
      ref={root}
      className="value-picker"
      role="dialog"
      aria-label={`${column} editor`}
      style={{ top: place.top, left: place.left }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // The grid cell around the editor must not see picker keys.
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
    >
      {body}
      {picker.foreignKey && (
        <button
          type="button"
          className="value-picker-fk"
          onClick={picker.foreignKey.onOpen}
        >
          <Link2 size={13} /> {picker.foreignKey.label}
        </button>
      )}
    </div>,
    document.body,
  );
}

function ChoiceList({
  column,
  spec,
  picker,
  value,
  onPick,
}: {
  column: string;
  spec: Extract<EditorSpec, { kind: "enum" | "boolean" }>;
  picker: CellPicker;
  value: string | null;
  onPick: (value: string | null, move: CellMove) => void;
}) {
  const id = useId();
  const choices = choicesOf(spec, picker.driver, picker.nullable);
  const [active, setActive] = useState(() =>
    Math.max(0, choiceIndex(choices, spec, value)),
  );
  const selected = choiceIndex(choices, spec, value);
  function keyDown(event: KeyboardEvent<HTMLElement>) {
    const last = choices.length - 1;
    const go = (index: number) => {
      event.preventDefault();
      setActive(Math.max(0, Math.min(last, index)));
    };
    if (event.key === "ArrowDown") return go(active + 1);
    if (event.key === "ArrowUp") return go(active - 1);
    if (event.key === "Home" || event.key === "PageUp") return go(0);
    if (event.key === "End" || event.key === "PageDown") return go(last);
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      if (!choices[active]) return;
      onPick(
        choices[active].value,
        event.key === "Enter" ? "down" : event.shiftKey ? "left" : "right",
      );
      return;
    }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
      // Type-ahead: jump to the next entry starting with the typed character.
      const key = event.key.toLowerCase();
      const order = choices.map((_, i) => (active + 1 + i) % choices.length);
      const next = order.find((i) =>
        choices[i].label.toLowerCase().startsWith(key),
      );
      if (next !== undefined) go(next);
    }
  }
  return (
    <ul
      className="value-picker-list"
      role="listbox"
      tabIndex={0}
      aria-label={`${column} values`}
      aria-activedescendant={choices.length ? `${id}-${active}` : undefined}
      onKeyDown={keyDown}
    >
      {choices.map((choice, index) => (
        <li
          key={index}
          id={`${id}-${index}`}
          role="option"
          aria-selected={index === selected}
          className={`${index === active ? "active" : ""}${choice.value === null ? " null" : ""}`}
          onMouseEnter={() => setActive(index)}
          onClick={() => onPick(choice.value, "stay")}
        >
          {choice.label}
        </li>
      ))}
    </ul>
  );
}

function PickerActions({
  nullable,
  now,
  onNull,
  onClose,
  applyLabel = "OK",
}: {
  nullable: boolean;
  now?: { label: string; run: () => void };
  onNull: () => void;
  onClose: () => void;
  applyLabel?: string;
}) {
  return (
    <div className="value-picker-actions">
      {now && (
        <button type="button" className="button subtle" onClick={now.run}>
          {now.label}
        </button>
      )}
      <button
        type="button"
        className="button subtle"
        disabled={!nullable}
        title={nullable ? "Set to NULL" : "This column does not allow NULL"}
        onClick={onNull}
      >
        NULL
      </button>
      <span className="spacer" />
      <button type="button" className="button secondary" onClick={onClose}>
        Cancel
      </button>
      <button type="submit" className="button primary">
        {applyLabel}
      </button>
    </div>
  );
}

function SetChecklist({
  column,
  values,
  nullable,
  value,
  onPick,
  onClose,
}: {
  column: string;
  values: string[];
  nullable: boolean;
  value: string | null;
  onPick: (value: string | null, move: CellMove) => void;
  onClose: () => void;
}) {
  const [chosen, setChosen] = useState(() => splitSet(value));
  return (
    <form
      className="value-picker-set"
      onSubmit={(event) => {
        event.preventDefault();
        onPick(joinSet(chosen, values), "stay");
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          event.preventDefault();
          onPick(joinSet(chosen, values), "down");
        }
      }}
    >
      <fieldset>
        <legend>{column} members</legend>
        {values.map((member, index) => (
          <label key={index}>
            <input
              type="checkbox"
              checked={chosen.includes(member)}
              {...(index === 0 ? { "data-autofocus": true } : {})}
              onChange={(event) =>
                setChosen((current) =>
                  event.target.checked
                    ? [...current, member]
                    : current.filter((item) => item !== member),
                )
              }
            />
            {member === "" ? "(empty string)" : member}
          </label>
        ))}
      </fieldset>
      <PickerActions
        nullable={nullable}
        onNull={() => onPick(null, "stay")}
        onClose={onClose}
        now={{ label: "Clear", run: () => setChosen([]) }}
      />
    </form>
  );
}

const emptyParts = (): TemporalParts => ({
  date: "",
  time: "",
  fraction: "",
  zone: "",
  separator: " ",
});
function TemporalPanel({
  column,
  spec,
  nullable,
  value,
  onPick,
  onClose,
}: {
  column: string;
  spec: Extract<EditorSpec, { kind: "temporal" }>;
  nullable: boolean;
  value: string | null;
  onPick: (value: string | null, move: CellMove) => void;
  onClose: () => void;
}) {
  const stored = (value && parseTemporal(value)) || null;
  const [parts, setParts] = useState<TemporalParts>(() => {
    const initial = stored ?? emptyParts();
    if (spec.temporal === "year" && value && /^\d{4}$/.test(value.trim()))
      return { ...initial, date: value.trim() };
    return initial;
  });
  const [problem, setProblem] = useState("");
  const set = (change: Partial<TemporalParts>) => {
    setProblem("");
    setParts((current) => ({ ...current, ...change }));
  };
  const nativeTime = /^\d{2}:\d{2}:\d{2}$/.test(parts.time) ? parts.time : "";
  const showFraction =
    spec.temporal !== "date" &&
    spec.temporal !== "year" &&
    (!!spec.precision || !!stored?.fraction);
  function apply(move: CellMove) {
    const needDate = spec.temporal !== "time";
    const needTime = spec.temporal === "time" || spec.temporal === "datetime";
    if (spec.temporal === "year") {
      if (!/^\d{4}$/.test(parts.date.slice(0, 4)))
        return setProblem("Enter a four-digit year.");
    } else if ((needDate && !parts.date) || (needTime && !parts.time))
      return setProblem(
        needDate && needTime
          ? "Choose a date and a time."
          : needDate
            ? "Choose a date."
            : "Choose a time.",
      );
    if (
      spec.zoned &&
      parts.zone &&
      !/^(Z|[+-]\d{2}(:?\d{2})?)$/i.test(parts.zone)
    )
      return setProblem("Use an offset like +07:00, -05 or Z.");
    if (!/^\d*$/.test(parts.fraction))
      return setProblem("Fractional seconds take digits only.");
    onPick(formatTemporal(spec, parts), move);
  }
  const note = zoneNote(spec, stored?.zone ?? "");
  const input = (props: Record<string, unknown>) => (
    <input
      {...props}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          apply("down");
        }
      }}
    />
  );
  return (
    <form
      className="value-picker-temporal"
      aria-label={`${column} date and time`}
      onSubmit={(event) => {
        event.preventDefault();
        apply("stay");
      }}
    >
      <div className="value-picker-fields">
        {spec.temporal === "date" && (
          <label>
            Date
            {input({
              type: "date",
              value: parts.date,
              onChange: (event: { target: HTMLInputElement }) =>
                set({ date: event.target.value }),
            })}
          </label>
        )}
        {spec.temporal === "time" && (
          <label>
            Time
            {input({
              type: "time",
              step: 1,
              value: nativeTime,
              onChange: (event: { target: HTMLInputElement }) =>
                set({ time: withSeconds(event.target.value) }),
            })}
          </label>
        )}
        {spec.temporal === "datetime" && (
          <label>
            Date and time
            {input({
              type: "datetime-local",
              step: 1,
              value:
                parts.date && nativeTime ? `${parts.date}T${nativeTime}` : "",
              onChange: (event: { target: HTMLInputElement }) => {
                const [date = "", time = ""] = event.target.value.split("T");
                set({ date, time: withSeconds(time) });
              },
            })}
          </label>
        )}
        {spec.temporal === "year" && (
          <label>
            Year
            {input({
              type: "number",
              min: 1901,
              max: 2155,
              value: parts.date.slice(0, 4),
              onChange: (event: { target: HTMLInputElement }) =>
                set({ date: event.target.value }),
            })}
          </label>
        )}
        {showFraction && (
          <label className="narrow">
            Fraction
            {input({
              inputMode: "numeric",
              value: parts.fraction,
              maxLength: spec.precision || 9,
              "aria-label": "Fractional seconds",
              placeholder: "000000".slice(0, spec.precision || 6),
              onChange: (event: { target: HTMLInputElement }) =>
                set({ fraction: event.target.value }),
            })}
          </label>
        )}
        {spec.zoned && (
          <label className="narrow">
            UTC offset
            {input({
              value: parts.zone,
              placeholder: "+00:00",
              onChange: (event: { target: HTMLInputElement }) =>
                set({ zone: event.target.value.trim() }),
            })}
          </label>
        )}
      </div>
      {note && <p className="value-picker-note">{note}</p>}
      {problem && (
        <p className="value-picker-problem" role="alert">
          {problem}
        </p>
      )}
      <PickerActions
        nullable={nullable}
        onNull={() => onPick(null, "stay")}
        onClose={onClose}
        now={{
          label: spec.temporal === "date" ? "Today" : "Now",
          run: () =>
            onPick(
              spec.temporal === "year"
                ? String(new Date().getFullYear())
                : nowValue(spec, new Date(), stored?.separator ?? " "),
              "stay",
            ),
        }}
      />
    </form>
  );
}
/** Native inputs give HH:MM, HH:MM:SS or HH:MM:SS.mmm; fractions are edited apart. */
function withSeconds(time: string) {
  const match = time.match(/^(\d{2}:\d{2})(?::(\d{2}))?/);
  return match ? `${match[1]}:${match[2] ?? "00"}` : "";
}
