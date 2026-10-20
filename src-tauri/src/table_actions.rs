use super::*;
use rows::{qualified, quote};

#[derive(Clone, Copy, Default, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ForeignKeyChecks {
    #[default]
    Default,
    Enable,
    Disable,
}
fn drop_sql(table: &TableInfo, driver: &Driver, checks: ForeignKeyChecks) -> DbResult<String> {
    if !["table", "view"].contains(&table.kind.as_str())
        || table.name.trim().is_empty()
        || table.name.contains('\0')
    {
        return Err("Choose a valid table or view to delete.".into());
    }
    if checks != ForeignKeyChecks::Default && (*driver != Driver::Mysql || table.kind != "table") {
        return Err(
            "Foreign Key Checks overrides are supported only for MySQL/MariaDB tables.".into(),
        );
    }
    Ok(format!(
        "DROP {} {}",
        if table.kind == "view" {
            "VIEW"
        } else {
            "TABLE"
        },
        qualified(table, driver)
    ))
}
async fn drop_table(
    conn: &Connection,
    table: &TableInfo,
    checks: ForeignKeyChecks,
) -> DbResult<()> {
    let sql = drop_sql(table, &conn.config.driver, checks)?;
    match &conn.pool {
        Pool::My(pool) => {
            if !table.schema.is_empty() && table.schema != conn.config.database {
                return Err("Table does not belong to the selected database.".into());
            }
            let mut socket = pool.acquire().await.map_err(err)?;
            // Never return changed FOREIGN_KEY_CHECKS state to the shared pool,
            // even when DROP fails or the command future is cancelled.
            socket.close_on_drop();
            let setting = match checks {
                ForeignKeyChecks::Default => None,
                ForeignKeyChecks::Enable => Some("SET SESSION FOREIGN_KEY_CHECKS = 1"),
                ForeignKeyChecks::Disable => Some("SET SESSION FOREIGN_KEY_CHECKS = 0"),
            };
            if let Some(setting) = setting {
                sqlx::query(setting)
                    .execute(&mut *socket)
                    .await
                    .map_err(err)?;
            }
            sqlx::query(&sql).execute(&mut *socket).await.map_err(err)?;
        }
        _ => {
            raw_pool_query(&conn.pool, &sql).await?;
        }
    }
    Ok(())
}
/// SQL that renames a table or view within its own schema, after validating the name.
fn rename_sql(table: &TableInfo, new_name: &str, driver: &Driver) -> DbResult<String> {
    if !["table", "view"].contains(&table.kind.as_str()) || table.name.contains('\0') {
        return Err("Choose a valid table or view to rename.".into());
    }
    if new_name.trim().is_empty() || new_name.trim() != new_name {
        return Err("Enter a new name without leading or trailing spaces.".into());
    }
    if new_name.contains('\0') {
        return Err("The new name contains an invalid character.".into());
    }
    // PostgreSQL silently truncates names over 63 bytes; MySQL rejects over 64 chars.
    let too_long = match driver {
        Driver::Postgres => new_name.len() > 63,
        Driver::Mysql => new_name.chars().count() > 64,
        Driver::Sqlite => new_name.chars().count() > 128,
    };
    if too_long {
        return Err(match driver {
            Driver::Postgres => "PostgreSQL names are limited to 63 bytes.",
            Driver::Mysql => "MySQL table names are limited to 64 characters.",
            Driver::Sqlite => "Use a name of at most 128 characters.",
        }
        .into());
    }
    if new_name == table.name {
        return Err("The new name is the same as the current name.".into());
    }
    let source = qualified(table, driver);
    let target = TableInfo {
        name: new_name.into(),
        ..table.clone()
    };
    Ok(match driver {
        // RENAME TABLE handles views too and keeps the object in the same schema.
        Driver::Mysql => format!("RENAME TABLE {source} TO {}", qualified(&target, driver)),
        // The new name is unqualified: PostgreSQL keeps the object in its schema.
        Driver::Postgres => format!(
            "ALTER {} {source} RENAME TO {}",
            if table.kind == "view" {
                "VIEW"
            } else {
                "TABLE"
            },
            quote(new_name, driver)
        ),
        Driver::Sqlite => {
            if table.kind == "view" {
                return Err(
                    "SQLite cannot rename a view. Recreate it with the new name instead.".into(),
                );
            }
            format!("ALTER TABLE {source} RENAME TO {}", quote(new_name, driver))
        }
    })
}
async fn rename_table(conn: &Connection, table: &TableInfo, new_name: &str) -> DbResult<TableInfo> {
    let sql = rename_sql(table, new_name, &conn.config.driver)?;
    if matches!(conn.config.driver, Driver::Mysql)
        && !table.schema.is_empty()
        && table.schema != conn.config.database
    {
        return Err("Table does not belong to the selected database.".into());
    }
    raw_pool_query(&conn.pool, &sql).await?;
    Ok(TableInfo {
        name: new_name.into(),
        ..table.clone()
    })
}
#[tauri::command]
pub(crate) async fn dbde_rename_table(
    connection_id: String,
    database: String,
    table: TableInfo,
    new_name: String,
    state: State<'_, AppState>,
) -> DbResult<TableInfo> {
    timed(async {
        let conn = database_connection(&state, &connection_id, Some(&database)).await?;
        rename_table(&conn, &table, &new_name).await
    })
    .await
}
#[tauri::command]
pub(crate) async fn dbde_drop_table(
    connection_id: String,
    database: String,
    table: TableInfo,
    foreign_key_checks: Option<ForeignKeyChecks>,
    state: State<'_, AppState>,
) -> DbResult<()> {
    timed(async {
        let conn = database_connection(&state, &connection_id, Some(&database)).await?;
        drop_table(&conn, &table, foreign_key_checks.unwrap_or_default()).await
    })
    .await
}

async fn writable_columns(conn: &Connection, table: &TableInfo) -> DbResult<Vec<String>> {
    match &conn.pool {
        Pool::Pg(p) => sqlx::query_scalar("SELECT a.attname::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' ORDER BY a.attnum")
            .bind(&table.schema).bind(&table.name).fetch_all(p).await.map_err(err),
        Pool::My(p) => sqlx::query_scalar("SELECT CAST(column_name AS CHAR) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND COALESCE(generation_expression, '') = '' ORDER BY ordinal_position")
            .bind(&table.name).fetch_all(p).await.map_err(err),
        Pool::Lite(p) => sqlx::query_scalar("SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid")
            .bind(&table.name).fetch_all(p).await.map_err(err),
    }
}
// Find the definition's opening parenthesis outside quoted identifiers.
fn definition_body(sql: &str) -> DbResult<&str> {
    let mut quoted = None;
    for (i, ch) in sql.char_indices() {
        if let Some(q) = quoted {
            if ch == q {
                quoted = None;
            }
        } else if ['\'', '"', '`', '['].contains(&ch) {
            quoted = Some(if ch == '[' { ']' } else { ch });
        } else if ch == '(' {
            return Ok(&sql[i..]);
        }
    }
    Err("Cannot read the table definition".into())
}
async fn copy_table(
    conn: &Connection,
    table: &TableInfo,
    target: &TableInfo,
    data: bool,
) -> DbResult<()> {
    if table.kind != "table"
        || target.name.trim().is_empty()
        || target.name.len() > 128
        || target.name.contains('\0')
    {
        return Err("Choose a table and a valid new name (up to 128 characters)".into());
    }
    let driver = &conn.config.driver;
    let source_sql = qualified(table, driver);
    let target_sql = qualified(target, driver);
    if source_sql == target_sql {
        return Err("Choose a different target table name".into());
    }
    let columns = writable_columns(conn, table).await?;
    let names = columns
        .iter()
        .map(|n| quote(n, driver))
        .collect::<Vec<_>>()
        .join(", ");
    let insert = format!(
        "INSERT INTO {target_sql} ({names}) {} SELECT {names} FROM {source_sql}",
        if *driver == Driver::Postgres {
            "OVERRIDING SYSTEM VALUE"
        } else {
            ""
        }
    );
    match &conn.pool {
        Pool::My(p) => {
            sqlx::query(&format!("CREATE TABLE {target_sql} LIKE {source_sql}"))
                .execute(p)
                .await
                .map_err(err)?;
            if data {
                if let Err(e) = sqlx::query(&insert).execute(p).await {
                    let cleanup = sqlx::query(&format!("DROP TABLE {target_sql}"))
                        .execute(p)
                        .await;
                    return Err(format!(
                        "Copy failed: {e}. {}",
                        if cleanup.is_ok() {
                            "The new table was removed."
                        } else {
                            "The new table remains; inspect it before retrying."
                        }
                    ));
                }
            }
        }
        Pool::Pg(p) => {
            let mut tx = p.begin().await.map_err(err)?;
            sqlx::query(&format!(
                "CREATE TABLE {target_sql} (LIKE {source_sql} INCLUDING ALL)"
            ))
            .execute(&mut *tx)
            .await
            .map_err(err)?;
            // LIKE copies serial defaults by reference. Replace them with independent identity sequences.
            let serial: Vec<String> = sqlx::query_scalar("SELECT a.attname::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND a.attidentity = '' AND pg_get_serial_sequence(format('%I.%I', n.nspname, c.relname), a.attname) IS NOT NULL")
                .bind(&table.schema).bind(&table.name).fetch_all(&mut *tx).await.map_err(err)?;
            for name in serial {
                let col = quote(&name, driver);
                sqlx::query(&format!(
                    "ALTER TABLE {target_sql} ALTER COLUMN {col} DROP DEFAULT"
                ))
                .execute(&mut *tx)
                .await
                .map_err(err)?;
                sqlx::query(&format!("ALTER TABLE {target_sql} ALTER COLUMN {col} ADD GENERATED BY DEFAULT AS IDENTITY")).execute(&mut *tx).await.map_err(err)?;
            }
            if data {
                sqlx::query(&insert).execute(&mut *tx).await.map_err(err)?;
            }
            for name in &columns {
                let sequence: Option<String> =
                    sqlx::query_scalar("SELECT pg_get_serial_sequence($1, $2)")
                        .bind(&target_sql)
                        .bind(name)
                        .fetch_one(&mut *tx)
                        .await
                        .map_err(err)?;
                if let Some(sequence) = sequence {
                    let max: Option<i64> = sqlx::query_scalar(&format!(
                        "SELECT MAX({})::bigint FROM {target_sql}",
                        quote(name, driver)
                    ))
                    .fetch_one(&mut *tx)
                    .await
                    .map_err(err)?;
                    if let Some(max) = max {
                        sqlx::query("SELECT setval($1::regclass, $2, true)")
                            .bind(sequence)
                            .bind(max)
                            .execute(&mut *tx)
                            .await
                            .map_err(err)?;
                    }
                }
            }
            tx.commit().await.map_err(err)?;
        }
        Pool::Lite(p) => {
            if !target.schema.is_empty() && target.schema != "main" {
                return Err("SQLite copies stay in the current database".into());
            }
            let ddl: String = sqlx::query_scalar(
                "SELECT sql FROM sqlite_master WHERE name = ? AND type = 'table'",
            )
            .bind(&table.name)
            .fetch_one(p)
            .await
            .map_err(err)?;
            let indexes: Vec<String> = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type = 'index' AND sql IS NOT NULL ORDER BY name").bind(&table.name).fetch_all(p).await.map_err(err)?;
            let mut tx = p.begin().await.map_err(err)?;
            sqlx::query(&format!(
                "CREATE TABLE {target_sql} {}",
                definition_body(&ddl)?
            ))
            .execute(&mut *tx)
            .await
            .map_err(err)?;
            for (i, index) in indexes.iter().enumerate() {
                let unique = index
                    .trim_start()
                    .to_uppercase()
                    .starts_with("CREATE UNIQUE INDEX");
                let name = quote(&format!("{}_copy_index_{}", target.name, i + 1), driver);
                sqlx::query(&format!(
                    "CREATE {}INDEX {name} ON {target_sql} {}",
                    if unique { "UNIQUE " } else { "" },
                    definition_body(index)?
                ))
                .execute(&mut *tx)
                .await
                .map_err(err)?;
            }
            if data {
                sqlx::query(&insert).execute(&mut *tx).await.map_err(err)?;
            }
            tx.commit().await.map_err(err)?;
        }
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CopyDestination {
    connection_id: String,
    database: String,
}
#[tauri::command]
pub(crate) async fn dbde_copy_table(
    connection_id: String,
    database: String,
    table: TableInfo,
    target: TableInfo,
    data: bool,
    destination: Option<CopyDestination>,
    state: State<'_, AppState>,
) -> DbResult<()> {
    let conn = database_connection(&state, &connection_id, Some(&database)).await?;
    let mut target = target;
    if let Some(request) = destination {
        let target_id = request.connection_id;
        let destination = connection(&state, &target_id).await?;
        let target_database = request.database;
        if target_database.is_empty() {
            return Err("Choose a target database.".into());
        }
        validate_copy_destination(
            &conn.config,
            &destination.config,
            &database,
            &target_database,
            connection_id == target_id,
        )?;
        if matches!(conn.config.driver, Driver::Mysql) {
            target.schema = target_database;
        }
    }
    copy_table(&conn, &table, &target, data).await
}
fn validate_copy_destination(
    source: &ConnectionConfig,
    target: &ConnectionConfig,
    source_database: &str,
    target_database: &str,
    same_connection: bool,
) -> DbResult<()> {
    if source.driver != target.driver {
        return Err("Table copy requires matching database engines. Use Transfer records for different engines.".into());
    }
    match source.driver {
        Driver::Mysql if same_server(source, target) => Ok(()),
        Driver::Postgres if same_server(source, target) && source_database == target_database => Ok(()),
        Driver::Sqlite if same_connection => Ok(()),
        _ => Err("Direct table copy supports MySQL/MariaDB databases on the same server, or the same PostgreSQL/SQLite database. Use export/import for another server or database engine.".into()),
    }
}
async fn clear_table(conn: &Connection, table: &TableInfo, reset_identity: bool) -> DbResult<()> {
    if table.kind != "table" {
        return Err("Views cannot be emptied or truncated".into());
    }
    let target = qualified(table, &conn.config.driver);
    if reset_identity {
        match &conn.pool {
            Pool::Pg(_) => {
                query(
                    &conn.pool,
                    &format!("TRUNCATE TABLE {target} RESTART IDENTITY"),
                )
                .await?;
            }
            Pool::My(_) => {
                query(&conn.pool, &format!("TRUNCATE TABLE {target}")).await?;
            }
            Pool::Lite(p) => {
                let mut tx = p.begin().await.map_err(err)?;
                sqlx::query(&format!("DELETE FROM {target}"))
                    .execute(&mut *tx)
                    .await
                    .map_err(err)?;
                let exists: i64 = sqlx::query_scalar(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name = 'sqlite_sequence'",
                )
                .fetch_one(&mut *tx)
                .await
                .map_err(err)?;
                if exists > 0 {
                    sqlx::query("DELETE FROM sqlite_sequence WHERE name = ?")
                        .bind(&table.name)
                        .execute(&mut *tx)
                        .await
                        .map_err(err)?;
                }
                tx.commit().await.map_err(err)?;
            }
        }
    } else {
        query(&conn.pool, &format!("DELETE FROM {target}")).await?;
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn dbde_clear_table(
    connection_id: String,
    database: String,
    table: TableInfo,
    reset_identity: bool,
    state: State<'_, AppState>,
) -> DbResult<()> {
    let conn = database_connection(&state, &connection_id, Some(&database)).await?;
    clear_table(&conn, &table, reset_identity).await
}
#[tauri::command]
pub(crate) async fn dbde_export_columns(
    connection_id: String,
    database: String,
    table: TableInfo,
    state: State<'_, AppState>,
) -> DbResult<Vec<String>> {
    let conn = database_connection(&state, &connection_id, Some(&database)).await?;
    writable_columns(&conn, &table).await
}

pub(crate) async fn binary_columns(conn: &Connection, table: &TableInfo) -> DbResult<Vec<String>> {
    match &conn.pool {
        Pool::Pg(p) => sqlx::query_scalar("SELECT a.attname::text FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND a.atttypid = 'bytea'::regtype AND a.attnum > 0 AND NOT a.attisdropped").bind(&table.schema).bind(&table.name).fetch_all(p).await.map_err(err),
        Pool::My(p) => sqlx::query_scalar("SELECT CAST(column_name AS CHAR) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND data_type IN ('blob', 'tinyblob', 'mediumblob', 'longblob', 'binary', 'varbinary')").bind(&table.name).fetch_all(p).await.map_err(err),
        Pool::Lite(p) => sqlx::query_scalar("SELECT name FROM pragma_table_xinfo(?) WHERE upper(type) LIKE '%BLOB%'").bind(&table.name).fetch_all(p).await.map_err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn table(name: &str) -> TableInfo {
        TableInfo {
            name: name.into(),
            schema: "".into(),
            kind: "table".into(),
        }
    }
    #[test]
    fn table_paste_checks_the_actual_connection_route_and_engine() {
        let source = crate::tests::config(Driver::Mysql);
        let mut target = source.clone();
        target.database = "archive".into();
        assert!(validate_copy_destination(&source, &target, "shop", "archive", false).is_ok());
        target.host = "another-server".into();
        assert!(validate_copy_destination(&source, &target, "shop", "archive", false).is_err());
        target = source.clone();
        target.driver = Driver::Postgres;
        assert!(validate_copy_destination(&source, &target, "shop", "archive", false).is_err());
        let pg = crate::tests::config(Driver::Postgres);
        assert!(validate_copy_destination(&pg, &pg, "shop", "archive", true).is_err());
        let lite = crate::tests::config(Driver::Sqlite);
        assert!(validate_copy_destination(&lite, &lite, "main", "main", false).is_err());
        assert!(validate_copy_destination(&lite, &lite, "main", "main", true).is_ok());
    }
    #[test]
    fn drop_quotes_names_and_rejects_unsupported_fk_overrides() {
        let name = table("tamu ` copy");
        assert_eq!(
            drop_sql(&name, &Driver::Mysql, ForeignKeyChecks::Disable).unwrap(),
            "DROP TABLE `tamu `` copy`"
        );
        assert!(drop_sql(&name, &Driver::Postgres, ForeignKeyChecks::Disable).is_err());
        assert!(drop_sql(&name, &Driver::Sqlite, ForeignKeyChecks::Enable).is_err());
    }
    #[tokio::test]
    async fn drop_removes_only_the_selected_table_and_fails_before_unsupported_overrides() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let conn = Connection {
            tunnel: None,
            pool: Pool::Lite(pool),
            config: crate::tests::config(Driver::Sqlite),
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        };
        query(&conn.pool, "CREATE TABLE \"tamu copy1\" (id INTEGER)")
            .await
            .unwrap();
        query(&conn.pool, "CREATE TABLE keep_me (id INTEGER)")
            .await
            .unwrap();
        let target = table("tamu copy1");
        assert!(drop_table(&conn, &target, ForeignKeyChecks::Disable)
            .await
            .is_err());
        assert!(query(&conn.pool, "SELECT * FROM \"tamu copy1\"")
            .await
            .is_ok());
        drop_table(&conn, &target, ForeignKeyChecks::Default)
            .await
            .unwrap();
        assert!(query(&conn.pool, "SELECT * FROM \"tamu copy1\"")
            .await
            .is_err());
        assert!(query(&conn.pool, "SELECT * FROM keep_me").await.is_ok());
        close(conn.pool).await;
    }
    #[tokio::test]
    async fn copy_preserves_constraints_indexes_and_generated_columns_without_overwriting() {
        let p = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let conn = Connection {
            tunnel: None,
            pool: Pool::Lite(p),
            config: crate::tests::config(Driver::Sqlite),
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        };
        raw_pool_query(&conn.pool, "CREATE TABLE \"a(b\" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, upper_name TEXT GENERATED ALWAYS AS (upper(name)) STORED); CREATE UNIQUE INDEX \"i(x\" ON \"a(b\" (name); INSERT INTO \"a(b\" (name) VALUES ('Ada');").await.unwrap();
        copy_table(&conn, &table("a(b"), &table("copy"), true)
            .await
            .unwrap();
        assert_eq!(
            query(&conn.pool, "SELECT name, upper_name FROM copy")
                .await
                .unwrap()
                .rows[0],
            vec![json!("Ada"), json!("ADA")]
        );
        assert!(query(&conn.pool, "INSERT INTO copy (name) VALUES ('Ada')")
            .await
            .is_err());
        assert!(copy_table(&conn, &table("a(b"), &table("copy"), true)
            .await
            .is_err());
        clear_table(&conn, &table("copy"), false).await.unwrap();
        query(&conn.pool, "INSERT INTO copy (name) VALUES ('B')")
            .await
            .unwrap();
        assert_eq!(
            query(&conn.pool, "SELECT id FROM copy").await.unwrap().rows[0][0],
            json!(2)
        );
        clear_table(&conn, &table("copy"), true).await.unwrap();
        query(&conn.pool, "INSERT INTO copy (name) VALUES ('C')")
            .await
            .unwrap();
        assert_eq!(
            query(&conn.pool, "SELECT id FROM copy").await.unwrap().rows[0][0],
            json!(1)
        );
        copy_table(&conn, &table("a(b"), &table("empty"), false)
            .await
            .unwrap();
        assert!(query(&conn.pool, "SELECT * FROM empty")
            .await
            .unwrap()
            .rows
            .is_empty());
    }
    #[test]
    fn rename_builds_per_driver_sql_and_validates_names() {
        let odd = TableInfo {
            name: "old`\"name".into(),
            schema: "app".into(),
            kind: "table".into(),
        };
        assert_eq!(
            rename_sql(&odd, "new name", &Driver::Mysql).unwrap(),
            "RENAME TABLE `app`.`old``\"name` TO `app`.`new name`"
        );
        assert_eq!(
            rename_sql(&odd, "Ne\"w", &Driver::Postgres).unwrap(),
            "ALTER TABLE \"app\".\"old`\"\"name\" RENAME TO \"Ne\"\"w\""
        );
        let view = TableInfo {
            kind: "view".into(),
            ..table("v")
        };
        assert_eq!(
            rename_sql(&view, "w", &Driver::Postgres).unwrap(),
            "ALTER VIEW \"v\" RENAME TO \"w\""
        );
        assert!(rename_sql(&view, "w", &Driver::Sqlite)
            .unwrap_err()
            .contains("cannot rename a view"));
        for bad in ["", " padded", "trailing ", "nul\0"] {
            assert!(
                rename_sql(&table("t"), bad, &Driver::Mysql).is_err(),
                "{bad:?}"
            );
        }
        assert!(rename_sql(&table("t"), "t", &Driver::Mysql).is_err());
        assert!(rename_sql(&table("t"), &"x".repeat(65), &Driver::Mysql).is_err());
        assert!(rename_sql(&table("t"), &"x".repeat(64), &Driver::Mysql).is_ok());
        // 32 two-byte characters are 64 bytes: over PostgreSQL's limit.
        assert!(rename_sql(&table("t"), &"é".repeat(32), &Driver::Postgres).is_err());
        assert!(rename_sql(&table("t"), &"é".repeat(31), &Driver::Postgres).is_ok());
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_PG_URL; renames only a session-local temporary table"]
    async fn rename_works_on_postgres_with_quoted_names() {
        let url = std::env::var("DBDE_TEST_PG_URL").unwrap();
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let conn = Connection {
            pool: Pool::Pg(pool),
            config: crate::tests::config(Driver::Postgres),
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            tunnel: None,
        };
        raw_pool_query(
            &conn.pool,
            "CREATE TEMPORARY TABLE \"Old Name\" (id int); INSERT INTO \"Old Name\" VALUES (7)",
        )
        .await
        .unwrap();
        let schema = query(
            &conn.pool,
            "SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema()",
        )
        .await
        .unwrap()
        .rows[0][0]
            .as_str()
            .unwrap()
            .to_string();
        let old = TableInfo {
            name: "Old Name".into(),
            schema: schema.clone(),
            kind: "table".into(),
        };
        let renamed = rename_table(&conn, &old, "New \"Name\"").await.unwrap();
        assert_eq!(renamed.schema, schema);
        let rows = query(&conn.pool, "SELECT id FROM \"New \"\"Name\"\"\"")
            .await
            .unwrap()
            .rows;
        assert_eq!(rows, vec![vec![json!(7)]]);
    }
    #[tokio::test]
    async fn rename_keeps_rows_and_rejects_existing_names_on_sqlite() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let conn = Connection {
            pool: Pool::Lite(pool),
            config: crate::tests::config(Driver::Sqlite),
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            tunnel: None,
        };
        raw_pool_query(&conn.pool, "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO people VALUES (1, 'Ada'); CREATE TABLE taken (id INTEGER)").await.unwrap();
        let renamed = rename_table(&conn, &table("people"), "staff")
            .await
            .unwrap();
        assert_eq!(renamed.name, "staff");
        let rows = query(&conn.pool, "SELECT id, name FROM staff")
            .await
            .unwrap()
            .rows;
        assert_eq!(rows, vec![vec![json!(1), json!("Ada")]]);
        assert!(query(&conn.pool, "SELECT * FROM people").await.is_err());
        assert!(rename_table(&conn, &table("staff"), "taken").await.is_err());
        assert_eq!(
            query(&conn.pool, "SELECT COUNT(*) FROM staff")
                .await
                .unwrap()
                .rows,
            vec![vec![json!(1)]]
        );
    }
}
