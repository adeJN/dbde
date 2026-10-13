# DBde

Local database desktop workspace based on [the PRD](prd_dbde_md.md). Phase 1 implementation using Tauri 2, Rust, React 18, TypeScript, Monaco, Zustand, and TanStack Table/Virtual.

## Run

Requires Node.js 20.19+ or 22.12+ and npm. For desktop, also install stable Rust and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/) (Xcode command-line tools on macOS, MSVC/WebView2 on Windows, WebKitGTK and build libraries on Linux). Linux credential storage requires a running Secret Service and its development libraries, such as `libdbus-1-dev`.

```sh
npm install
npm run dev
```

Open `http://localhost:1420`. Browser mode provides a real in-memory SQLite sandbox with seeded customers, orders, and products. Changes reset on reload; browser mode cannot connect to external databases or save passwords.

```sh
npm run tauri dev
npm run tauri build
```

The desktop application uses native SQLx pools, not the browser sandbox. SQLite paths may create new files. PostgreSQL/MySQL default to required TLS; choose certificate verification for remote production connections or disable TLS explicitly for a local server without TLS.

For passwordless MySQL/MariaDB accounts, leave Password empty. DBde omits the SQLx password option entirely; setting it to an empty string would still send a scrambled authentication response. Explicitly empty input never falls back to a saved vault password. The read-only local integration test `cargo test --manifest-path src-tauri/Cargo.toml mysql_local_empty_password_connects -- --ignored` verifies the Test Connection path and `SELECT 1` for `root` at `127.0.0.1:3306` with SSL disabled; it has passed against the local XAMPP server.

## Included

- Multiple active PostgreSQL, MySQL, and SQLite connections; test, connect, disconnect, save, and delete profiles.
- Passwords in the OS credential vault; connection metadata in the Tauri app-data directory. Passwords are excluded from serialized profiles and removed from frontend session state after connecting. No localStorage credential persistence.
- All databases visible to the connected MySQL/PostgreSQL account appear immediately in the explorer. The initial database field is optional: PostgreSQL starts on `postgres` when blank (specify an accessible initial database if that account cannot connect to `postgres`); MySQL can connect without selecting one. SQLite continues to open a single file.
- Expand a database to load its tables/views; expand a table to load columns. Refresh the server to discover new databases or refresh a database to reload its tables. Table views use server pagination, initially 1,000 rows per page, with a live total count.
- The footer shows the current row range and page count, first/previous/next/last controls, and **Rows per page** textbox accepting digits only, with any whole number from 1 to 5,000. Press Enter or leave the field to apply; Escape restores the current value. Invalid values show an inline error without fetching a page. Changing size starts at page one; refresh retains the current page and size. If deleting the last rows empties a page, the backend clamps the requested page to the new last page. Tables with primary keys use the full primary key for stable ordering; ordering without a primary key can vary. Concurrent database writes can shift offset-based pages between requests, and exact counting on very large tables is subject to the normal query timeout.
- Each query tab has its own database selector. Backend database pools are created lazily and cached per server connection, including for unsaved profiles. Switching a tab's database does not change another tab's database context, and disconnecting closes all its pools.
- Query tabs; double-click to rename, close to release results. Monaco SQL highlighting, table/keyword suggestions, SQL formatting, and Cmd/Ctrl+Enter to execute selected SQL or the whole editor.
- Table views open with SQL collapsed so results fill the workspace. Use **SQL editor** to show the compact editor, **Refresh** to reload a table without losing row actions, or **Focus table** to hide the explorer and heading. The explorer can also be toggled separately. Layout rules are documented in [the workspace design system](design-system/DBde.md).
- Opening the same table again from Explorer activates its existing tab for that connection, database, and schema. Closing it allows a new table tab later.
- Dynamic result columns, row virtualization, sorting, local filtering, CSV export, execution time, affected rows, and errors. CSV cells guard against spreadsheet formula injection.
- Table views include a **Filters** builder with a column selector, Equals/Does not equal, Contains/Does not contain, Starts with, Ends with, Is NULL and Is not NULL. Up to ten conditions are combined with AND. **Apply filters** searches the whole table before counting/pagination and starts at page one; **Clear filters** removes them. Active filters remain applied when changing page size, navigating, refreshing or reloading after deletion. Text matching follows database collation; `%`, `_` and `!` are treated literally. NULL comparisons use the dedicated operators; other operators follow SQL NULL semantics. Values are bound parameters and column names are verified against table metadata. The SQL preview uses encoded text literals to remain executable without concatenating user input into SQL.
- Click a table column header to sort all matching database rows ascending, descending, then unsorted. The Filter & Sort panel also has a sort selector. Sort and filters remain active through pagination, refresh, and record changes; the primary key breaks ties where present.
- Double-click a cell to inspect the full record and edit that cell. Editing requires a table with a primary key; primary key and non-scalar cells are read-only. **Add record** offers Default, Value, or NULL for each column so auto-generated fields can be omitted. A successful write reloads the active table; other tabs remain snapshots. Database constraints and column types are enforced by the database.
- The grid supports keyboard navigation: arrow keys move between cells, Tab/Shift+Tab move through the row, Home/End move to row edges, and Ctrl/⌘+Home or End jump to the first or last visible row. Enter or F2 opens a data cell. An empty row at the bottom of each table page accepts direct typing for a new record; untouched columns use their database defaults. Enter or Tab finishes a draft cell, Escape restores its previous draft, Delete clears it, and Ctrl/⌘+Enter or the check button saves the record. A failed insert leaves the draft intact for correction.
- Right-click a data cell for Delete Record, Copy, Copy As (TSV/CSV/JSON), Paste into that cell, Save Data As CSV, Filter, Sort, Remove All Filters & Sorts, and Refresh. Unavailable actions are disabled for read-only query results or tables without a primary key. Clipboard Paste requires clipboard read access in the webview.
- Select individual rows or all filtered rows using checkboxes. **Copy rows** copies selected records with column headers as tab-separated text, ready to paste into a spreadsheet. Selection follows records through sorting and resets when filtering or refreshing results.
- Open a table from Explorer to enable **Delete rows**. Deletion requires the complete primary key, including composite keys; the confirmation dialog shows the target table, count, and sample keys. Backend metadata is checked again, identifiers are quoted, and key values use bound parameters. Each selected key must delete exactly one row; an error or stale key rolls back the selection. The active table reloads after deletion. Related rows can be affected by configured cascades/triggers.
- Custom SQL/JOIN results and tables without primary keys can be copied but cannot use the row-delete button. MySQL row deletion requires InnoDB for rollback support. NULL, binary, floating-point, and other unsupported key representations require explicit SQL; a native key whose text representation differs from the displayed value fails safely. Delete at most 1,000 rows per operation. Other open tabs are snapshots and must be rerun to see changes.
- Desktop results capped at 50,000 rows; query/connection operations time out at 30 seconds. A timed-out write can have committed: inspect database state before retrying. Closing a running tab is disabled; disconnecting closes the pool after in-flight work releases it.
- Large integers beyond JavaScript's exact integer range and decimals are returned as strings; binary data is displayed as a hex object. Unsupported native column types produce an actionable error; explicitly cast such columns to text. Duplicate column names are preserved positionally.

Use one SQL statement per desktop execution, or select an individual statement in the editor. Explicit transaction scripts and query cancellation are not implemented. Structured table filters and sorts apply to the full table before pagination; the quick search in the toolbar filters only the current fetched page. Custom SQL results use client pagination over the fetched dataset (still capped at 50,000 rows); their sorting/filtering applies before pagination. Select-all and CSV export operate on the visible filtered page, and selection clears on page or size changes. Browser sandbox queries execute synchronously and are intended for small local experiments, not benchmarking.

## Validation

```sh
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Frontend tests cover identifier quoting, safe CSV output, and releasing tab/result state when a connection closes. Rust tests exercise SQLite execution, native values, empty result columns, affected-row counts, row limits, and credential serialization. Live PostgreSQL/MySQL and OS vault behavior require local integration testing.

MySQL `TIMESTAMP` and `DATETIME` values display their session clock fields without an assumed UTC suffix. The optional `mysql_timestamp_rows_decode_without_query_casts` Rust integration test checks fractional seconds and NULL values with a non-UTC session. To run it, configure `DBDE_TEST_MYSQL_URL` for a test database and run `cargo test --manifest-path src-tauri/Cargo.toml mysql_timestamp_rows_decode_without_query_casts -- --ignored`. It uses a session-local temporary table and requires permission to create temporary tables.

The sandbox and Monaco load lazily; Monaco workers and SQLite WASM are packaged locally. The desktop does not require network-hosted editor assets. UI uses local CSS and system fonts to keep dependencies small.

## Remaining roadmap

Phase 2: MongoDB, SSH tunneling, import/dump workflows. Phase 3: structure editor and ER diagrams. Also pending: index explorer, column completion, context-menu schema export and destructive DDL actions, native query cancellation, horizontal column virtualization, integration test matrix, code signing, platform installer verification, and release performance benchmarks. Desktop icons are generated from `app-icon.svg`. No installer size, memory, startup, or IPC KPI has been measured yet; the PRD targets are not verified claims.

Local validation includes frontend production builds, React interaction tests for row selection/copy/delete confirmation, sandbox SQLite mutations, Rust compilation, and Rust tests for composite-key deletion, rollback, and injection handling. Live MySQL/PostgreSQL server access and OS-vault prompts still require integration testing with the intended account. Direct visual inspection was unavailable because no browser or native app surface was connected.
