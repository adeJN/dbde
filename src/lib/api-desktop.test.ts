import { describe, expect, it, vi } from "vitest";
const { invoke, Channel } = vi.hoisted(() => ({
  invoke: vi.fn(),
  // Stands in for Tauri's IPC channel: the backend calls onmessage with progress.
  Channel: class {
    onmessage: (message: unknown) => void = () => {};
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke,
  Channel,
}));
import {
  connect,
  disconnect,
  listDatabases,
  execute,
  schema,
  columns,
  viewTable,
  deleteRows,
  insertRecord,
  updateCell,
  closeSession,
  cancelQuery,
  sessionInTransaction,
  listIndexes,
  tableDdl,
  saveFile,
  insertRecords,
  applyChanges,
  moveTabToWindow,
  renameTableFields,
  alterTableFields,
  exportTable,
  exportRows,
  cancelExport,
  openImportFile,
  previewImport,
  closeImport,
  importTarget,
  importRowCount,
  runImport,
  cancelImport,
} from "./api";
import { defaultExportOptions } from "./export";

const metadata = [
  { name: "id", data_type: "int", nullable: false },
  { name: "name", data_type: "varchar(20)", nullable: true },
  { name: "note", data_type: "text", nullable: true },
];

it("sends field renames as structured names for backend validation", async () => {
  invoke.mockResolvedValueOnce(undefined);
  const table = { name: "customers", schema: "app", kind: "table" };
  await renameTableFields("local", "app", table, [
    { from: "name", to: "full name" },
  ]);
  expect(invoke).toHaveBeenLastCalledWith("dbde_rename_table_fields", {
    connectionId: "local",
    database: "app",
    table,
    renames: [{ from: "name", to: "full name" }],
  });
});
it("previews property changes through a structured backend plan without requesting execution", async () => {
  invoke.mockResolvedValueOnce(
    "ALTER TABLE customers MODIFY name varchar(120);",
  );
  const table = { name: "customers", schema: "app", kind: "table" };
  const changes = [
    {
      from: "name",
      to: "name",
      patch: { not_null: true, comment: "Display name" },
    },
  ];
  await alterTableFields("local", "app", table, changes, true);
  expect(invoke).toHaveBeenLastCalledWith("dbde_alter_table_fields", {
    connectionId: "local",
    database: "app",
    table,
    changes,
    preview: true,
  });
});

it("transfers a tab snapshot without sending the profile password", async () => {
  invoke.mockResolvedValueOnce(undefined);
  await moveTabToWindow(
    {
      id: "source",
      config: {
        id: "profile",
        name: "Local",
        driver: "mysql",
        host: "localhost",
        port: 3306,
        username: "root",
        password: "private-test-secret",
        database: "shop",
        ssl_mode: "disable",
        file_path: "",
      },
    },
    {
      id: "tab",
      name: "Query",
      connectionId: "source",
      query: "SELECT 1",
      running: false,
    },
  );
  const [command, payload] = invoke.mock.calls.at(-1)!;
  expect(command).toBe("dbde_move_tab_to_window");
  expect(payload.connectionId).toBe("source");
  expect(payload.snapshot.session.config.password).toBeUndefined();
  expect(payload.snapshot.tab.id).toBe("tab");
});

describe("desktop server browsing IPC", () => {
  it("passes validated sort and record mutations through structured commands", async () => {
    const table = { name: "customers", schema: "public", kind: "table" };
    const source = { database: "app_db", table, primary_keys: ["id"] };
    invoke.mockResolvedValueOnce({ columns: [], rows: [] });
    await viewTable("server", "app_db", table, 1, 50, [], {
      column: "name",
      direction: "desc",
    });
    expect(invoke).toHaveBeenLastCalledWith("dbde_view_table", {
      connectionId: "server",
      database: "app_db",
      table,
      page: 1,
      pageSize: 50,
      sort: { column: "name", direction: "desc" },
    });
    invoke.mockResolvedValueOnce(metadata);
    invoke.mockResolvedValueOnce(1);
    await updateCell("server", source, { id: 2 }, "name", "New");
    expect(invoke).toHaveBeenLastCalledWith("dbde_update_cell", {
      connectionId: "server",
      database: "app_db",
      table,
      key: { id: 2 },
      column: "name",
      value: "New",
    });
    invoke.mockResolvedValueOnce(metadata);
    invoke.mockResolvedValueOnce(1);
    await insertRecord("server", source, { name: "Ada", note: null });
    expect(invoke).toHaveBeenLastCalledWith("dbde_insert_record", {
      connectionId: "server",
      database: "app_db",
      table,
      values: { name: "Ada", note: null },
    });
  });
  it("passes page and page size to native table browsing", async () => {
    invoke.mockResolvedValueOnce({ columns: [], rows: [] });
    const table = { name: "customers", schema: "public", kind: "table" };
    await viewTable("server", "app_db", table, 3, 500);
    expect(invoke).toHaveBeenLastCalledWith("dbde_view_table", {
      connectionId: "server",
      database: "app_db",
      table,
      page: 3,
      pageSize: 500,
    });
  });
  it("sends structured table and key data for deletion instead of raw SQL", async () => {
    invoke.mockResolvedValueOnce({ columns: [], rows: [] });
    const table = { name: "customers", schema: "public", kind: "table" };
    await viewTable("server", "app_db", table);
    expect(invoke).toHaveBeenLastCalledWith("dbde_view_table", {
      connectionId: "server",
      database: "app_db",
      table,
      page: 1,
      pageSize: 1000,
    });
    invoke.mockResolvedValueOnce(1);
    expect(
      await deleteRows(
        "server",
        { database: "app_db", table, primary_keys: ["id"] },
        [{ id: "a' OR 1=1 --" }],
      ),
    ).toBe(1);
    expect(invoke).toHaveBeenLastCalledWith("dbde_delete_rows", {
      connectionId: "server",
      database: "app_db",
      table,
      keys: [{ id: "a' OR 1=1 --" }],
    });
  });
  it("requests all databases without an initial database filter", async () => {
    invoke.mockResolvedValueOnce(["analytics", "app_db"]);
    expect(await listDatabases("server")).toEqual(["analytics", "app_db"]);
    expect(invoke).toHaveBeenLastCalledWith("dbde_list_databases", {
      connectionId: "server",
    });
  });
  it("passes each tab's database to execution, schema, and column lookups", async () => {
    invoke.mockResolvedValue(undefined);
    await execute("server", "SELECT * FROM orders", "analytics");
    expect(invoke).toHaveBeenLastCalledWith("dbde_execute_query", {
      connectionId: "server",
      query: "SELECT * FROM orders",
      database: "analytics",
    });
    await execute("server", "SELECT * FROM orders", "app_db");
    expect(invoke).toHaveBeenLastCalledWith("dbde_execute_query", {
      connectionId: "server",
      query: "SELECT * FROM orders",
      database: "app_db",
    });
    await execute("server", "BEGIN", "app_db", "tab-1");
    expect(invoke).toHaveBeenLastCalledWith("dbde_execute_query", {
      connectionId: "server",
      query: "BEGIN",
      database: "app_db",
      sessionId: "tab-1",
    });
    await closeSession("server", "tab-1");
    expect(invoke).toHaveBeenLastCalledWith("dbde_close_session", {
      connectionId: "server",
      sessionId: "tab-1",
    });
    await execute("server", "SELECT pg_sleep(60)", "app_db", "tab-1", 120);
    expect(invoke).toHaveBeenLastCalledWith("dbde_execute_query", {
      connectionId: "server",
      query: "SELECT pg_sleep(60)",
      database: "app_db",
      sessionId: "tab-1",
      timeoutSecs: 120,
    });
    await cancelQuery("server", "tab-1");
    expect(invoke).toHaveBeenLastCalledWith("dbde_cancel_query", {
      connectionId: "server",
      sessionId: "tab-1",
    });
    await sessionInTransaction("server", "tab-1");
    expect(invoke).toHaveBeenLastCalledWith("dbde_session_in_transaction", {
      connectionId: "server",
      sessionId: "tab-1",
    });
    const orders = { name: "orders", schema: "public", kind: "table" };
    await listIndexes("server", orders, "app_db");
    expect(invoke).toHaveBeenLastCalledWith("dbde_list_indexes", {
      connectionId: "server",
      table: orders,
      database: "app_db",
    });
    await tableDdl("server", orders, "app_db");
    expect(invoke).toHaveBeenLastCalledWith("dbde_table_ddl", {
      connectionId: "server",
      table: orders,
      database: "app_db",
    });
    await saveFile("orders.sql", "sql", "CREATE TABLE orders ();");
    expect(invoke).toHaveBeenLastCalledWith("dbde_save_file", {
      defaultName: "orders.sql",
      extension: "sql",
      contents: "CREATE TABLE orders ();",
    });
    const source = { database: "app_db", table: orders, primary_keys: ["id"] };
    invoke.mockResolvedValueOnce(metadata);
    await insertRecords("server", source, [{ name: "a" }, { name: null }]);
    expect(invoke).toHaveBeenLastCalledWith("dbde_insert_records", {
      connectionId: "server",
      database: "app_db",
      table: orders,
      records: [{ name: "a" }, { name: null }],
    });
    await schema("server", "analytics");
    expect(invoke).toHaveBeenLastCalledWith("dbde_get_schema_tree", {
      connectionId: "server",
      database: "analytics",
    });
    const table = { name: "orders", schema: "public", kind: "table" };
    await columns("server", table, "app_db");
    expect(invoke).toHaveBeenLastCalledWith("dbde_get_columns", {
      connectionId: "server",
      table,
      database: "app_db",
    });
  });
});

it("shares repeated connect requests until registration, then reconnects after disconnect", async () => {
  const config = {
    id: "dedupe",
    name: "Local",
    driver: "mysql" as const,
    host: "dedupe.local",
    port: 3306,
    username: "root",
    password: "",
    database: "",
    ssl_mode: "disable" as const,
    file_path: "",
  };
  invoke.mockReset();
  let resolve!: (id: string) => void;
  invoke.mockImplementationOnce(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  const first = connect(config);
  const second = connect({
    ...config,
    id: "alias",
    name: "Alias",
    database: "app",
  });
  expect(invoke).toHaveBeenCalledTimes(1);
  resolve("shared-session");
  expect(await first).toBe("shared-session");
  expect(await second).toBe("shared-session");
  expect(await connect(config)).toBe("shared-session");
  expect(invoke).toHaveBeenCalledTimes(1);
  invoke.mockResolvedValueOnce(undefined);
  await disconnect("shared-session");
  invoke.mockResolvedValueOnce("new-session");
  expect(await connect(config)).toBe("new-session");
  expect(
    invoke.mock.calls.filter(([command]) => command === "dbde_connect"),
  ).toHaveLength(2);
  invoke.mockResolvedValueOnce(undefined);
  await disconnect("new-session");
});
it("allows retrying a failed connection instead of caching its rejection", async () => {
  const config = {
    id: "retry",
    name: "Retry",
    driver: "mysql" as const,
    host: "retry.local",
    port: 3306,
    username: "root",
    database: "",
    ssl_mode: "disable" as const,
    file_path: "",
  };
  invoke.mockReset();
  invoke.mockRejectedValueOnce(new Error("Access denied"));
  await expect(connect(config)).rejects.toThrow("Access denied");
  invoke.mockResolvedValueOnce("retried-session");
  expect(await connect(config)).toBe("retried-session");
  expect(invoke).toHaveBeenCalledTimes(2);
  invoke.mockResolvedValueOnce(undefined);
  await disconnect("retried-session");
});

it("rejects invalid values before desktop mutation IPC, including atomic batches", async () => {
  invoke.mockReset();
  const source = {
    database: "app_db",
    table: { name: "customers", schema: "", kind: "table" },
    primary_keys: ["id"],
  };
  invoke.mockResolvedValue(metadata);
  await expect(
    updateCell("server", source, { id: 1 }, "id", "oops"),
  ).rejects.toThrow("whole number");
  await expect(
    insertRecord("server", source, { name: "x".repeat(21) }),
  ).rejects.toThrow("Maximum 20");
  await expect(
    applyChanges("server", source, [
      { kind: "insert", values: { name: "OK" } },
      { kind: "insert", values: { id: null } },
    ]),
  ).rejects.toThrow("NULL is not allowed");
  expect(
    invoke.mock.calls.every(([command]) => command === "dbde_get_columns"),
  ).toBe(true);
});

it("sends a validated creation plan to the native transactional DDL command", async () => {
  const { useWorkspace } = await import("../store");
  const { newTableDesign } = await import("./table-designer");
  const { createTable } = await import("./api");
  const before = useWorkspace.getState().sessions;
  useWorkspace.setState({
    sessions: [
      {
        id: "designer-server",
        config: {
          id: "designer-profile",
          name: "Designer",
          driver: "mysql",
          host: "localhost",
          port: 3306,
          username: "root",
          ssl_mode: "disable",
          database: "app",
          file_path: "",
        },
      },
    ],
  });
  try {
    invoke.mockReset();
    invoke.mockResolvedValue(undefined);
    const design = newTableDesign("mysql", "app");
    design.name = "new_records";
    expect(await createTable("designer-server", "app", design)).toEqual({
      name: "new_records",
      schema: "app",
      kind: "table",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("dbde_create_table", {
      connectionId: "designer-server",
      database: "app",
      statements: [expect.stringContaining("CREATE TABLE `app`.`new_records`")],
    });
  } finally {
    useWorkspace.setState({ sessions: before });
  }
});

it("opens a fresh replacement pool for edited credentials instead of reusing the active connection", async () => {
  const { connectFresh } = await import("./api");
  const config = {
    id: "edited",
    name: "Edited",
    driver: "mysql" as const,
    host: "localhost",
    port: 3306,
    username: "root",
    password: "changed-secret",
    database: "app",
    ssl_mode: "disable" as const,
    file_path: "",
  };
  invoke.mockReset();
  invoke.mockResolvedValue("fresh-id");
  expect(await connectFresh(config)).toBe("fresh-id");
  expect(invoke).toHaveBeenCalledWith("dbde_connect", { config });
});

it("passes the requested foreign-key check mode to the native table-delete command", async () => {
  const { dropTable } = await import("./api");
  const table = { name: "tamu_copy1", schema: "shop", kind: "table" };
  invoke.mockResolvedValueOnce(undefined);
  await dropTable("server", "shop", table, "disable");
  expect(invoke).toHaveBeenLastCalledWith("dbde_drop_table", {
    connectionId: "server",
    database: "shop",
    table,
    foreignKeyChecks: "disable",
  });
});

it("sends source and destination database identities when pasting a table", async () => {
  const { pasteTable } = await import("./api");
  const source = { name: "customers", schema: "shop", kind: "table" };
  const target = { name: "customers", schema: "archive", kind: "table" };
  invoke.mockResolvedValueOnce(undefined);
  await pasteTable("source", "shop", source, "target", "archive", target, true);
  expect(invoke).toHaveBeenLastCalledWith("dbde_copy_table", {
    connectionId: "source",
    database: "shop",
    table: source,
    target,
    data: true,
    destination: { connectionId: "target", database: "archive" },
  });
});

describe("export wizard IPC", () => {
  const table = { name: "orders", schema: "shop", kind: "table" };
  const options = {
    ...defaultExportOptions(["id", "total"]),
    format: "xlsx" as const,
  };
  it("streams a table export with the grid view, an export ID and a progress channel but no path", async () => {
    invoke.mockResolvedValueOnce({
      path: "/tmp/orders.xlsx",
      rows: 3,
      sheets: 1,
      truncated_cells: 0,
    });
    const progress = vi.fn();
    const filters = [
      { column: "total", operator: "contains" as const, value: "5" },
    ];
    const sort = { column: "id", direction: "desc" as const };
    const summary = await exportTable(
      "local",
      "shop",
      table,
      options,
      { filters, sort },
      "exp-1",
      progress,
    );
    expect(summary?.rows).toBe(3);
    const [command, args] = invoke.mock.lastCall!;
    expect(command).toBe("dbde_export_table");
    expect(args).toEqual({
      connectionId: "local",
      database: "shop",
      table,
      options,
      filters,
      sort,
      exportId: "exp-1",
      onProgress: expect.any(Channel),
    });
    expect(JSON.stringify(args)).not.toMatch(/"path"/);
    args.onProgress.onmessage({ rows: 2000 });
    expect(progress).toHaveBeenCalledWith(2000);
    invoke.mockResolvedValueOnce(null);
    await exportTable("local", "shop", table, options, {}, "exp-2");
    expect(invoke.mock.lastCall![1]).not.toHaveProperty("filters");
    expect(invoke.mock.lastCall![1]).not.toHaveProperty("sort");
  });
  it("sends fetched or selected rows with their columns and cancels by ID", async () => {
    invoke.mockResolvedValueOnce(null);
    await exportRows(
      "local",
      undefined,
      undefined,
      { ...options, format: "sql", table_name: "report" },
      [[1, null]],
      "exp-3",
    );
    const [command, args] = invoke.mock.lastCall!;
    expect(command).toBe("dbde_export_rows");
    expect(args).toMatchObject({
      connectionId: "local",
      rows: [[1, null]],
      exportId: "exp-3",
    });
    expect(args.options.table_name).toBe("report");
    expect(args).not.toHaveProperty("table");
    expect(args).not.toHaveProperty("database");
    await expect(
      exportRows(
        "local",
        "shop",
        table,
        options,
        Array(50001).fill([1, 2]),
        "exp-4",
      ),
    ).rejects.toThrow(/50,000/);
    invoke.mockResolvedValueOnce(undefined);
    await cancelExport("exp-3");
    expect(invoke).toHaveBeenLastCalledWith("dbde_cancel_export", {
      exportId: "exp-3",
    });
  });
});

describe("import wizard IPC", () => {
  const table = { name: "orders", schema: "shop", kind: "table" };
  const options = {
    format: "csv" as const,
    delimiter: ";",
    quote: '"',
    header: true,
    null_text: "\\N",
  };
  it("opens the file in the native dialog and refers to it only by import ID", async () => {
    invoke.mockResolvedValueOnce(null);
    expect(await openImportFile()).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith("dbde_import_open");
    invoke.mockResolvedValueOnce({ import_id: "abc" });
    await previewImport("abc", options);
    expect(invoke).toHaveBeenLastCalledWith("dbde_import_preview", {
      importId: "abc",
      options,
    });
    invoke.mockResolvedValueOnce(undefined);
    await closeImport("abc");
    expect(invoke).toHaveBeenLastCalledWith("dbde_import_close", {
      importId: "abc",
    });
  });
  it("loads the target table and its row count", async () => {
    invoke.mockResolvedValueOnce({
      columns: [],
      primary_keys: [],
      transactional: true,
    });
    await importTarget("local", "shop", table);
    expect(invoke).toHaveBeenLastCalledWith("dbde_import_target", {
      connectionId: "local",
      database: "shop",
      table,
    });
    invoke.mockResolvedValueOnce(12);
    expect(await importRowCount("local", "shop", table)).toBe(12);
    expect(invoke).toHaveBeenLastCalledWith("dbde_import_count", {
      connectionId: "local",
      database: "shop",
      table,
    });
  });
  it("runs the import with a progress channel and cancels by ID", async () => {
    invoke.mockResolvedValueOnce({ rows: 2, inserted: 2 });
    const progress = vi.fn();
    const request = {
      options,
      mapping: [{ source: "Id", target: "id" }],
      mode: "upsert" as const,
      continue_on_error: true,
      batch_rows: 500,
    };
    await runImport("local", "shop", table, "abc", request, progress);
    const [command, args] = invoke.mock.lastCall!;
    expect(command).toBe("dbde_import_run");
    expect(args).toEqual({
      connectionId: "local",
      database: "shop",
      table,
      importId: "abc",
      request,
      onProgress: expect.any(Channel),
    });
    expect(JSON.stringify(args)).not.toMatch(/"path"/);
    args.onProgress.onmessage({ rows: 1500 });
    expect(progress).toHaveBeenCalledWith(1500);
    invoke.mockResolvedValueOnce(undefined);
    await cancelImport("abc");
    expect(invoke).toHaveBeenLastCalledWith("dbde_cancel_import", {
      importId: "abc",
    });
  });
});

it("sends database object requests as structured, validated IPC calls", async () => {
  const { listObjects, objectDefinition, objectAction } = await import("./api");
  const object = {
    kind: "function" as const,
    schema: "app",
    name: "total",
    signature: "integer, text",
  };
  invoke.mockResolvedValueOnce([object]);
  expect(await listObjects("server", "shop", "function")).toEqual([object]);
  expect(invoke).toHaveBeenLastCalledWith("dbde_list_objects", {
    connectionId: "server",
    database: "shop",
    kind: "function",
  });
  invoke.mockResolvedValueOnce({ definition: "CREATE", edit_script: "CREATE" });
  await objectDefinition("server", "shop", object);
  expect(invoke).toHaveBeenLastCalledWith("dbde_object_definition", {
    connectionId: "server",
    database: "shop",
    object,
  });
  invoke.mockResolvedValueOnce('DROP FUNCTION "app"."total"(integer, text)');
  expect(
    await objectAction("server", "shop", object, "drop", { preview: true }),
  ).toBe('DROP FUNCTION "app"."total"(integer, text)');
  expect(invoke).toHaveBeenLastCalledWith("dbde_object_action", {
    connectionId: "server",
    database: "shop",
    object,
    action: "drop",
    preview: true,
  });
  const sequence = { kind: "sequence" as const, schema: "app", name: "ids" };
  invoke.mockResolvedValueOnce("ALTER SEQUENCE");
  await objectAction("server", "shop", sequence, "restart", { value: "10" });
  expect(invoke).toHaveBeenLastCalledWith("dbde_object_action", {
    connectionId: "server",
    database: "shop",
    object: sequence,
    action: "restart",
    value: "10",
  });
});
