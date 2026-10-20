import { useEffect, useRef, useState } from "react";
import { editorSearchShortcut } from "../lib/editor-search";
import { Keyboard, Search, X } from "lucide-react";
import { libraryShortcutLabel } from "../lib/library-shortcuts";
import { gridViewToggleLabel } from "../lib/grid-layout";
import {
  isMacPlatform,
  tableShortcutLabel,
  type TableShortcut,
} from "../lib/table-shortcuts";

export default function HelpDialog({ onClose }: { onClose: () => void }) {
  const root = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const mac = isMacPlatform();
  const command = mac ? "⌘" : "Ctrl+";
  const shortcut = (action: TableShortcut) => tableShortcutLabel(action, mac);
  const groups: { title: string; note: string; rows: [string, string][] }[] = [
    {
      title: "Table list",
      note: "Click a database to open its table list. Shortcuts apply while the list has focus.",
      rows: [
        ["Select a table", "↑ / ↓ / Home / End"],
        ["Select a range", "Shift+↑ / ↓"],
        ["Select individual tables", `${command}Click`],
        ["Select all filtered tables", shortcut("all")],
        ["Open table", "Enter / Double-click"],
        ["Copy selected tables", shortcut("copy")],
        ["Paste tables into this database", shortcut("paste")],
        ["New table", shortcut("new")],
        ["Design table", shortcut("design")],
        ["Rename table", "F2"],
        ...(mac
          ? ([
              ["Duplicate table", shortcut("duplicate")],
              ["Transfer records", shortcut("transfer")],
            ] as [string, string][])
          : []),
        ["New query", shortcut("query")],
        ["Refresh table list", shortcut("refresh")],
        ["Find tables", shortcut("find")],
        [
          "Request deletion of one selected table",
          `Delete / ${command}Backspace`,
        ],
        ["Clear selection", "Esc"],
        ["Open table actions", "Shift+F10 / Menu key / Right-click"],
        [
          "Maintain selected tables (Analyze, Check, Vacuum…)",
          "Table actions › Maintain › →",
        ],
      ],
    },
    {
      title: "Database objects",
      note: "Functions, procedures, triggers, events, sequences and materialized views, under each database in the navigation pane and as tabs above the table list. Shortcuts apply while an object list has focus.",
      rows: [
        ["Switch object type (Tables, Functions, …)", "← / → on the type tabs"],
        ["Select an object", "↑ / ↓ / Home / End"],
        [
          "View definition (materialized views: open data)",
          "Enter / Double-click",
        ],
        ["Edit in a SQL tab (replace script)", shortcut("design")],
        ["New object from a template", shortcut("new")],
        ["Copy quoted object name", shortcut("copy")],
        ["Request drop with SQL preview", `Delete / ${command}Backspace`],
        ["Refresh object list", shortcut("refresh")],
        ["Find objects", shortcut("find")],
        ["Open object actions", "Shift+F10 / Menu key / Right-click"],
      ],
    },
    {
      title: "Data grid",
      note: "Focus a cell first. Editing, pasting and record actions require an editable table; query results are read-only.",
      rows: [
        [
          "Find in table (highlight current page)",
          editorSearchShortcut("find"),
        ],
        [
          "Find and replace in table (current page)",
          editorSearchShortcut("replace"),
        ],
        ["Next / previous table match (Find focused)", "Enter / Shift+Enter"],
        ["Close table Find", "Esc / Done"],
        ["Move between cells", "↑ ↓ ← → / Tab / Shift+Tab"],
        ["Move by a screen of rows", "Page Up / Page Down"],
        ["First / last column", `${command}← / →`],
        ["First / last row on page", `${command}↑ / ↓`],
        ["Start / end of grid", `${command}Home / End`],
        ["Select a block", "Shift+← / → / Shift+Click / Drag"],
        [
          "Select / extend selected rows",
          "Click row number / Drag / Shift+Click / Space / Shift+↑ / ↓",
        ],
        ["Select all rows on page", `${command}A`],
        ["Copy cell, block or selected rows", `${command}C`],
        ["Paste a value or block", `${command}V`],
        ["Edit cell", "Type / Enter / F2 / Double-click"],
        ["Open record details", "Shift+Enter"],
        [
          "Open date/time, list (ENUM, SET, boolean) or foreign key picker",
          `${mac ? "⌥↓" : "Alt+↓"} / ▾ button in the editing cell`,
        ],
        [
          "Choose a referenced row (Select from table…)",
          "Picker › Select from… / link button · Enter or double-click picks",
        ],
        ["Save pending changes", `${command}S`],
        [
          "Go to new record row",
          `${command}+ / Insert / ${command}N / ${command}I`,
        ],
        ["Design current table", `${command}D`],
        ["Duplicate rows as new records", `${command}Shift+D`],
        ["Save new records", `${command}Enter`],
        [
          "Request deletion of records",
          `${command}Delete / ${command}Backspace`,
        ],
        ["Discard changed record / clear selection", "Esc"],
        ["Open cell actions", "Shift+F10 / Menu key / Right-click"],
        ["Switch between Grid and Form view", gridViewToggleLabel(mac)],
        ["Show or hide columns", "Columns button / Header menu › Hide Column"],
        [
          "Freeze or unfreeze a column",
          "Header menu › Freeze Column / Unfreeze All",
        ],
      ],
    },
    {
      title: "Form view",
      note: "One record at a time. Changes are saved when you move to another record, like in the grid.",
      rows: [
        ["Previous / next record", "Page Up / Page Down"],
        ["First / last record on page", `${command}Page Up / Page Down`],
        ["Save pending changes", `${command}S`],
        ["Discard the record's changes", "Esc"],
        ["Set a field to NULL", "NULL checkbox"],
        [
          "Pick a date/time or a referenced row",
          `${mac ? "⌥↓" : "Alt+↓"} / button next to the field`,
        ],
        ["Back to Grid view", gridViewToggleLabel(mac)],
      ],
    },
    {
      title: "While editing a cell",
      note: "These keys apply inside the cell editor. Date/time pickers keep the stored text format, fractional seconds and UTC offset; Now uses this computer's clock (and its offset for time zone columns). Picked values are staged like typed ones.",
      rows: [
        ["Finish edit and move down", "Enter"],
        ["Finish edit and move right / left", "Tab / Shift+Tab"],
        ["Set value to NULL", `${command}Shift+Backspace`],
        ["Save cell and stay", `${command}Enter`],
        ["Expand cell editor", "Shift+Enter"],
        ["Open the cell's picker", mac ? "⌥↓" : "Alt+↓"],
        ["Pick a value in the picker and move down / right", "Enter / Tab"],
        ["Close the picker (back to typing)", "Esc"],
        ["Cancel edit", "Esc"],
      ],
    },
    {
      title: "Query & tabs",
      note: "Run SQL from the query editor. Use the tab strip to manage open tabs.",
      rows: [
        ["Run query or selected SQL", `${command}Enter`],
        [
          "Explain statement under cursor or selection (SQL editor focused)",
          mac ? "⇧⌘E" : "Ctrl+Shift+E",
        ],
        ["Find in SQL", editorSearchShortcut("find")],
        ["Find and replace in SQL", editorSearchShortcut("replace")],
        ["Next / previous match (Find input focused)", "Enter / Shift+Enter"],
        ["Close Find & Replace (editor focused)", "Esc"],
        ["Rename query tab", "Double-click its name"],
        ["Select previous / next tab (tab focused)", "← / →"],
        ["Select first / last tab (tab focused)", "Home / End"],
        ["Close focused tab", `${command}W / Middle-click`],
        ["Reorder tabs", "Drag tab"],
        ["Scroll through tabs", "Mouse wheel / Trackpad"],
        ["Open tab actions", "Shift+F10 / Menu key / Right-click"],
      ],
    },
    {
      title: "Query library",
      note: "History records SQL run from the editor (turn it off in the History panel). Saved queries appear under each database in the explorer.",
      rows: [
        ["Save query (SQL editor focused)", `${command}S`],
        ["Save query as (SQL editor focused)", `${command}Shift+S`],
        ["Query history", libraryShortcutLabel("history", mac)],
        ["Saved queries", libraryShortcutLabel("queries", mac)],
        ["Insert a snippet", "Type its prefix, then Enter / Tab"],
        ["Next / previous snippet placeholder", "Tab / Shift+Tab"],
      ],
    },
  ];
  const term = query.trim().toLowerCase();
  const filtered = groups
    .map((group) => ({
      ...group,
      rows: group.rows.filter((row) =>
        `${group.title} ${row.join(" ")}`.toLowerCase().includes(term),
      ),
    }))
    .filter((group) => group.rows.length);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    search.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={root}
        className="modal shortcut-help"
        role="dialog"
        aria-modal="true"
        aria-labelledby="help-title"
        aria-describedby="help-description"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
          if (event.key === "Tab") {
            const nodes = root.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), [tabindex='0']",
            );
            if (!nodes?.length) return;
            const first = nodes[0],
              last = nodes[nodes.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header className="shortcut-help-header">
          <div>
            <div className="shortcut-help-eyebrow">
              <Keyboard size={15} /> DBde help
            </div>
            <h2 id="help-title">Keyboard shortcuts</h2>
            <p id="help-description">
              {mac
                ? "macOS · ⌘ Command · ⇧ Shift"
                : "Windows / Linux · Ctrl Control"}
              . Actions depend on the area in focus.
            </p>
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close help"
          >
            <X size={18} />
          </button>
        </header>
        <label className="shortcut-help-search">
          <Search size={15} />
          <input
            ref={search}
            aria-label="Search keyboard shortcuts"
            placeholder="Find an action or shortcut…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div
          className="shortcut-help-content"
          tabIndex={0}
          aria-label="Shortcut reference"
        >
          {filtered.map((group) => (
            <section className="shortcut-help-group" key={group.title}>
              <h3>{group.title}</h3>
              <p>{group.note}</p>
              <dl>
                {group.rows.map(([label, keys]) => (
                  <div className="shortcut-help-row" key={label}>
                    <dt>{label}</dt>
                    <dd>
                      <kbd>{keys}</kbd>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          {!filtered.length && (
            <p role="status">No shortcuts match “{query}”.</p>
          )}
          {!term && (
            <aside className="shortcut-help-about">
              <h3>A workspace that stays local</h3>
              <p>
                Desktop connections support PostgreSQL, MySQL/MariaDB and
                SQLite, with optional SSH tunneling. Saved passwords use your OS
                credential vault. The browser demo uses temporary SQLite data
                that resets on reload.
              </p>
            </aside>
          )}
        </div>
        <footer className="shortcut-help-footer">
          <span>
            Table-list actions follow Navicat mappings. Data-grid keys show
            DBde’s current behavior.
          </span>
          <kbd>Esc</kbd>
          <span>Close</span>
        </footer>
      </section>
    </div>
  );
}
