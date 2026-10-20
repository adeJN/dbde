import { useMemo, useState } from "react";
import { AlertTriangle, Copy, Flame, ListTree } from "lucide-react";
import type { TabPlan } from "../types";
import { flattenPlan, parsePlan, type PlanNode } from "../lib/explain";
import { displayValue } from "../lib/sql";

const DRIVER: Record<TabPlan["driver"], string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL/MariaDB",
  sqlite: "SQLite",
};
const METRIC = {
  time: "actual time",
  cost: "estimated cost",
  rows: "estimated rows",
};
function number(value: number | undefined, digits = 0) {
  if (value === undefined) return "—";
  return value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
    minimumFractionDigits: 0,
  });
}
type View = "tree" | "grid" | "raw";

/**
 * The Plan result view: a tree of plan nodes with the costliest highlighted and full
 * scans flagged, the server's tabular output when it has one, and the raw document.
 */
export default function PlanView({
  plan,
  onCopy,
}: {
  plan: TabPlan;
  onCopy: (text: string) => Promise<void>;
}) {
  const parsed = useMemo(() => {
    try {
      return { plan: parsePlan(plan.output, plan.driver) };
    } catch (cause) {
      return { error: String(cause) };
    }
  }, [plan]);
  const [view, setView] = useState<View>("tree");
  const [selectedId, setSelectedId] = useState<string>();
  const [status, setStatus] = useState("");
  const result = parsed.plan;
  const rows = result ? flattenPlan(result.roots) : [];
  const selected = rows.find((row) => row.node.id === selectedId)?.node;
  const raw = result?.raw ?? plan.output.raw;
  const views: [View, string][] = [
    ["tree", "Tree"],
    ...(result?.grid ? ([["grid", "Grid"]] as [View, string][]) : []),
    ["raw", "Raw"],
  ];
  const current = parsed.error && view === "tree" ? "raw" : view;
  const analyzedLabel = plan.output.analyzed
    ? plan.output.rolled_back
      ? "Analyzed · rolled back"
      : "Analyzed"
    : "Estimated";
  return (
    <section className="plan-view" aria-label="Query plan">
      <header className="plan-header">
        <div className="plan-title">
          <ListTree size={15} />
          <strong>Query plan</strong>
          <span className="plan-badge">{DRIVER[plan.driver]}</span>
          <span
            className={`plan-badge${plan.output.analyzed ? " analyzed" : ""}`}
          >
            {analyzedLabel}
          </span>
        </div>
        <dl className="plan-totals">
          {result?.planningMs !== undefined && (
            <div>
              <dt>Planning</dt>
              <dd>{number(result.planningMs, 3)} ms</dd>
            </div>
          )}
          {result?.executionMs !== undefined && (
            <div>
              <dt>Execution</dt>
              <dd>{number(result.executionMs, 3)} ms</dd>
            </div>
          )}
          {result?.totalCost !== undefined && (
            <div>
              <dt>Total cost</dt>
              <dd>{number(result.totalCost, 2)}</dd>
            </div>
          )}
          <div>
            <dt>Round trip</dt>
            <dd>{number(plan.output.execution_ms, 1)} ms</dd>
          </div>
        </dl>
        <div className="plan-tabs" role="tablist" aria-label="Plan view">
          {views.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              id={`plan-tab-${id}`}
              aria-selected={current === id}
              aria-controls="plan-panel"
              className={current === id ? "active" : ""}
              onClick={() => setView(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      {result && result.warnings.length > 0 && (
        <ul className="plan-warnings" aria-label="Plan warnings">
          {result.warnings.map((warning) => (
            <li key={warning}>
              <AlertTriangle size={13} aria-hidden="true" />
              {warning}
            </li>
          ))}
        </ul>
      )}
      {parsed.error && (
        <div className="form-message error" role="alert">
          Cannot read this plan ({parsed.error}). The raw output is shown below.
        </div>
      )}
      <div
        className="plan-panel"
        id="plan-panel"
        role="tabpanel"
        aria-labelledby={`plan-tab-${current}`}
      >
        {current === "tree" && result && (
          <>
            {result.metric && (
              <p className="plan-note">
                Highlighting by {METRIC[result.metric]}
                {result.metric === "time" ? " (each node's own share)" : ""}.
              </p>
            )}
            <div className="plan-tree-scroll">
              <table className="plan-tree" aria-label="Plan tree">
                <thead>
                  <tr>
                    <th scope="col">Operation</th>
                    <th scope="col">Object</th>
                    <th scope="col">Index</th>
                    <th scope="col" className="numeric">
                      Est. rows
                    </th>
                    {result.analyzed && (
                      <>
                        <th scope="col" className="numeric">
                          Actual rows
                        </th>
                        <th scope="col" className="numeric">
                          Loops
                        </th>
                      </>
                    )}
                    <th scope="col" className="numeric">
                      Cost
                    </th>
                    {result.analyzed && (
                      <th scope="col" className="numeric">
                        Time (ms)
                      </th>
                    )}
                    {result.metric && (
                      <th scope="col" className="numeric">
                        Share
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ node, depth }) => (
                    <PlanRow
                      key={node.id}
                      node={node}
                      depth={depth}
                      analyzed={result.analyzed}
                      showShare={!!result.metric}
                      selected={node.id === selectedId}
                      onSelect={() =>
                        setSelectedId(
                          node.id === selectedId ? undefined : node.id,
                        )
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
            {selected && (
              <aside className="plan-details" aria-label="Node details">
                <h4>{selected.operation}</h4>
                <dl>
                  {selected.condition && (
                    <div>
                      <dt>Condition</dt>
                      <dd>{selected.condition}</dd>
                    </div>
                  )}
                  {selected.warnings.map((warning) => (
                    <div key={warning}>
                      <dt>Warning</dt>
                      <dd>{warning}</dd>
                    </div>
                  ))}
                  {selected.details.map(([key, value], index) => (
                    <div key={`${key}:${index}`}>
                      <dt>{key}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                </dl>
              </aside>
            )}
          </>
        )}
        {current === "grid" && result?.grid && (
          <div className="plan-tree-scroll">
            <table className="plan-grid" aria-label="Plan output">
              <thead>
                <tr>
                  {result.grid.columns.map((column) => (
                    <th scope="col" key={column}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.grid.rows.map((row, index) => (
                  <tr key={index}>
                    {row.map((value, column) => (
                      <td key={column}>
                        {value == null ? "NULL" : displayValue(value)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {current === "raw" && (
          <pre className="plan-raw" tabIndex={0} aria-label="Raw plan">
            {raw}
          </pre>
        )}
      </div>
      <footer className="plan-footer">
        <code title={plan.output.sql}>{plan.output.sql}</code>
        {status && (
          <span role="status" className="plan-status">
            {status}
          </span>
        )}
        <button
          className="button subtle"
          onClick={async () => {
            try {
              await onCopy(raw);
              setStatus("Raw plan copied.");
            } catch (cause) {
              setStatus(String(cause));
            }
          }}
        >
          <Copy size={13} /> Copy raw
        </button>
      </footer>
    </section>
  );
}
function PlanRow({
  node,
  depth,
  analyzed,
  showShare,
  selected,
  onSelect,
}: {
  node: PlanNode;
  depth: number;
  analyzed: boolean;
  showShare: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const percent = Math.round(node.share * 100);
  return (
    <tr
      className={
        [
          node.expensive ? "plan-expensive" : "",
          node.warnings.length ? "plan-warning" : "",
          selected ? "selected" : "",
        ]
          .filter(Boolean)
          .join(" ") || undefined
      }
      aria-selected={selected}
    >
      <td>
        <button
          className="plan-operation"
          style={{ paddingLeft: 6 + depth * 16 }}
          aria-expanded={selected}
          aria-label={`${node.operation}${node.object ? ` on ${node.object}` : ""}${node.expensive ? ", expensive" : ""}${node.warnings.length ? `, warning: ${node.warnings.join("; ")}` : ""}`}
          onClick={onSelect}
        >
          {depth > 0 && <span className="plan-branch" aria-hidden="true" />}
          <span className="plan-operation-text">{node.operation}</span>
          {node.expensive && (
            <span className="plan-flag expensive" aria-hidden="true">
              <Flame size={11} /> Expensive
            </span>
          )}
          {node.warnings.length > 0 && (
            <span
              className="plan-flag warning"
              aria-hidden="true"
              title={node.warnings.join("\n")}
            >
              <AlertTriangle size={11} />
              {node.warnings[0].startsWith("Full table scan")
                ? "Full scan"
                : "Check"}
            </span>
          )}
        </button>
      </td>
      <td>{node.object ?? ""}</td>
      <td>{node.index ?? ""}</td>
      <td className="numeric">{number(node.estimatedRows)}</td>
      {analyzed && (
        <>
          <td className="numeric">{number(node.actualRows)}</td>
          <td className="numeric">{number(node.loops)}</td>
        </>
      )}
      <td className="numeric">{number(node.cost, 2)}</td>
      {analyzed && <td className="numeric">{number(node.time, 3)}</td>}
      {showShare && (
        <td className="numeric plan-share">
          <span className="plan-share-bar" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </span>
          {percent}%
        </td>
      )}
    </tr>
  );
}
