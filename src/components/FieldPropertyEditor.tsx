import type { ColumnInfo } from "../types";
import type { StructureField } from "../lib/table-structure";
import {
  initialDefault,
  initialFieldType,
  numericType,
  textType,
  type FieldPatch,
} from "../lib/field-changes";

export default function FieldPropertyEditor({
  column,
  detail,
  patch,
  enabled,
  busy,
  onChange,
}: {
  column: ColumnInfo;
  detail?: StructureField;
  patch: FieldPatch;
  enabled: boolean;
  busy: boolean;
  onChange: (patch: FieldPatch) => void;
}) {
  const type = patch.data_type ?? initialFieldType(column, detail);
  const def = patch.default ?? initialDefault(detail);
  const generated = patch.generated ?? detail?.generated ?? false;
  const disabled = !enabled || busy;
  const charset = patch.charset ?? detail?.charset ?? "";
  const collation = patch.collation ?? detail?.collation ?? "";
  const charsets = Array.from(
    new Set(
      ["utf8mb4", "utf8", "latin1", "ascii", "binary", charset].filter(Boolean),
    ),
  );
  return (
    <div className="structure-property-form">
      <label>
        Default
        <select
          aria-label="Field default mode"
          value={def.kind}
          disabled={
            disabled ||
            generated ||
            (patch.auto_increment ?? detail?.auto_increment)
          }
          onChange={(event) =>
            onChange({
              default: {
                kind: event.target.value as typeof def.kind,
                value:
                  event.target.value === "expression"
                    ? "CURRENT_TIMESTAMP"
                    : def.value,
              },
            })
          }
        >
          <option value="none">No explicit default</option>
          <option value="null">NULL</option>
          <option value="value">Literal value</option>
          <option value="expression">Expression</option>
        </select>
      </label>
      <label>
        Default Value
        {def.kind === "expression" ? (
          <select
            aria-label="Field default expression"
            value={def.value}
            disabled={disabled || generated}
            onChange={(event) =>
              onChange({ default: { ...def, value: event.target.value } })
            }
          >
            {Array.from(
              new Set([
                "CURRENT_TIMESTAMP",
                "CURRENT_DATE",
                "CURRENT_TIME",
                def.value,
              ]),
            )
              .filter(Boolean)
              .map((value) => (
                <option key={value}>{value}</option>
              ))}
          </select>
        ) : (
          <input
            aria-label="Field default value"
            readOnly={disabled || def.kind !== "value" || generated}
            value={
              def.kind === "null"
                ? "NULL"
                : def.kind === "none"
                  ? "No explicit default"
                  : def.value
            }
            onChange={(event) =>
              onChange({ default: { ...def, value: event.target.value } })
            }
          />
        )}
      </label>
      <label>
        Character Set
        <select
          aria-label="Field character set"
          value={charset}
          disabled={disabled || !textType(type.name)}
          onChange={(event) =>
            onChange({ charset: event.target.value, collation: "" })
          }
        >
          <option value="">Database default / not applicable</option>
          {charsets.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      </label>
      <label>
        Collation
        <input
          aria-label="Field collation"
          readOnly={disabled || !textType(type.name)}
          value={collation}
          placeholder="Database default"
          list="structure-collation-values"
          onChange={(event) => onChange({ collation: event.target.value })}
        />
        <datalist id="structure-collation-values">
          {Array.from(
            new Set([
              collation,
              `${charset || "utf8mb4"}_general_ci`,
              `${charset || "utf8mb4"}_bin`,
              "utf8mb4_unicode_ci",
            ]),
          )
            .filter(Boolean)
            .map((name) => (
              <option key={name} value={name} />
            ))}
        </datalist>
      </label>
      <label className="structure-property-check">
        <input
          type="checkbox"
          aria-label="Binary"
          checked={/^(?:binary)$|_bin$/i.test(collation)}
          disabled={disabled || !textType(type.name)}
          onChange={(event) =>
            onChange({
              collation: event.target.checked
                ? charset === "binary"
                  ? "binary"
                  : `${charset || "utf8mb4"}_bin`
                : "",
            })
          }
        />
        Binary
      </label>
      {numericType(type.name) && (
        <>
          <label className="structure-property-check">
            <input
              type="checkbox"
              aria-label="Unsigned"
              disabled={disabled}
              checked={type.unsigned}
              onChange={(event) =>
                onChange({
                  data_type: {
                    ...type,
                    unsigned: event.target.checked,
                    zerofill: event.target.checked && type.zerofill,
                  },
                })
              }
            />
            Unsigned
          </label>
          <label className="structure-property-check">
            <input
              type="checkbox"
              aria-label="Zerofill"
              disabled={disabled}
              checked={type.zerofill}
              onChange={(event) =>
                onChange({
                  data_type: {
                    ...type,
                    zerofill: event.target.checked,
                    unsigned: event.target.checked || type.unsigned,
                  },
                })
              }
            />
            Zerofill
          </label>
        </>
      )}
      {/^(?:tinyint|smallint|mediumint|int|integer|bigint)$/i.test(
        type.name,
      ) && (
        <label className="structure-property-check">
          <input
            type="checkbox"
            aria-label="Auto increment"
            disabled={disabled || generated}
            checked={patch.auto_increment ?? detail?.auto_increment ?? false}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? {
                      auto_increment: true,
                      not_null: true,
                      default: { kind: "none", value: "" },
                    }
                  : { auto_increment: false },
              )
            }
          />
          Auto increment
        </label>
      )}
      {generated && (
        <>
          <label>
            Storage
            <select
              aria-label="Generated storage"
              disabled={disabled}
              value={(patch.stored ?? detail?.stored) ? "stored" : "virtual"}
              onChange={(event) =>
                onChange({ stored: event.target.value === "stored" })
              }
            >
              <option value="virtual">VIRTUAL</option>
              <option value="stored">STORED</option>
            </select>
          </label>
          <label>
            Expression
            <textarea
              aria-label="Generated expression"
              disabled={disabled}
              value={patch.expression ?? detail?.expression ?? ""}
              rows={2}
              onChange={(event) => onChange({ expression: event.target.value })}
              placeholder="quantity * price"
            />
          </label>
        </>
      )}
      {["enum", "set"].includes(type.name) && (
        <label>
          Allowed values
          <textarea
            aria-label="Field allowed values"
            disabled={disabled}
            rows={3}
            value={type.values.join("\n")}
            placeholder="One value per line"
            onChange={(event) =>
              onChange({
                data_type: { ...type, values: event.target.value.split("\n") },
              })
            }
          />
        </label>
      )}
    </div>
  );
}
