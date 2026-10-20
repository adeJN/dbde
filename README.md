# DBde

Local database desktop workspace based on [the PRD](prd_dbde_md.md). Phase 1 implementation using Tauri 2, Rust, React 18, TypeScript, Monaco, Zustand, and TanStack Table/Virtual.

## Database administration tools

Open **Database tools** beside Query history for multi-table record transfer, server monitoring, object information, a visual SELECT builder and ER models. Grid toolbars also provide named **Table profiles** and **ƒx Raw Mode**.

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
- By default, all databases visible to the connected MySQL/PostgreSQL account appear in the explorer. Enable **Show only this database** when adding a connection to focus the sidebar and database selectors on the database entered; its name is then required. This preference is saved with the profile. Focused connections to different databases can coexist, while reopening the same focused database reuses its existing connection. The initial database field is optional: PostgreSQL starts on `postgres` when blank (specify an accessible initial database if that account cannot connect to `postgres`); MySQL can connect without selecting one. SQLite continues to open a single file.
- Expand a database to load its tables/views; expand a table to load columns. Refresh the server to discover new databases or refresh a database to reload its tables. Table views use server pagination, initially 1,000 rows per page, with a live total count.
- The footer shows the current row range and page count, first/previous/next/last controls, and **Rows per page** textbox accepting digits only, with any whole number from 1 to 5,000. Press Enter or leave the field to apply; Escape restores the current value. Invalid values show an inline error without fetching a page. Changing size starts at page one; refresh retains the current page and size. If deleting the last rows empties a page, the backend clamps the requested page to the new last page. Tables with primary keys use the full primary key for stable ordering; ordering without a primary key can vary. Concurrent database writes can shift offset-based pages between requests, and exact counting on very large tables is subject to the normal query timeout.
- Each query tab has its own database selector. Backend database pools are created lazily and cached per server connection, including for unsaved profiles. Switching a tab's database does not change another tab's database context, and disconnecting closes all its pools.
- Query tabs; double-click to rename, close to release results. Monaco SQL highlighting, table/keyword suggestions, SQL formatting, and Cmd/Ctrl+Enter to execute selected SQL or the whole editor.
- Table views open with SQL collapsed so results fill the workspace. Use **SQL editor** to show the compact editor, **Refresh** to reload a table without losing row actions, or **Focus table** to hide the explorer and heading. The explorer can also be toggled separately. Layout rules are documented in [the workspace design system](design-system/DBde.md).
- Opening the same table again from Explorer activates its existing tab for that connection, database, and schema. Closing it allows a new table tab later.
- Dynamic result columns, row virtualization, sorting, local filtering, CSV export, execution time, affected rows, and errors. CSV cells guard against spreadsheet formula injection.
- Table views include a **Filters** builder with a column selector, Equals/Does not equal, Contains/Does not contain, Starts with, Ends with, Is NULL and Is not NULL. Up to ten conditions are combined with AND. **Apply filters** searches the whole table before counting/pagination and starts at page one; **Clear filters** removes them. Active filters remain applied when changing page size, navigating, refreshing or reloading after deletion. Text matching follows database collation; `%`, `_` and `!` are treated literally. NULL comparisons use the dedicated operators; other operators follow SQL NULL semantics. Values are bound parameters and column names are verified against table metadata. The SQL preview uses encoded text literals to remain executable without concatenating user input into SQL.
- Click a table column header to sort all matching database rows ascending, descending, then unsorted. The Filter & Sort panel also has a sort selector. Sort and filters remain active through pagination, refresh, and record changes; the primary key breaks ties where present.
- Double-click a cell to inspect the full record and edit that cell. Editing requires a table with a primary key; primary key and non-scalar cells are read-only. **Add record** offers Default, Value, or NULL for each column so auto-generated fields can be omitted. A successful write reloads the active table; other tabs remain snapshots. Editor values are checked against column metadata before saving: integer syntax/range (including unsigned and BIGINT), decimal precision/scale, finite floating-point values, text length, NULL permissions, calendar dates/times, JSON, UUID, and MySQL ENUM/SET. Invalid inline values stay editable with a column-specific error. Paste, dialogs, and transaction commits use the same write validation; a failing batch writes nothing. Fresh metadata is fetched before each write. Database constraints and specialized/custom types remain enforced by the database.
- The grid supports keyboard navigation: arrow keys move between cells, Tab/Shift+Tab move through the row, Home/End move to row edges, and Ctrl/⌘+Home or End jump to the first or last visible row. Enter or F2 opens a data cell. An empty row at the bottom of each table page accepts direct typing for a new record; untouched columns use their database defaults. Enter or Tab finishes a draft cell, Escape restores its previous draft, Delete clears it, and Ctrl/⌘+Enter or the check button saves the record. A failed insert leaves the draft intact for correction.
- Right-click a data cell for Delete Record, Copy, Copy As (TSV/CSV/JSON), Paste into that cell, Save Data As CSV, Filter, Sort, Remove All Filters & Sorts, and Refresh. Unavailable actions are disabled for read-only query results or tables without a primary key. Clipboard Paste requires clipboard read access in the webview.
- Select individual rows or all filtered rows using checkboxes. **Copy rows** copies selected records with column headers as tab-separated text, ready to paste into a spreadsheet. Selection follows records through sorting and resets when filtering or refreshing results.
- Open a table from Explorer to enable **Delete rows**. Deletion requires the complete primary key, including composite keys; the confirmation dialog shows the target table, count, and sample keys. Backend metadata is checked again, identifiers are quoted, and key values use bound parameters. Each selected key must delete exactly one row; an error or stale key rolls back the selection. The active table reloads after deletion. Related rows can be affected by configured cascades/triggers.
- Custom SQL/JOIN results and tables without primary keys can be copied but cannot use the row-delete button. MySQL row deletion requires InnoDB for rollback support. NULL, binary, floating-point, and other unsupported key representations require explicit SQL; a native key whose text representation differs from the displayed value fails safely. Delete at most 1,000 rows per operation. Other open tabs are snapshots and must be rerun to see changes.
- Desktop results capped at 50,000 rows; query/connection operations time out at 30 seconds. A timed-out write can have committed: inspect database state before retrying. Closing a running tab is disabled; disconnecting closes the pool after in-flight work releases it.
- Large integers beyond JavaScript's exact integer range and decimals are returned as strings; binary data is displayed as a hex object. Unsupported native column types produce an actionable error; explicitly cast such columns to text. Duplicate column names are preserved positionally.

Desktop query tabs keep their own PostgreSQL/MySQL session and support transaction scripts and cancellation. Select an individual statement in the editor to run only that selection. Structured table filters and sorts apply to the full table before pagination; the quick search in the toolbar filters only the current fetched page. Custom SQL results use client pagination over the fetched dataset (still capped at 50,000 rows); their sorting/filtering applies before pagination. Select-all and CSV export operate on the visible filtered page, and selection clears on page or size changes. Browser sandbox queries execute synchronously and are intended for small local experiments, not benchmarking.

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

Phase 2: MongoDB, HTTP tunneling, imports and streaming dumps for large databases. Phase 3: structure editor and ER diagrams. Also pending: horizontal column virtualization, live server integration coverage, code signing, platform installer verification, and release performance benchmarks. Desktop icons are generated from `app-icon.svg`. No installer size, memory, startup, or IPC KPI has been measured yet; the PRD targets are not verified claims.

Local validation includes frontend production builds, React interaction tests for row selection/copy/delete confirmation, sandbox SQLite mutations, Rust compilation, and Rust tests for composite-key deletion, rollback, and injection handling. Live MySQL/PostgreSQL server access and OS-vault prompts still require integration testing with the intended account. Direct visual inspection was unavailable because no browser or native app surface was connected.

## Table actions in the sidebar

Right-click a table or use its `…` button to open its data, review DDL, edit structure through SQL, pin a table shortcut, copy structure/data, transfer records, dump SQL, refresh, empty, truncate, or drop it. Views expose only applicable actions. Menu navigation supports the arrow keys, Home/End, Enter, and Escape.

- Copy creates a new table and never replaces an existing target. MySQL can target another database on the same server; PostgreSQL can target another schema in the same database; SQLite stays in its current file. Columns, indexes, and generated values are retained. Triggers, grants, and external relationships need separate review.
- Transfer appends saved scalar values to an existing table in any connected database, with explicit column mapping. Up to 5,000 records are applied atomically; omit identity columns to use destination defaults. Binary values are supported in SQL dumps rather than mapped transfers. Pause concurrent source writes during export/transfer; these reads are not a cross-database snapshot.
- SQL dumps contain structure or structure plus saved records (up to 100,000 rows / 512 MB). Exports above 5,000 rows require a primary key for stable pagination. Table dependencies such as referenced tables and custom types must already exist at restore time.
- Empty runs DELETE and preserves identity counters. Truncate resets counters (SQLite uses DELETE plus sequence reset). Both require confirmation; Drop also removes the opened table tabs. Unsaved changes and open SQL transactions are checked before destructive actions.
- Pinned shortcuts are local sidebar bookmarks tied to saved profiles. They are not operating-system desktop shortcuts. Open Table Quick defers declared BLOB/bytea columns until a record detail is opened. It requires a scalar primary key and is read-only; use Open Table for mutations and complete clipboard/CSV output. Visual changes to existing table structures remain future work.

SQLite sandbox and Rust tests cover copy constraints/indexes, generated columns, whole-table SQL restore, BLOB dumps, counter reset, and transfer rollback. Live MySQL/PostgreSQL copy/restore still requires integration testing against a test server.

Click a database name to open its table/view list in a workspace tab. Right-click any table row (or focus its name and press Shift+F10) for the same actions as the sidebar table menu, including Open, DDL, Copy, Transfer, Dump, Refresh, Empty, Truncate and Drop. Destructive operations retain their confirmation dialogs, and table-only operations are disabled for views. Escape restores focus to the table name. Repeated clicks reuse the same tab for that connection and database. Search by table name or schema, refresh metadata, create a table, or click a table name to open its data. The arrow beside the database independently expands/collapses the sidebar branch. The list shows Name, Rows, Data Length, Engine, Created Date, Modified Date, Collation, and Comment. MySQL/MariaDB supplies these from INFORMATION_SCHEMA; PostgreSQL supplies catalog row estimates, relation size and comments. Unsupported or unavailable metadata is shown as —. Row counts are server statistics and may be estimates; the list does not run COUNT(*) for every table. Data Length uses 1024-byte units. PostgreSQL schema and view badges remain visible alongside the name. Refresh reloads this metadata.

Right-click a database name (or its `…` button) for Close Database, Edit Database, New Database, Delete Database, New Query, Execute SQL File, Dump SQL File (structure only / structure and data), Find in Database, Share, and Refresh. Console, Reverse to Model, and Data Dictionary are omitted. Shift+F10 opens the menu; arrow keys navigate it, and Escape restores focus. The displayed query/refresh/close shortcuts apply while the database row or its menu has focus.

Close Database checks pending records/transactions, closes its tabs and database pools, and collapses its branch while retaining the server connection. System databases are protected from edit/delete. MySQL/MariaDB supports database creation, deletion and default character set/collation editing. PostgreSQL supports creation, deletion and renaming; its administration uses the `postgres` maintenance database and requires appropriate server privileges. Other clients can block deletion/renaming; DBde does not force-terminate them. SQLite file administration is disabled in this menu.

Execute SQL File selects a UTF-8 file up to 20 MB and opens it for review, with confirmation before execution. SQL scripts may commit statements independently. Database dumps support up to 200 objects, with existing per-table row limits; SQLite triggers and PostgreSQL foreign keys are deferred until after data. These exports are not a transactional backup: pause concurrent writes and review view dependencies, custom types, triggers and grants before restoration. Find searches table/view names and optionally column names (up to 200 tables). Share copies or exports a JSON connection profile without passwords or table data; it never sends it to another person automatically.

## New Table designer

Use **New table** beside a database in the sidebar, or right-click the database and choose **New Table…**. The designer follows Navicat's field-grid layout: **Add Field**, **Insert Field**, **Delete Field**, **Primary Key**, **Move Up/Down**, and the Name, Type, Length, Decimals, Not null, Key, and Comment columns. Select a field to edit its default, auto increment/identity, unsigned flag, or ENUM/SET values below the grid. Drag row numbers to reorder fields.

Tabs configure **Fields**, **Indexes**, **Foreign Keys**, **Checks**, MySQL **Options**, **Comment** (MySQL/PostgreSQL), and a read-only **SQL Preview**. Index field selection order determines composite index order. Referenced field names use a comma-separated list for composite foreign keys. MySQL uses InnoDB, with optional charset/collation; PostgreSQL accepts a schema; SQLite omits unsupported comment/storage settings.

**Save** or **⌘/Ctrl+S** creates the table, refreshes the database tree, and opens its data. **⌘/Ctrl+Plus/Minus** adds/deletes a field, **Shift+⌘/Ctrl+K** toggles its primary key, **⌘/Ctrl+Up/Down** reorders it, and **⌘/Ctrl+F** finds fields. Invalid designs and server errors preserve the draft. Closing a changed design asks before discarding it. Existing tables are never replaced. SQLite/PostgreSQL create the table and its indexes/comments in a native transaction; MySQL includes indexes and constraints in one CREATE TABLE. Server permissions and version-specific constraints still apply. Live MySQL/PostgreSQL creation and exact visual matching with Navicat require local verification.

Sidebar search matches database names and table/view names, ignoring case and surrounding whitespace. A matching database shows all its tables; a matching table reveals its database branch. Unopened databases are searched through cached schema metadata, with a 250 ms debounce and at most three concurrent metadata reads. No table records are fetched for search. Clearing the search restores normal expansion state; focused connections search only their visible database list.

## Connection context menu

Right-click an active connection or saved profile, use its **…** button, or press **Shift+F10** on its heading. The menu follows the supplied Navicat reference: Close/Open Connection, Switch Connection Profile, Edit, New, Delete, Duplicate, New Database, New Query, Execute SQL File, Flush, Star, Color, Manage Group, Share, and Refresh. Arrow keys, Home/End, Enter, and Escape navigate menus; Right/Left open/close flyouts. ⌘/Ctrl+Y creates a query, ⌘/Ctrl+R refreshes, and Shift+⌘/Ctrl+. closes the connection while its heading/menu is focused.

- Switch Connection Profile selects another saved DBde profile. A replacement login is established before the old connection closes; an already active target keeps its existing tabs. Edit preserves tabs for name-only changes and keeps the old session if replacement login fails. Duplicate saves an independent profile with newly supplied credentials; it never reads the original password into the form.
- Close, switch, edit requiring reconnect, and delete check running queries, staged grid changes, and open transactions. Delete removes the connection profile and local appearance metadata, leaving database contents untouched.
- Execute SQL File first selects a target database, then uses the existing file review/execute flow.
- MySQL/MariaDB **Flush** offers Privileges, Tables, Logs, and Status through separate pooled queries; server privileges determine availability. The supported commands follow the [MySQL FLUSH documentation](https://dev.mysql.com/doc/refman/8.4/en/flush.html). Other drivers disable this submenu.
- Stars, colors, and named groups persist in local appearance settings without credentials; groups organize active connection headings. Share previews/copies/exports a password-free connection profile, including single-database focus. Refresh reloads database and table metadata.

Verification uses interaction and IPC tests. Native Navicat visual comparison, live server administration, and OS credential-vault changes require local integration testing.

## Workspace tabs

Right-click a workspace tab (or press Shift+F10 while it has focus) for Close, Close Other Tabs, Close Tabs to the Right, Close All, Move Tab to New Window, Add/Remove Favorites, and Reveal in Navigation Pane. Bulk close checks pending records and server transactions before closing any target tabs. Actions that include a running tab are disabled. The right-clicked tab becomes active; closing it selects the nearest surviving tab to its left, then the first remaining tab.

Drag tabs to reorder them using pointer gestures; an insertion marker shows the drop position, and the tab strip scrolls automatically near its edges. The right-hand close action uses this displayed order. Middle-click closes a tab. Arrow keys and Home/End navigate focused tabs; Ctrl/Command+W closes the focused tab. A yellow dot marks unsaved record changes. Favorites persist locally and reopen database/table/query tabs; query favorites save a snapshot of their SQL. Reveal opens the relevant connection/database and focuses the matching table, clearing sidebar search.

Database-list tabs cannot be moved to a new window. Moving table/query tabs requires the desktop app and a server or file-backed SQLite connection. A new window receives the tab state and an independently owned database pool. Detached windows are locked to a single focused tab. Their application header, duplicate single-tab strip and application status bar are omitted to give the grid more height. A compact table/connection caption retains refresh and its right-click actions; Shift+F10 opens those actions, and Ctrl/Command+W closes the window after checks. Pagination and the grid footer remain visible. Sidebar, tab creation, SQL-editor and Exit focus controls are unavailable; Reveal and further window moves are disabled. Closing the last tab closes the detached window after pending-change/transaction checks. Query tabs can run or refresh their existing SQL without adding tabs. PostgreSQL/MySQL SQL sessions are transferred, preserving transaction and temporary-table state; the source tab is removed after the destination initializes. If initialization fails, the source tab stays open. In-memory SQLite cannot be moved. Detached window closure checks pending changes and transactions; its pool is released when the window is destroyed.

## Connection settings

The connection dialog groups options into General, Advanced, Databases, SSL, SSH and Remarks. SQLite exposes General, Advanced and Remarks. Settings persist with saved profiles; older profiles receive defaults automatically.

- General: name, host, port, database credentials, or the SQLite file path.
- Databases: optional initial database and a custom display list with per-database Auto Open. Enable the custom list, refresh the server catalog, and select the databases to show in the sidebar and database selector. Add/remove changes this display list only; it never creates or deletes a server database. Auto Open expands the database branch and loads its table list after connecting. Disabling the custom list shows all accessible databases. Legacy single-database profiles migrate to a one-entry custom list when edited.
- Advanced: connection timeout (1–30 seconds), default query-tab timeout (1–3600 seconds), maximum SQL-tab sessions (1–16), MySQL/MariaDB character set and optional socket path, initial SQL, and auto-connect at startup. The session limit excludes shared metadata/data pools.
- SSL: existing encryption/verification modes plus PEM CA certificate and optional paired client certificate/private-key paths for PostgreSQL and MySQL/MariaDB. Private-key contents are not stored in the profile.
- Remarks: local notes about the connection.
- SSH: password or private-key authentication (including encrypted keys), SSH host/port/user, and optional SHA256 host-key pin. Without a pin, the server key must already match `~/.ssh/known_hosts`. Unknown/changed keys are rejected. Passwords and key passphrases are saved separately in the OS credential vault and omitted from profile JSON, shared configs, and detached-window snapshots.

Initial SQL runs on every new physical database connection, including Test connection, metadata pools, per-database pools and SQL-tab sessions. Auto-connect opens saved profiles once at startup, skips detached windows, and reads database passwords from the existing OS credential vault. Remarks and auto-connect do not change connection identity; socket, SSL and session settings do.

When using SSH, General's database host/port are resolved from the SSH server (e.g. `127.0.0.1:3306` for MySQL on that server). Clear any local MySQL socket path. Test connection verifies SSH authentication, forwarding, and the database login. Tunnel ownership follows the connection and is shared with detached table windows; the last owner closes it. SSH sends keepalive messages every 30 seconds. Changing an SSH route requires re-entering stored credentials.

On macOS/Linux, a private local Unix socket forwards traffic while retaining the original database hostname for TLS verification. On Windows the forwarding endpoint is loopback TCP; SSH with database SSL `verify-full` is explicitly unavailable there, rather than silently skipping hostname verification. Windows SSH has not been exercised on this macOS development machine.

To connect: fill General with the database destination, open SSH, enable Use SSH tunnel, enter SSH host/user/authentication, then Test connection. For an unknown server, obtain its SHA256 host fingerprint from a trusted administrator and enter it, or verify/register the host with OpenSSH first. SSH credentials and database credentials can differ.

HTTP tunnels, SSH agent/keyboard-interactive authentication, alternate driver versions, network read/write timeouts and compression are not implemented. These options are not presented as working settings.

## Table-list keyboard and copy/paste

A single click selects an object in a database table-list tab; Enter or double-click opens its data. Use Up/Down, Home/End and Shift+arrows to navigate/select ranges, Cmd/Ctrl+click for individual selections, and Cmd/Ctrl+A to select all filtered rows. Shortcuts stay scoped to the list and do not replace normal typing/clipboard behavior in its search box.

- Cmd/Ctrl+C: copy selected tables; Cmd/Ctrl+V: review and paste into the current database. Copy also writes table names to the OS clipboard, so text editors receive plain names. The table references stay in this workspace and contain no connection passwords. If the clipboard contents change, copy the tables again.
- macOS: Cmd+R refresh; Cmd+N new table; Cmd+D design SQL; Shift+Cmd+D duplicate-table dialog; Cmd+Y new query; Shift+Cmd+T transfer-records dialog; Cmd+F focus table search.
- Windows: F5 refresh; Ctrl+N new table; Ctrl+D design SQL; Ctrl+Q new query; Ctrl+F focus table search. Duplicate and transfer remain available in the context menu; no unverified Ctrl alias is assigned to macOS-only shortcuts.
- Cmd/Ctrl means Command on macOS and Control on Windows. Additional modifiers are matched exactly: Ctrl+Cmd+F (full screen), Shift+Cmd+Y (query object) and Option+Cmd+F (replace) do not run the unmodified list action. Enter opens the selected table; Cmd+O is reserved for designer context, as in the manual.
- Delete or Cmd/Ctrl+Backspace: request deletion of a single selected object, using the existing permanent-deletion acknowledgement. Bulk deletion is not performed by this shortcut.

Paste supports up to 100 selected tables in a batch, optional data, editable destination names, collision-safe `_copy` suggestions and retry of only failed/unattempted tables. It never replaces an existing destination table. Each table is copied separately; a batch is not one atomic transaction. A partial failure remains visible, and tables already copied are preserved. Copied source connections must remain open.

Direct cross-database copy supports MySQL/MariaDB databases on the same server and account/SSH route, including separate focused profiles. PostgreSQL copy is limited to the same database, and SQLite copy to the same connection/file. Different servers/engines or PostgreSQL/SQLite databases require export/import; the existing Transfer records action can append mapped records to an existing destination table. Columns and indexes are copied; triggers, permissions and external relationships need separate review. The macOS object-action mappings follow the Common/Main Window sections of the [Navicat macOS manual](https://www.navicat.com/manual/pdf_manual/en/navicat_18/mac_manual/navicat_mac_en.pdf); Windows New Query follows the [Windows manual](https://www.navicat.com/manual/pdf_manual/en/navicat_18/win_manual/navicat_en.pdf). Navigation, selection and clipboard shortcuts are standard list interactions. This covers the table-list context, not all Navicat editors or features. Design opens DBde’s SQL workflow and transfer opens its existing record-transfer dialog; these workflows have fewer features than Navicat.

## App updates — GitHub Releases

DBde 0.2.0 introduces signed in-app updates. The download icon in the title bar opens **App updates**. DBde checks once shortly after launch and every six hours; checks only show an availability badge and never install automatically. **Download & install** verifies the artifact signature, installs, and restarts DBde. Save SQL and table changes, finish transactions, close all connections and detached table windows, and wait for imports/exports before installing. Failed checks or downloads remain retryable. The browser sandbox cannot install desktop updates.

The public endpoint is `https://github.com/adeJN/dbde/releases/latest/download/latest.json`. The repository and release assets must be publicly downloadable. Do not embed a GitHub access token in the app. Until a release with `latest.json` is published, the app shows “Update information is not available yet”. This is distinct from a valid check reporting that the installed version is up to date. Network failures remain retryable errors.

### First installation and signing key

Devices running the previous 0.1.0 build need one manual installation of 0.2.0 (or a later build containing this updater). They cannot acquire an updater retroactively. Subsequent newer releases can be installed from inside DBde.

The updater private key is kept outside this repository at `~/.tauri/dbde-updater.key`; the matching public key is embedded in `src-tauri/tauri.conf.json`. Back up the private key securely and keep using the same key for every release. Never upload it to GitHub Releases or commit it. Losing it prevents existing installations from trusting future updates. On another build machine, restore the same key or supply `TAURI_SIGNING_PRIVATE_KEY` and, if needed, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` through that machine's secure environment.

Updater signing verifies update files; Apple Developer ID signing and notarization are separate. The current macOS build uses ad-hoc signing. To distribute without Gatekeeper warnings, configure a Developer ID certificate and notarization credentials before building the release.

### Publish a release for Apple Silicon (M1/M2/M3/M4)

1. Increase the version in `package.json`, the root package in `package-lock.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. Release builds reject inconsistent app versions. Keep `Cargo.lock` synchronized with Cargo. Use a version greater than the installed version; the initial updater build is **0.2.0**.
2. Build on the Mac with the signing key. This command loads the key path without printing the key:

   ```bash
   npm run release:build -- --target aarch64-apple-darwin
   ```

3. Generate the manifest using the actual signed update artifact (adjust the path if using a different target/build directory):

   ```bash
   npm run updater:manifest -- \
     --artifact src-tauri/target/aarch64-apple-darwin/release/bundle/macos/DBde.app.tar.gz \
     --platform darwin-aarch64 \
     --output src-tauri/target/latest.json
   ```

   Add `--notes path/to/release-notes.md` for release notes. The script reads the adjacent `.sig` file automatically. If the output already exists, it merges architectures only for the same version. For a different version choose a fresh output path. Different architectures need distinct artifact basenames when uploaded to the same release; rename each archive and its adjacent `.sig` together before generating the manifest.

4. Create a normal GitHub Release in **adeJN/dbde** with tag **v0.2.0** (or the matching newer version). Upload the `.dmg` for manual installs, the `.app.tar.gz` update archive, its `.sig`, and **latest.json**. The archive basename must match the manifest URL exactly. Upload the manifest after the archives, then publish the release as **Latest**. Drafts and prereleases are not the default update channel.
5. Test from an older updater-enabled installation on a spare Mac: check, download, install, restart, and confirm the new version. A same-version release is correctly ignored. Test invalid signatures and interrupted downloads before broad distribution. Nothing in the release scripts publishes to GitHub automatically.

For Intel Macs, build `x86_64-apple-darwin` and add `darwin-x86_64` to the manifest. A device only receives artifacts for its own platform. Run `node --test scripts/update-manifest.check.mjs` to check manifest generation.
