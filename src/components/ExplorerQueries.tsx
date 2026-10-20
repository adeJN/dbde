import { useState } from "react";
import { ChevronDown, ChevronRight, FileCode2, ListTree } from "lucide-react";
import type { SavedQuery } from "../lib/saved-queries";

/** The "Queries" group under a database in the explorer, like Navicat's. */
export default function ExplorerQueries({
  database,
  queries,
  search,
  onOpen,
  onManage,
}: {
  database: string;
  queries: SavedQuery[];
  /** Normalised explorer search term; matching queries show expanded. */
  search: string;
  onOpen: (query: SavedQuery) => void;
  onManage: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const visible = search
    ? queries.filter((query) => query.name.toLowerCase().includes(search))
    : queries;
  if (!queries.length || (search && !visible.length)) return null;
  const open = expanded || !!search;
  const sorted = [...visible].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="explorer-queries">
      <div className="tree-section explorer-queries-heading">
        <button
          className="explorer-queries-toggle"
          aria-expanded={open}
          aria-label={`Queries in ${database}`}
          onClick={() => setExpanded(!expanded)}
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          Queries <span>{visible.length}</span>
        </button>
        <button
          className="icon-button"
          aria-label={`Manage saved queries in ${database}`}
          title="Manage saved queries"
          onClick={onManage}
        >
          <ListTree size={12} />
        </button>
      </div>
      {open &&
        sorted.map((query) => (
          <div className="table-node" key={query.id}>
            <button
              className="table-name"
              title={query.description || query.name}
              onClick={() => onOpen(query)}
            >
              <FileCode2 size={13} />
              <span>{query.name}</span>
            </button>
          </div>
        ))}
    </div>
  );
}
