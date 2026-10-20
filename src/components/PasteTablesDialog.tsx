import { useEffect, useRef, useState } from "react";
import { Copy, Loader2, X } from "lucide-react";
import type { Session, TableInfo } from "../types";
import { suggestTableName, type TableClipboard } from "../lib/table-clipboard";
import * as api from "../lib/api";

export default function PasteTablesDialog({
  source,
  target,
  database,
  onClose,
  onDone,
}: {
  source: TableClipboard;
  target: Session;
  database: string;
  onClose: () => void;
  onDone: (count: number) => void;
}) {
  const [items, setItems] = useState(
    source.tables.map((table) => ({ table, name: table.name, copied: false })),
  );
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [data, setData] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true;
    const previous = document.activeElement as HTMLElement | null;
    api
      .schema(target.id, database)
      .then((tree) => {
        if (!active) return;
        const used = new Set(tree.tables.map((table) => table.name));
        const next = source.tables.map((table) => {
          const name = suggestTableName(table.name, used, target.config.driver);
          used.add(name);
          return { table, name, copied: false };
        });
        setItems(next);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      previous?.isConnected && previous.focus();
    };
  }, [source, target.id, database, target.config.driver]);
  async function paste() {
    if (busyRef.current || loading) return;
    const current = itemsRef.current;
    const names = current.map((item) => item.name.trim());
    const limit =
      target.config.driver === "mysql"
        ? 64
        : target.config.driver === "postgres"
          ? 63
          : 128;
    const normalized =
      target.config.driver === "mysql"
        ? names.map((name) => name.toLowerCase())
        : names;
    if (
      names.some(
        (name) =>
          !name ||
          name.includes("\0") ||
          new TextEncoder().encode(name).length > limit,
      ) ||
      new Set(normalized).size !== names.length
    ) {
      setError(
        "Choose a nonempty, unique name within the database identifier length limit for each target table.",
      );
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    let copied = current.filter((item) => item.copied).length;
    try {
      for (let index = 0; index < current.length; index++) {
        const item = current[index];
        if (item.copied) continue;
        const destination: TableInfo = {
          name: names[index],
          schema:
            target.config.driver === "mysql" ? database : item.table.schema,
          kind: "table",
        };
        await api.pasteTable(
          source.connectionId,
          source.database,
          item.table,
          target.id,
          database,
          destination,
          data,
        );
        copied++;
        const next = itemsRef.current.map((row, rowIndex) =>
          rowIndex === index
            ? { ...row, name: names[index], copied: true }
            : row,
        );
        itemsRef.current = next;
        setItems(next);
      }
      onDone(copied);
    } catch (cause) {
      setError(
        `${copied} of ${current.length} tables copied. ${String(cause)} Already copied tables are skipped when retrying.`,
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) =>
        event.target === event.currentTarget && !busy && onClose()
      }
    >
      <section
        ref={root}
        className="modal paste-tables-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="paste-tables-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.stopPropagation();
            onClose();
          }
          if (event.key === "Tab") {
            const nodes = root.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled)",
            );
            if (!nodes?.length) return;
            if (event.shiftKey && document.activeElement === nodes[0]) {
              event.preventDefault();
              nodes[nodes.length - 1].focus();
            } else if (
              !event.shiftKey &&
              document.activeElement === nodes[nodes.length - 1]
            ) {
              event.preventDefault();
              nodes[0].focus();
            }
          }
        }}
      >
        <header>
          <div className="modal-icon">
            <Copy size={23} />
          </div>
          <button
            autoFocus
            className="icon-button"
            aria-label="Close paste dialog"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <h2 id="paste-tables-title">Paste tables</h2>
        <p>
          From {source.database} → {target.config.name} / {database}
        </p>
        {loading ? (
          <p role="status">Loading destination tables…</p>
        ) : (
          <fieldset disabled={busy} className="table-tools-fields">
            <div className="paste-table-names">
              {items.map((item, index) => (
                <label key={`${item.table.schema}.${item.table.name}`}>
                  {item.table.name} →
                  <input
                    aria-label={`Target name for ${item.table.name}`}
                    value={item.name}
                    disabled={item.copied}
                    onChange={(event) =>
                      setItems((old) =>
                        old.map((row, rowIndex) =>
                          rowIndex === index
                            ? { ...row, name: event.target.value }
                            : row,
                        ),
                      )
                    }
                  />
                  {item.copied && <small className="success">Copied</small>}
                </label>
              ))}
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={data}
                disabled={items.some((item) => item.copied)}
                onChange={(event) => setData(event.target.checked)}
              />
              Include all records
            </label>
            <p>
              Creates new tables without replacing existing tables. Columns and
              indexes are copied; triggers, permissions and external
              relationships require separate review.
            </p>
          </fieldset>
        )}
        {error && (
          <p role="alert" className="form-message error">
            {error}
          </p>
        )}
        <footer>
          <button
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || loading}
            onClick={() => void paste()}
          >
            {busy && <Loader2 size={14} className="spin" />}
            {busy ? "Copying…" : "Paste tables"}
          </button>
        </footer>
      </section>
    </div>
  );
}
