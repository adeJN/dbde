import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Columns3,
  FileCode2,
  KeyRound,
  Loader2,
  Plus,
  Save,
  Search,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import type { Session, TableInfo } from "../types";
import * as api from "../lib/api";
import {
  buildTablePlan,
  fieldTypes,
  newField,
  newTableDesign,
  supportsDecimals,
  supportsIdentity,
  supportsLength,
  type DesignField,
  type TableDesign,
} from "../lib/table-designer";

export interface TableDesignerRequest {
  session: Session;
  database: string;
}
export default function TableDesigner({
  request: { session, database },
  onClose,
  onCreated,
}: {
  request: TableDesignerRequest;
  onClose: () => void;
  onCreated: (table: TableInfo) => void;
}) {
  const driver = session.config.driver;
  const [initial] = useState(() => newTableDesign(driver, database));
  const [design, setDesign] = useState(initial);
  const [selected, setSelected] = useState(initial.fields[0].id);
  const [pane, setPane] = useState("Fields");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState("");
  const [discard, setDiscard] = useState(false);
  const root = useRef<HTMLElement>(null);
  const find = useRef<HTMLInputElement>(null);
  const dragging = useRef<string>();
  const field = design.fields.find((f) => f.id === selected);
  const selectedIndex = design.fields.findIndex((f) => f.id === selected);
  const dirty = JSON.stringify(design) !== JSON.stringify(initial);
  const tabs = [
    "Fields",
    "Indexes",
    "Foreign Keys",
    "Checks",
    ...(driver === "mysql" ? ["Options"] : []),
    ...(driver !== "sqlite" ? ["Comment"] : []),
    "SQL Preview",
  ];
  let sql = "",
    validation = "";
  try {
    sql = buildTablePlan(
      { ...design, name: design.name || "new_table" },
      driver,
      database,
    ).sql;
  } catch (cause) {
    validation = cause instanceof Error ? cause.message : String(cause);
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current
      ?.querySelector<HTMLInputElement>('input[aria-label="Table name"]')
      ?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  function update(patch: Partial<TableDesign>) {
    setDesign((current) => ({ ...current, ...patch }));
    setError("");
  }
  function changeField(id: string, patch: Partial<DesignField>) {
    setDesign((current) => ({
      ...current,
      fields: current.fields.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    }));
    setError("");
  }
  function addField(insert = false) {
    if (design.fields.length >= 256) return;
    const next = newField(driver);
    const fields = [...design.fields];
    fields.splice(insert ? Math.max(0, selectedIndex) : fields.length, 0, next);
    update({ fields });
    setSelected(next.id);
    setSearch("");
    setPane("Fields");
    window.setTimeout(
      () =>
        root.current
          ?.querySelector<HTMLInputElement>(`[data-field-name="${next.id}"]`)
          ?.focus(),
      0,
    );
  }
  function deleteField() {
    if (!field || design.fields.length <= 1) return;
    const fields = design.fields.filter((f) => f.id !== field.id);
    update({ fields });
    setSelected(fields[Math.min(selectedIndex, fields.length - 1)].id);
  }
  function moveField(direction: number) {
    const next = selectedIndex + direction;
    if (selectedIndex < 0 || next < 0 || next >= design.fields.length) return;
    const fields = [...design.fields];
    [fields[selectedIndex], fields[next]] = [
      fields[next],
      fields[selectedIndex],
    ];
    update({ fields });
  }
  function dismiss() {
    if (busy) return;
    if (dirty) setDiscard(true);
    else onClose();
  }
  async function save() {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      buildTablePlan(design, driver, database);
      const table = await api.createTable(session.id, database, design);
      onCreated(table);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  function fieldPicker(values: string[], change: (value: string[]) => void) {
    return (
      <fieldset className="designer-field-picker">
        <legend>Fields · select in index/key order</legend>
        {design.fields.map((f) => (
          <label key={f.id}>
            <input
              type="checkbox"
              checked={values.includes(f.id)}
              disabled={busy}
              onChange={(e) =>
                change(
                  e.target.checked
                    ? [...values, f.id]
                    : values.filter((id) => id !== f.id),
                )
              }
            />
            <span>{f.name || "Unnamed field"}</span>
            {values.includes(f.id) && <small>{values.indexOf(f.id) + 1}</small>}
          </label>
        ))}
      </fieldset>
    );
  }
  const toolbar = (
    label: string,
    icon: React.ReactNode,
    action: () => void,
    disabled = false,
    title = label,
  ) => (
    <button
      type="button"
      className="designer-tool"
      disabled={busy || disabled}
      onClick={action}
      aria-label={label}
      title={title}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
  return (
    <div className="modal-backdrop table-designer-backdrop">
      <section
        className="table-designer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="table-designer-title"
        ref={root}
        onKeyDown={(event) => {
          const command = event.metaKey || event.ctrlKey;
          if (event.key === "Escape") {
            event.preventDefault();
            if (discard) setDiscard(false);
            else dismiss();
            return;
          }
          if (command && event.key.toLowerCase() === "s") {
            event.preventDefault();
            if (!discard) void save();
            return;
          }
          if (!busy && !discard && command) {
            if (["+", "="].includes(event.key)) {
              event.preventDefault();
              addField();
            } else if (event.key === "-") {
              event.preventDefault();
              deleteField();
            } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
              event.preventDefault();
              moveField(event.key === "ArrowUp" ? -1 : 1);
            } else if (
              event.key.toLowerCase() === "k" &&
              event.shiftKey &&
              field
            ) {
              event.preventDefault();
              changeField(field.id, {
                primary: !field.primary,
                notNull: !field.primary || field.notNull,
              });
            } else if (event.key.toLowerCase() === "f") {
              event.preventDefault();
              setPane("Fields");
              window.setTimeout(() => find.current?.focus(), 0);
            }
          }
          if (event.key === "Tab") {
            const elements = Array.from(
              root.current?.querySelectorAll<HTMLElement>(
                'button, input, select, textarea, [tabindex="0"]',
              ) ?? [],
            ).filter(
              (el) =>
                !el.hasAttribute("disabled") &&
                el.getAttribute("tabindex") !== "-1",
            );
            const first = elements[0],
              last = elements.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header className="designer-heading">
          <div className="designer-title-icon">
            <Table2 size={20} />
          </div>
          <div>
            <h2 id="table-designer-title">
              {design.name || "Untitled"}
              <span> — New Table</span>
            </h2>
            <p>
              {session.config.name}
              <span> / </span>
              {database}
              <span> / </span>
              {driver === "mysql"
                ? "MySQL / MariaDB"
                : driver === "postgres"
                  ? "PostgreSQL"
                  : "SQLite"}
            </p>
          </div>
          <button
            className="icon-button"
            aria-label="Close table designer"
            disabled={busy}
            onClick={dismiss}
          >
            <X size={18} />
          </button>
        </header>
        <div className="designer-location">
          <label>
            Table name
            <input
              aria-label="Table name"
              value={design.name}
              placeholder="e.g. customers"
              disabled={busy}
              onChange={(e) => update({ name: e.target.value })}
            />
          </label>
          {driver === "postgres" && (
            <label>
              Schema
              <input
                aria-label="Table schema"
                value={design.schema}
                disabled={busy}
                onChange={(e) => update({ schema: e.target.value })}
              />
            </label>
          )}
          <span className="designer-unsaved">
            {dirty ? "Unsaved design" : "New table"}
          </span>
        </div>
        <div
          className="designer-tabs"
          role="tablist"
          aria-label="Table design sections"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const index =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : (tabs.indexOf(pane) +
                      (event.key === "ArrowRight" ? 1 : -1) +
                      tabs.length) %
                    tabs.length;
            setPane(tabs[index]);
            root.current
              ?.querySelector<HTMLButtonElement>(`[data-pane="${index}"]`)
              ?.focus();
          }}
        >
          {tabs.map((tab, i) => (
            <button
              role="tab"
              data-pane={i}
              id={`designer-tab-${i}`}
              aria-controls="designer-panel"
              aria-selected={pane === tab}
              tabIndex={pane === tab ? 0 : -1}
              key={tab}
              onClick={() => setPane(tab)}
            >
              {tab === "Fields" && <Columns3 size={14} />}
              {tab === "SQL Preview" && <FileCode2 size={14} />}
              {tab}
              {tab === "Fields" && <small>{design.fields.length}</small>}
              {tab === "Indexes" && !!design.indexes.length && (
                <small>{design.indexes.length}</small>
              )}
            </button>
          ))}
        </div>
        <div
          id="designer-panel"
          className="designer-panel"
          role="tabpanel"
          aria-labelledby={`designer-tab-${tabs.indexOf(pane)}`}
        >
          {pane === "Fields" && (
            <>
              <div className="designer-toolbar">
                {toolbar(
                  "Add Field",
                  <Plus size={15} />,
                  () => addField(),
                  design.fields.length >= 256,
                  "Add Field (⌘/Ctrl +)",
                )}
                {toolbar(
                  "Insert Field",
                  <Plus size={15} />,
                  () => addField(true),
                  design.fields.length >= 256,
                )}
                {toolbar(
                  "Delete Field",
                  <Trash2 size={15} />,
                  deleteField,
                  design.fields.length <= 1 || !field,
                  "Delete Field (⌘/Ctrl -)",
                )}
                <span className="designer-tool-divider" />
                {toolbar(
                  "Primary Key",
                  <KeyRound size={15} />,
                  () =>
                    field &&
                    changeField(field.id, {
                      primary: !field.primary,
                      notNull: !field.primary || field.notNull,
                    }),
                  !field,
                  "Primary Key (Shift ⌘/Ctrl K)",
                )}
                {toolbar(
                  "Move Up",
                  <ArrowUp size={15} />,
                  () => moveField(-1),
                  selectedIndex <= 0,
                )}
                {toolbar(
                  "Move Down",
                  <ArrowDown size={15} />,
                  () => moveField(1),
                  selectedIndex >= design.fields.length - 1,
                )}
                <label className="designer-search">
                  <Search size={14} />
                  <input
                    ref={find}
                    aria-label="Find field"
                    placeholder="Find field"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </label>
              </div>
              <div className="designer-grid-scroll">
                <table className="designer-grid">
                  <colgroup>
                    <col style={{ width: 36 }} />
                    <col style={{ minWidth: 160 }} />
                    <col style={{ width: 180 }} />
                    <col style={{ width: 88 }} />
                    <col style={{ width: 88 }} />
                    <col style={{ width: 76 }} />
                    <col style={{ width: 60 }} />
                    {driver !== "sqlite" && <col style={{ minWidth: 180 }} />}
                  </colgroup>
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Length</th>
                      <th>Decimals</th>
                      <th>Not null</th>
                      <th>Key</th>
                      {driver !== "sqlite" && <th>Comment</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {design.fields
                      .filter((f) =>
                        f.name.toLowerCase().includes(search.toLowerCase()),
                      )
                      .map((f) => {
                        const index = design.fields.indexOf(f);
                        return (
                          <tr
                            key={f.id}
                            aria-selected={selected === f.id}
                            onFocus={() => setSelected(f.id)}
                            onClick={() => setSelected(f.id)}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={(event) => {
                              event.preventDefault();
                              if (busy) return;
                              const from = design.fields.findIndex(
                                (item) => item.id === dragging.current,
                              );
                              if (from < 0 || from === index) return;
                              const fields = [...design.fields];
                              const [moved] = fields.splice(from, 1);
                              fields.splice(index, 0, moved);
                              update({ fields });
                              dragging.current = undefined;
                            }}
                          >
                            <td
                              className="designer-row-number"
                              draggable={!busy && !search}
                              onDragStart={(event) => {
                                dragging.current = f.id;
                                event.dataTransfer.setData("text/plain", f.id);
                                event.dataTransfer.effectAllowed = "move";
                              }}
                              onDragEnd={() => {
                                dragging.current = undefined;
                              }}
                              title="Drag to reorder field"
                            >
                              {index + 1}
                            </td>
                            <td>
                              <input
                                data-field-name={f.id}
                                aria-label={`Field ${index + 1} name`}
                                value={f.name}
                                disabled={busy}
                                placeholder="field_name"
                                onChange={(e) =>
                                  changeField(f.id, { name: e.target.value })
                                }
                              />
                            </td>
                            <td>
                              <select
                                aria-label={`Field ${index + 1} type`}
                                value={f.type}
                                disabled={busy}
                                onChange={(e) => {
                                  const type = e.target.value;
                                  changeField(f.id, {
                                    type,
                                    length:
                                      /^(varchar|char|binary|varbinary)$/i.test(
                                        type,
                                      )
                                        ? "255"
                                        : supportsDecimals(type)
                                          ? "10"
                                          : "",
                                    decimals: supportsDecimals(type) ? "2" : "",
                                    autoIncrement:
                                      supportsIdentity(type) && f.autoIncrement,
                                    unsigned:
                                      driver === "mysql" &&
                                      /^(int|bigint|smallint|tinyint|mediumint|decimal|float|double)$/.test(
                                        type,
                                      ) &&
                                      f.unsigned,
                                  });
                                }}
                              >
                                {fieldTypes[driver].map((type) => (
                                  <option key={type}>{type}</option>
                                ))}
                              </select>
                            </td>
                            <td>
                              <input
                                aria-label={`Field ${index + 1} length`}
                                inputMode="numeric"
                                pattern="[0-9]*"
                                value={f.length}
                                disabled={busy || !supportsLength(f.type)}
                                onChange={(e) => {
                                  if (/^\d*$/.test(e.target.value))
                                    changeField(f.id, {
                                      length: e.target.value,
                                    });
                                }}
                              />
                            </td>
                            <td>
                              <input
                                aria-label={`Field ${index + 1} decimals`}
                                inputMode="numeric"
                                pattern="[0-9]*"
                                value={f.decimals}
                                disabled={busy || !supportsDecimals(f.type)}
                                onChange={(e) => {
                                  if (/^\d*$/.test(e.target.value))
                                    changeField(f.id, {
                                      decimals: e.target.value,
                                    });
                                }}
                              />
                            </td>
                            <td className="designer-checkbox-cell">
                              <input
                                type="checkbox"
                                aria-label={`Field ${index + 1} not null`}
                                checked={
                                  f.notNull || f.primary || f.autoIncrement
                                }
                                disabled={busy || f.primary || f.autoIncrement}
                                onChange={(e) =>
                                  changeField(f.id, {
                                    notNull: e.target.checked,
                                  })
                                }
                              />
                            </td>
                            <td className="designer-checkbox-cell">
                              <button
                                type="button"
                                className={`designer-key${f.primary ? " selected" : ""}`}
                                aria-label={`Field ${index + 1} primary key`}
                                aria-pressed={f.primary}
                                disabled={busy}
                                onClick={() =>
                                  changeField(f.id, {
                                    primary: !f.primary,
                                    notNull: !f.primary || f.notNull,
                                  })
                                }
                              >
                                <KeyRound size={15} />
                              </button>
                            </td>
                            {driver !== "sqlite" && (
                              <td>
                                <input
                                  aria-label={`Field ${index + 1} comment`}
                                  value={f.comment}
                                  disabled={busy}
                                  onChange={(e) =>
                                    changeField(f.id, {
                                      comment: e.target.value,
                                    })
                                  }
                                />
                              </td>
                            )}
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
                {!design.fields.some((f) =>
                  f.name.toLowerCase().includes(search.toLowerCase()),
                ) && <p className="designer-empty">No matching fields.</p>}
              </div>
              {field && (
                <div className="designer-properties">
                  <div className="designer-properties-title">
                    <span>Field properties</span>
                    <strong>{field.name || "Unnamed field"}</strong>
                  </div>
                  <div className="designer-property-controls">
                    <label>
                      Default
                      <select
                        aria-label="Default mode"
                        value={field.defaultKind}
                        disabled={busy || field.autoIncrement}
                        onChange={(e) =>
                          changeField(field.id, {
                            defaultKind: e.target
                              .value as DesignField["defaultKind"],
                            defaultValue:
                              e.target.value === "expression"
                                ? "CURRENT_TIMESTAMP"
                                : field.defaultValue,
                          })
                        }
                      >
                        <option value="none">No explicit default</option>
                        <option value="value">Literal value</option>
                        <option
                          value="null"
                          disabled={field.notNull || field.primary}
                        >
                          NULL
                        </option>
                        <option
                          value="expression"
                          disabled={
                            !/^(date|datetime|timestamp|time)/i.test(field.type)
                          }
                        >
                          Date/time expression
                        </option>
                      </select>
                    </label>
                    {field.defaultKind === "value" && (
                      <label>
                        Default value
                        <input
                          aria-label="Default value"
                          value={field.defaultValue}
                          disabled={busy}
                          onChange={(e) =>
                            changeField(field.id, {
                              defaultValue: e.target.value,
                            })
                          }
                          placeholder="Empty text is a valid text default"
                        />
                      </label>
                    )}
                    {field.defaultKind === "expression" && (
                      <label>
                        Expression
                        <select
                          aria-label="Default expression"
                          disabled={busy}
                          value={field.defaultValue}
                          onChange={(e) =>
                            changeField(field.id, {
                              defaultValue: e.target.value,
                            })
                          }
                        >
                          {[
                            "CURRENT_TIMESTAMP",
                            "CURRENT_DATE",
                            "CURRENT_TIME",
                          ].map((value) => (
                            <option key={value}>{value}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className="designer-check">
                      <input
                        type="checkbox"
                        checked={field.autoIncrement}
                        disabled={busy || !supportsIdentity(field.type)}
                        onChange={(e) =>
                          changeField(field.id, {
                            autoIncrement: e.target.checked,
                            primary:
                              e.target.checked && driver !== "postgres"
                                ? true
                                : field.primary,
                            notNull: e.target.checked || field.notNull,
                            defaultKind: e.target.checked
                              ? "none"
                              : field.defaultKind,
                          })
                        }
                      />
                      {driver === "postgres"
                        ? "Identity (auto increment)"
                        : "Auto increment"}
                    </label>
                    {driver === "mysql" && (
                      <label className="designer-check">
                        <input
                          type="checkbox"
                          checked={field.unsigned}
                          disabled={
                            busy ||
                            !/^(int|bigint|smallint|tinyint|mediumint|decimal|float|double)$/.test(
                              field.type,
                            )
                          }
                          onChange={(e) =>
                            changeField(field.id, {
                              unsigned: e.target.checked,
                            })
                          }
                        />
                        Unsigned
                      </label>
                    )}
                    {/^(enum|set)$/i.test(field.type) && (
                      <label className="designer-enum">
                        Values · one per line
                        <textarea
                          aria-label="Enum or set values"
                          rows={3}
                          value={field.values}
                          disabled={busy}
                          onChange={(e) =>
                            changeField(field.id, { values: e.target.value })
                          }
                        />
                      </label>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
          {pane === "Indexes" && (
            <div className="designer-section">
              <div className="designer-section-heading">
                <div>
                  <h3>Indexes</h3>
                  <p>
                    Define normal or unique indexes, including multiple fields.
                  </p>
                </div>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    update({
                      indexes: [
                        ...design.indexes,
                        {
                          id: crypto.randomUUID(),
                          name: `idx_${design.indexes.length + 1}`,
                          unique: false,
                          fields: [],
                        },
                      ],
                    })
                  }
                >
                  <Plus size={14} />
                  Add Index
                </button>
              </div>
              {!design.indexes.length && (
                <div className="designer-empty">
                  <KeyRound size={24} />
                  <strong>No additional indexes</strong>
                  <span>Primary keys are configured in Fields.</span>
                </div>
              )}
              {design.indexes.map((index, i) => (
                <div className="designer-definition" key={index.id}>
                  <div className="designer-definition-heading">
                    <label>
                      Index name
                      <input
                        aria-label={`Index ${i + 1} name`}
                        disabled={busy}
                        value={index.name}
                        onChange={(e) =>
                          update({
                            indexes: design.indexes.map((item) =>
                              item.id === index.id
                                ? { ...item, name: e.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <label className="designer-check">
                      <input
                        type="checkbox"
                        disabled={busy}
                        checked={index.unique}
                        onChange={(e) =>
                          update({
                            indexes: design.indexes.map((item) =>
                              item.id === index.id
                                ? { ...item, unique: e.target.checked }
                                : item,
                            ),
                          })
                        }
                      />
                      Unique
                    </label>
                    <button
                      className="icon-button"
                      aria-label={`Delete index ${i + 1}`}
                      disabled={busy}
                      onClick={() =>
                        update({
                          indexes: design.indexes.filter(
                            (item) => item.id !== index.id,
                          ),
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  {fieldPicker(index.fields, (fields) =>
                    update({
                      indexes: design.indexes.map((item) =>
                        item.id === index.id ? { ...item, fields } : item,
                      ),
                    }),
                  )}
                </div>
              ))}
            </div>
          )}
          {pane === "Foreign Keys" && (
            <div className="designer-section">
              <div className="designer-section-heading">
                <div>
                  <h3>Foreign Keys</h3>
                  <p>
                    Connect fields to a primary or unique key in another table.
                  </p>
                </div>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    update({
                      foreignKeys: [
                        ...design.foreignKeys,
                        {
                          id: crypto.randomUUID(),
                          name: `fk_${design.foreignKeys.length + 1}`,
                          fields: [],
                          referenceSchema:
                            driver === "sqlite" ? "" : design.schema,
                          referenceTable: "",
                          referenceFields: "id",
                          onDelete: "NO ACTION",
                          onUpdate: "NO ACTION",
                        },
                      ],
                    })
                  }
                >
                  <Plus size={14} />
                  Add Foreign Key
                </button>
              </div>
              {!design.foreignKeys.length && (
                <div className="designer-empty">
                  <Table2 size={24} />
                  <strong>No foreign keys</strong>
                  <span>Add a relationship to an existing table.</span>
                </div>
              )}
              {design.foreignKeys.map((fk, i) => {
                const patch = (value: Partial<typeof fk>) =>
                  update({
                    foreignKeys: design.foreignKeys.map((item) =>
                      item.id === fk.id ? { ...item, ...value } : item,
                    ),
                  });
                return (
                  <div className="designer-definition" key={fk.id}>
                    <div className="designer-definition-heading">
                      <label>
                        Name
                        <input
                          aria-label={`Foreign key ${i + 1} name`}
                          value={fk.name}
                          disabled={busy}
                          onChange={(e) => patch({ name: e.target.value })}
                        />
                      </label>
                      <button
                        className="icon-button"
                        aria-label={`Delete foreign key ${i + 1}`}
                        disabled={busy}
                        onClick={() =>
                          update({
                            foreignKeys: design.foreignKeys.filter(
                              (item) => item.id !== fk.id,
                            ),
                          })
                        }
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                    {fieldPicker(fk.fields, (fields) => patch({ fields }))}
                    <div className="designer-property-controls">
                      {driver !== "sqlite" && (
                        <label>
                          Referenced schema
                          <input
                            aria-label={`Foreign key ${i + 1} schema`}
                            value={fk.referenceSchema}
                            disabled={busy}
                            onChange={(e) =>
                              patch({ referenceSchema: e.target.value })
                            }
                          />
                        </label>
                      )}
                      <label>
                        Referenced table
                        <input
                          aria-label={`Foreign key ${i + 1} table`}
                          list="designer-reference-tables"
                          value={fk.referenceTable}
                          disabled={busy}
                          onChange={(e) =>
                            patch({ referenceTable: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        Referenced fields
                        <input
                          aria-label={`Foreign key ${i + 1} referenced fields`}
                          value={fk.referenceFields}
                          disabled={busy}
                          onChange={(e) =>
                            patch({ referenceFields: e.target.value })
                          }
                          placeholder="id, tenant_id"
                        />
                      </label>
                      {(["onDelete", "onUpdate"] as const).map((action) => (
                        <label key={action}>
                          {action === "onDelete" ? "On delete" : "On update"}
                          <select
                            aria-label={`Foreign key ${i + 1} ${action}`}
                            value={fk[action]}
                            disabled={busy}
                            onChange={(e) =>
                              patch({ [action]: e.target.value })
                            }
                          >
                            {[
                              "NO ACTION",
                              "RESTRICT",
                              "CASCADE",
                              "SET NULL",
                            ].map((value) => (
                              <option key={value}>{value}</option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
              <datalist id="designer-reference-tables">
                {session.trees?.[database]?.tables
                  .filter((t) => t.kind === "table")
                  .map((t) => (
                    <option key={`${t.schema}.${t.name}`} value={t.name} />
                  ))}
              </datalist>
            </div>
          )}
          {pane === "Checks" && (
            <div className="designer-section">
              <div className="designer-section-heading">
                <div>
                  <h3>Checks</h3>
                  <p>Require each record to satisfy a SQL condition.</p>
                </div>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() =>
                    update({
                      checks: [
                        ...design.checks,
                        {
                          id: crypto.randomUUID(),
                          name: `chk_${design.checks.length + 1}`,
                          expression: "",
                        },
                      ],
                    })
                  }
                >
                  <Plus size={14} />
                  Add Check
                </button>
              </div>
              {!design.checks.length && (
                <div className="designer-empty">
                  <Columns3 size={24} />
                  <strong>No check constraints</strong>
                  <span>For example: quantity &gt;= 0</span>
                </div>
              )}
              {design.checks.map((check, i) => (
                <div className="designer-definition" key={check.id}>
                  <div className="designer-definition-heading">
                    <label>
                      Name
                      <input
                        aria-label={`Check ${i + 1} name`}
                        value={check.name}
                        disabled={busy}
                        onChange={(e) =>
                          update({
                            checks: design.checks.map((item) =>
                              item.id === check.id
                                ? { ...item, name: e.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <button
                      className="icon-button"
                      aria-label={`Delete check ${i + 1}`}
                      disabled={busy}
                      onClick={() =>
                        update({
                          checks: design.checks.filter(
                            (item) => item.id !== check.id,
                          ),
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <label>
                    Expression
                    <textarea
                      aria-label={`Check ${i + 1} expression`}
                      rows={3}
                      value={check.expression}
                      disabled={busy}
                      placeholder="quantity >= 0"
                      onChange={(e) =>
                        update({
                          checks: design.checks.map((item) =>
                            item.id === check.id
                              ? { ...item, expression: e.target.value }
                              : item,
                          ),
                        })
                      }
                    />
                  </label>
                </div>
              ))}
            </div>
          )}
          {pane === "Options" && (
            <div className="designer-section">
              <h3>Table options</h3>
              <div className="designer-property-controls">
                <label>
                  Storage engine
                  <select
                    aria-label="Storage engine"
                    value={design.engine}
                    disabled={busy}
                    onChange={(e) => update({ engine: e.target.value })}
                  >
                    <option>InnoDB</option>
                  </select>
                </label>
                <label>
                  Character set
                  <select
                    aria-label="Character set"
                    disabled={busy}
                    value={design.charset}
                    onChange={(e) =>
                      update({ charset: e.target.value, collation: "" })
                    }
                  >
                    <option value="">Database default</option>
                    <option value="utf8mb4">utf8mb4</option>
                    <option value="utf8">utf8</option>
                    <option value="latin1">latin1</option>
                  </select>
                </label>
                <label>
                  Collation
                  <input
                    aria-label="Table collation"
                    disabled={busy}
                    value={design.collation}
                    placeholder="Database default"
                    onChange={(e) => update({ collation: e.target.value })}
                  />
                </label>
              </div>
            </div>
          )}
          {pane === "Comment" && (
            <div className="designer-section">
              <h3>Table comment</h3>
              <label>
                Description
                <textarea
                  aria-label="Table comment"
                  rows={8}
                  value={design.comment}
                  disabled={busy}
                  placeholder="Describe the purpose of this table…"
                  onChange={(e) => update({ comment: e.target.value })}
                />
              </label>
            </div>
          )}
          {pane === "SQL Preview" && (
            <div className="designer-section designer-sql">
              <div className="designer-section-heading">
                <h3>SQL Preview</h3>
                <span>{design.name || "new_table"}</span>
              </div>
              <pre aria-label="Create table SQL" tabIndex={0}>
                {validation || sql}
              </pre>
            </div>
          )}
        </div>
        {(error || validation) && (
          <div className="designer-error" role="alert">
            {error || validation}
          </div>
        )}
        <footer className="designer-footer">
          {discard ? (
            <>
              <span role="status">Discard this unsaved table design?</span>
              <button
                className="button secondary"
                onClick={() => setDiscard(false)}
              >
                Keep editing
              </button>
              <button className="button danger" onClick={onClose}>
                Discard design
              </button>
            </>
          ) : (
            <>
              <span>
                {design.fields.length} fields<span> · </span>
                {design.fields.filter((f) => f.primary).length} primary key
                fields
              </span>
              <button
                className="button secondary"
                disabled={busy}
                onClick={dismiss}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={busy || !design.name.trim() || !!validation}
                onClick={() => void save()}
              >
                {busy ? (
                  <Loader2 size={15} className="spin" />
                ) : (
                  <Save size={15} />
                )}
                {busy ? "Creating table…" : "Save"}
                <kbd>⌘S</kbd>
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
