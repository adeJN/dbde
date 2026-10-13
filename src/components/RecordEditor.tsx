import { useState } from "react";
import { X } from "lucide-react";
import { displayValue } from "../lib/sql";

type EditTarget = {
  row: unknown[];
  column: string;
  index: number;
  draftValue?: string;
};
export default function RecordEditor({
  columns,
  primaryKeys,
  target,
  canEdit,
  canInsert,
  onClose,
  onUpdate,
  onInsert,
}: {
  columns: string[];
  primaryKeys: string[];
  target?: EditTarget;
  canEdit: boolean;
  canInsert: boolean;
  onClose: () => void;
  onUpdate?: (
    row: unknown[],
    column: string,
    value: string | null,
  ) => Promise<number>;
  onInsert?: (values: Record<string, string | null>) => Promise<number>;
}) {
  const [value, setValue] = useState(
    target?.draftValue ??
      (target?.row[target.index] == null
        ? ""
        : String(target.row[target.index])),
  );
  const [useNull, setUseNull] = useState(
    target?.draftValue === undefined && target?.row[target.index] == null,
  );
  const [fields, setFields] = useState<
    Record<string, { mode: "default" | "value" | "null"; value: string }>
  >({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const editable =
    !!target &&
    canEdit &&
    !primaryKeys.includes(target.column) &&
    (target.row[target.index] == null ||
      typeof target.row[target.index] !== "object");
  async function save() {
    setError("");
    setSaving(true);
    try {
      if (target) {
        if (!editable || !onUpdate) return;
        const original = target.row[target.index];
        if (
          (useNull && original == null) ||
          (!useNull && original != null && value === String(original))
        ) {
          onClose();
          return;
        }
        await onUpdate(target.row, target.column, useNull ? null : value);
      } else {
        if (!canInsert || !onInsert) return;
        const values = Object.fromEntries(
          columns.flatMap((column) => {
            const field = fields[column];
            return !field || field.mode === "default"
              ? []
              : [[column, field.mode === "null" ? null : field.value]];
          }),
        );
        await onInsert(values);
      }
      onClose();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSaving(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <section
        className="modal record-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="record-editor-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !saving) onClose();
        }}
      >
        <header>
          <h2 id="record-editor-title">
            {target ? "Record details" : "Add record"}
          </h2>
          <button
            className="icon-button"
            aria-label="Close record editor"
            autoFocus={!editable}
            disabled={saving}
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>
        {target ? (
          <>
            <div className="record-details">
              {columns.map((column, index) => (
                <div key={column}>
                  <span>{column}</span>
                  <code>{displayValue(target.row[index])}</code>
                </div>
              ))}
            </div>
            <label className="record-field">
              <span>
                Edit {target.column}
                {primaryKeys.includes(target.column) ? " · primary key" : ""}
              </span>
              <textarea
                aria-label={`Edit ${target.column}`}
                autoFocus={editable}
                value={value}
                disabled={!editable || useNull || saving}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
            {editable && (
              <label className="record-null">
                <input
                  type="checkbox"
                  checked={useNull}
                  disabled={saving}
                  onChange={(event) => setUseNull(event.target.checked)}
                />{" "}
                Set NULL
              </label>
            )}
            {!editable && (
              <p className="record-note">
                This cell is read-only. Only non-key scalar values in tables
                with a primary key can be edited.
              </p>
            )}
          </>
        ) : (
          <div className="record-fields">
            <p>
              Leave a column on Default to use its database default or
              auto-generated value.
            </p>
            {columns.map((column) => {
              const field = fields[column] ?? { mode: "default", value: "" };
              return (
                <div className="record-insert-field" key={column}>
                  <label htmlFor={`record-${column}`}>{column}</label>
                  <select
                    aria-label={`${column} mode`}
                    value={field.mode}
                    disabled={saving}
                    onChange={(event) =>
                      setFields((current) => ({
                        ...current,
                        [column]: {
                          ...field,
                          mode: event.target.value as typeof field.mode,
                        },
                      }))
                    }
                  >
                    <option value="default">Default</option>
                    <option value="value">Value</option>
                    <option value="null">NULL</option>
                  </select>
                  <input
                    id={`record-${column}`}
                    value={field.value}
                    disabled={saving || field.mode !== "value"}
                    onChange={(event) =>
                      setFields((current) => ({
                        ...current,
                        [column]: { ...field, value: event.target.value },
                      }))
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
        {error && (
          <div className="form-message error" role="alert">
            {error}
          </div>
        )}
        <footer>
          <button
            className="button secondary"
            disabled={saving}
            onClick={onClose}
          >
            Cancel
          </button>
          {(target ? editable : canInsert) && (
            <button
              className="button primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : target ? "Save cell" : "Add record"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
