import DatabaseObjectError from "./DatabaseObjectError";
import { useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  ChevronRight,
  Hash,
  Layers2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  SquareFunction,
  Workflow,
  Zap,
} from "lucide-react";
import type { DbObject, ObjectKind, Session } from "../types";
import {
  OBJECT_LABELS,
  matchesObject,
  objectKey,
  objectKinds,
  objectLabel,
} from "../lib/db-objects";
import { useDbObjects } from "../hooks/useDbObjects";
import AreaContextMenu, { type AreaMenu } from "./AreaContextMenu";
import {
  defaultObjectAction,
  objectMenuItems,
  type ObjectAction,
} from "./objectMenu";

export function ObjectIcon({
  kind,
  size = 13,
}: {
  kind: ObjectKind;
  size?: number;
}) {
  if (kind === "function") return <SquareFunction size={size} />;
  if (kind === "procedure") return <Workflow size={size} />;
  if (kind === "trigger") return <Zap size={size} />;
  if (kind === "event") return <CalendarClock size={size} />;
  if (kind === "sequence") return <Hash size={size} />;
  return <Layers2 size={size} />;
}

/** Groups for routines, triggers, events, sequences and materialized views under a database. */
export default function ExplorerObjects({
  session,
  database,
  search,
  onAction,
  onNew,
}: {
  session: Session;
  database: string;
  /** Normalised explorer search term; loaded groups with matches show expanded. */
  search: string;
  onAction: (object: DbObject, action: ObjectAction) => void;
  onNew: (kind: ObjectKind) => void;
}) {
  return (
    <>
      {objectKinds(session.config.driver).map((kind) => (
        <ExplorerObjectGroup
          key={kind}
          session={session}
          database={database}
          kind={kind}
          search={search}
          onAction={onAction}
          onNew={() => onNew(kind)}
        />
      ))}
    </>
  );
}
function ExplorerObjectGroup({
  session,
  database,
  kind,
  search,
  onAction,
  onNew,
}: {
  session: Session;
  database: string;
  kind: ObjectKind;
  search: string;
  onAction: (object: DbObject, action: ObjectAction) => void;
  onNew: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [menu, setMenu] = useState<AreaMenu | null>(null);
  const { objects, loading, error, reload } = useDbObjects(
    session,
    database,
    kind,
    expanded,
  );
  const visible = (objects ?? []).filter((object) =>
    matchesObject(object, search),
  );
  // While searching, a loaded group without matches is hidden; unloaded groups stay
  // collapsed so the search never fires a catalog query per database and kind.
  if (search && objects && !visible.length) return null;
  const open = expanded || (!!search && visible.length > 0);
  const label = OBJECT_LABELS[kind];
  function showMenu(
    object: DbObject,
    trigger: HTMLElement,
    x?: number,
    y?: number,
  ) {
    const rect = trigger.getBoundingClientRect();
    setMenu({
      x: x ?? rect.left + 16,
      y: y ?? rect.bottom,
      trigger,
      label: `${objectLabel(object)} actions`,
      items: objectMenuItems(object, session.config.driver, (action) =>
        onAction(object, action),
      ),
    });
  }
  return (
    <div className="explorer-objects" data-object-kind={kind}>
      <div className="tree-section explorer-queries-heading">
        <button
          className="explorer-queries-toggle"
          aria-expanded={open}
          aria-label={`${label.many} in ${database}`}
          onClick={() => setExpanded(!open)}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {label.many}{" "}
          <span>
            {objects ? (search ? visible.length : objects.length) : "—"}
          </span>
        </button>
        <span className="explorer-objects-actions">
          <button
            className="icon-button"
            aria-label={`New ${label.one.toLowerCase()} in ${database}`}
            title={`New ${label.one}`}
            onClick={onNew}
          >
            <Plus size={12} />
          </button>
          {objects && (
            <button
              className="icon-button"
              aria-label={`Refresh ${label.many.toLowerCase()} in ${database}`}
              disabled={loading}
              onClick={() => void reload()}
            >
              <RefreshCw size={12} className={loading ? "spin" : ""} />
            </button>
          )}
        </span>
      </div>
      {open && (
        <>
          {loading && !objects && (
            <div className="empty-inline" role="status">
              Loading {label.many.toLowerCase()}…
            </div>
          )}
          {error && (
            <DatabaseObjectError
              error={error}
              onRetry={() => void reload()}
              compact
            />
          )}
          {objects && !objects.length && !error && (
            <div className="empty-inline">No {label.many.toLowerCase()}.</div>
          )}
          {visible.map((object) => (
            <div
              className="table-node object-node"
              key={objectKey(object)}
              onContextMenu={(event) => {
                event.preventDefault();
                showMenu(
                  object,
                  event.currentTarget.querySelector<HTMLElement>(
                    ".table-name",
                  )!,
                  event.clientX,
                  event.clientY,
                );
              }}
            >
              <button
                className="table-name"
                title={[
                  object.schema
                    ? `${object.schema}.${objectLabel(object)}`
                    : objectLabel(object),
                  object.table ? `on ${object.table}` : "",
                  object.detail ?? "",
                  object.status ?? "",
                ]
                  .filter(Boolean)
                  .join(" · ")}
                onClick={() => onAction(object, defaultObjectAction(object))}
                onKeyDown={(event) => {
                  if (
                    event.key === "ContextMenu" ||
                    (event.shiftKey && event.key === "F10")
                  ) {
                    event.preventDefault();
                    showMenu(object, event.currentTarget);
                  }
                }}
              >
                <ObjectIcon kind={kind} />
                <span>{objectLabel(object)}</span>
                <span className="node-kind">
                  {object.status === "DISABLED"
                    ? "disabled"
                    : object.flag === "trigger"
                      ? "trigger"
                      : (object.table ?? "")}
                </span>
              </button>
              <button
                className="tiny-button table-actions"
                aria-label={`Actions for ${objectLabel(object)}`}
                aria-haspopup="menu"
                onClick={(event) => showMenu(object, event.currentTarget)}
              >
                <MoreHorizontal size={12} />
              </button>
            </div>
          ))}
        </>
      )}
      {menu && <AreaContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
