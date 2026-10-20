//! Table maintenance (Navicat's "Maintain" submenu): ANALYZE, CHECK, OPTIMIZE, REPAIR,
//! VACUUM and REINDEX. Operations are an enum validated per driver and every name is
//! quoted here, so the webview can never pass SQL through this command.
use super::*;
use rows::{qualified, quote};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum MaintainOp {
    Analyze,
    Check,
    Optimize,
    Repair,
    Vacuum,
    VacuumAnalyze,
    VacuumFull,
    Reindex,
    IntegrityCheck,
    QuickCheck,
}
impl MaintainOp {
    fn label(self) -> &'static str {
        match self {
            Self::Analyze => "analyze",
            Self::Check => "check",
            Self::Optimize => "optimize",
            Self::Repair => "repair",
            Self::Vacuum => "vacuum",
            Self::VacuumAnalyze => "vacuum analyze",
            Self::VacuumFull => "vacuum full",
            Self::Reindex => "reindex",
            Self::IntegrityCheck => "integrity check",
            Self::QuickCheck => "quick check",
        }
    }
}
const MAX_TABLES: usize = 500;
/// MySQL engines that implement REPAIR TABLE.
pub(crate) fn repairable_engine(engine: &str) -> bool {
    ["myisam", "aria", "archive", "csv"].contains(&engine.to_ascii_lowercase().as_str())
}
/// The statements an operation runs, one per table except where the server takes a list
/// (MySQL's *_TABLE statements) or the operation is database-wide (SQLite VACUUM).
pub(crate) fn maintain_sql(
    op: MaintainOp,
    driver: &Driver,
    tables: &[TableInfo],
) -> DbResult<Vec<String>> {
    use MaintainOp::*;
    let supported = match driver {
        Driver::Mysql => matches!(op, Analyze | Check | Optimize | Repair),
        Driver::Postgres => matches!(op, Analyze | Vacuum | VacuumAnalyze | VacuumFull | Reindex),
        Driver::Sqlite => matches!(op, Analyze | IntegrityCheck | QuickCheck | Vacuum | Reindex),
    };
    if !supported {
        return Err(format!(
            "{} is not available for this database type.",
            op.label()
        ));
    }
    if driver == &Driver::Sqlite && op == Vacuum {
        // VACUUM rebuilds the whole database file; it takes no table names.
        return Ok(vec!["VACUUM".into()]);
    }
    if tables.is_empty() {
        return Err("Choose at least one table.".into());
    }
    if tables.len() > MAX_TABLES {
        return Err(format!("Maintain at most {MAX_TABLES} tables at a time."));
    }
    if tables.iter().any(|t| {
        t.kind != "table"
            || t.name.trim().is_empty()
            || t.name.contains('\0')
            || t.schema.contains('\0')
    }) {
        return Err("Maintenance applies to tables only; views were selected.".into());
    }
    let names = tables.iter().map(|t| qualified(t, driver));
    Ok(match driver {
        Driver::Mysql => {
            let verb = match op {
                Analyze => "ANALYZE",
                Check => "CHECK",
                Optimize => "OPTIMIZE",
                _ => "REPAIR",
            };
            vec![format!(
                "{verb} TABLE {}",
                names.collect::<Vec<_>>().join(", ")
            )]
        }
        Driver::Postgres => {
            let verb = match op {
                Analyze => "ANALYZE",
                Vacuum => "VACUUM",
                VacuumAnalyze => "VACUUM ANALYZE",
                VacuumFull => "VACUUM FULL",
                _ => "REINDEX TABLE",
            };
            names.map(|name| format!("{verb} {name}")).collect()
        }
        Driver::Sqlite => tables
            .iter()
            .map(|t| {
                let schema = if t.schema.is_empty() {
                    String::new()
                } else {
                    format!("{}.", quote(&t.schema, driver))
                };
                let name = quote(&t.name, driver);
                match op {
                    Analyze => format!("ANALYZE {schema}{name}"),
                    Reindex => format!("REINDEX {schema}{name}"),
                    IntegrityCheck => format!("PRAGMA {schema}integrity_check({name})"),
                    _ => format!("PRAGMA {schema}quick_check({name})"),
                }
            })
            .collect(),
    })
}
#[derive(Serialize, Debug, PartialEq)]
pub(crate) struct MaintainRow {
    table: String,
    op: String,
    msg_type: String,
    msg_text: String,
}
#[derive(Serialize, Debug)]
pub(crate) struct MaintainOutput {
    statements: Vec<String>,
    rows: Vec<MaintainRow>,
    execution_ms: f64,
}
/// Where maintenance runs: a dedicated server connection (never inside a transaction
/// block, which VACUUM forbids) or SQLite's single pooled connection.
pub(crate) enum Target {
    Pg(sqlx::PgConnection),
    My(sqlx::MySqlConnection),
    Lite(sqlx::SqlitePool),
}
async fn fetch(target: &mut Target, sql: &str) -> DbResult<Vec<Vec<Value>>> {
    macro_rules! rows {
        ($exec:expr, $cell:ident) => {{
            // A bare string has no arguments, so it runs over the simple protocol:
            // one implicit statement, never wrapped in a transaction block.
            let rows = ($exec).fetch_all(sql).await.map_err(err)?;
            rows.iter()
                .map(|row| (0..row.len()).map(|i| $cell(row, i)).collect())
                .collect()
        }};
    }
    match target {
        Target::Pg(c) => rows!(&mut *c, pg_cell),
        Target::My(c) => rows!(&mut *c, my_cell),
        Target::Lite(p) => rows!(&*p, lite_cell),
    }
}
fn text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}
fn display(table: &TableInfo) -> String {
    if table.schema.is_empty() {
        table.name.clone()
    } else {
        format!("{}.{}", table.schema, table.name)
    }
}
pub(crate) async fn maintain_on(
    target: &mut Target,
    driver: &Driver,
    op: MaintainOp,
    tables: &[TableInfo],
    database: &str,
) -> DbResult<MaintainOutput> {
    let statements = maintain_sql(op, driver, tables)?;
    let start = Instant::now();
    let mut rows = Vec::new();
    match driver {
        // The server reports Table, Op, Msg_type and Msg_text for every table.
        Driver::Mysql => {
            for row in fetch(target, &statements[0]).await? {
                rows.push(MaintainRow {
                    table: text(row.first()),
                    op: text(row.get(1)),
                    msg_type: text(row.get(2)),
                    msg_text: text(row.get(3)),
                });
            }
        }
        // One statement per table so a failure is reported without stopping the rest.
        Driver::Postgres => {
            for (table, sql) in tables.iter().zip(&statements) {
                let began = Instant::now();
                let outcome = fetch(target, sql).await;
                rows.push(MaintainRow {
                    table: display(table),
                    op: op.label().into(),
                    msg_type: if outcome.is_ok() { "status" } else { "error" }.into(),
                    msg_text: match outcome {
                        Ok(_) => format!("OK ({:.0} ms)", began.elapsed().as_secs_f64() * 1000.0),
                        Err(e) => e,
                    },
                });
            }
        }
        Driver::Sqlite => {
            let names: Vec<String> = if op == MaintainOp::Vacuum {
                vec![database.into()]
            } else {
                tables.iter().map(display).collect()
            };
            for (name, sql) in names.iter().zip(&statements) {
                match fetch(target, sql).await {
                    Ok(found) if found.is_empty() => rows.push(MaintainRow {
                        table: name.clone(),
                        op: op.label().into(),
                        msg_type: "status".into(),
                        msg_text: "OK".into(),
                    }),
                    // integrity_check returns "ok" or one row per problem found.
                    Ok(found) => rows.extend(found.iter().map(|row| {
                        let message = text(row.first());
                        MaintainRow {
                            table: name.clone(),
                            op: op.label().into(),
                            msg_type: if message == "ok" { "status" } else { "error" }.into(),
                            msg_text: if message == "ok" {
                                "OK".into()
                            } else {
                                message
                            },
                        }
                    })),
                    Err(e) => rows.push(MaintainRow {
                        table: name.clone(),
                        op: op.label().into(),
                        msg_type: "error".into(),
                        msg_text: e,
                    }),
                }
            }
        }
    }
    Ok(MaintainOutput {
        statements,
        rows,
        execution_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}
// REPAIR only works on a few engines; InnoDB answers with a note, so say why up front.
async fn check_repairable(conn: &Connection, tables: &[TableInfo]) -> DbResult<()> {
    let Pool::My(pool) = &conn.pool else {
        return Ok(());
    };
    for table in tables {
        let engine: Option<String> = sqlx::query_scalar(
            "SELECT CAST(engine AS CHAR) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
        )
        .bind(&table.name)
        .fetch_optional(pool)
        .await
        .map_err(err)?
        .flatten();
        if let Some(engine) = engine.filter(|e| !repairable_engine(e)) {
            return Err(format!(
                "{} uses {engine}, which does not support REPAIR TABLE. Repair works on MyISAM, Aria, ARCHIVE and CSV tables; use Check or Optimize instead.",
                table.name
            ));
        }
    }
    Ok(())
}
async fn maintain(
    conn: &Connection,
    op: MaintainOp,
    tables: &[TableInfo],
    server_id: &std::sync::Mutex<Option<u64>>,
) -> DbResult<MaintainOutput> {
    let driver = conn.config.driver.clone();
    maintain_sql(op, &driver, tables)?;
    if driver == Driver::Mysql
        && tables
            .iter()
            .any(|t| !t.schema.is_empty() && t.schema != conn.config.database)
    {
        return Err("Table does not belong to the selected database.".into());
    }
    if op == MaintainOp::Repair {
        check_repairable(conn, tables).await?;
    }
    let database = conn.config.database.clone();
    if let Pool::Lite(pool) = &conn.pool {
        let name = PathBuf::from(&conn.config.file_path)
            .file_name()
            .map_or_else(|| "main".into(), |n| n.to_string_lossy().into_owned());
        return maintain_on(&mut Target::Lite(pool.clone()), &driver, op, tables, &name).await;
    }
    let (session, id) = open_session(conn).await?;
    if let Ok(mut slot) = server_id.lock() {
        *slot = Some(id);
    }
    let mut target = match session {
        SessionConn::Pg(c) => Target::Pg(c),
        SessionConn::My(c) => Target::My(c),
    };
    let result = maintain_on(&mut target, &driver, op, tables, &database).await;
    match target {
        Target::Pg(c) => {
            let _ = c.close().await;
        }
        Target::My(c) => {
            let _ = c.close().await;
        }
        Target::Lite(_) => {}
    }
    result
}
#[tauri::command]
pub(crate) async fn dbde_maintain_tables(
    connection_id: String,
    database: String,
    tables: Vec<TableInfo>,
    operation: MaintainOp,
    timeout_secs: Option<u64>,
    state: State<'_, AppState>,
) -> DbResult<MaintainOutput> {
    let conn = timed(database_connection(&state, &connection_id, Some(&database))).await?;
    let seconds = timeout_secs
        .or(conn.config.options.query_timeout_secs)
        .unwrap_or(DEADLINE.as_secs())
        .clamp(1, MAX_QUERY_TIMEOUT_SECS);
    let server_id = std::sync::Mutex::new(None);
    match tokio::time::timeout(
        Duration::from_secs(seconds),
        maintain(&conn, operation, &tables, &server_id),
    )
    .await
    {
        Ok(result) => result,
        Err(_) => {
            // The dedicated connection is dropped with the future; stop the server side too.
            let id = server_id.lock().ok().and_then(|mut id| id.take());
            if let Some(id) = id {
                let _ = timed(cancel_server_query(&conn, id)).await;
            }
            Err(format!("Maintenance timed out after {seconds} seconds and was cancelled on the server. Tables already processed keep their results."))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn table(name: &str, schema: &str) -> TableInfo {
        TableInfo {
            name: name.into(),
            schema: schema.into(),
            kind: "table".into(),
        }
    }
    #[test]
    fn statements_are_quoted_and_validated_per_driver() {
        let odd = [table("a`b", "shop"), table("c", "shop")];
        assert_eq!(
            maintain_sql(MaintainOp::Optimize, &Driver::Mysql, &odd).unwrap(),
            vec!["OPTIMIZE TABLE `shop`.`a``b`, `shop`.`c`"]
        );
        assert!(maintain_sql(MaintainOp::Vacuum, &Driver::Mysql, &odd).is_err());
        let pg = [table("Order\"s", "public")];
        assert_eq!(
            maintain_sql(MaintainOp::VacuumFull, &Driver::Postgres, &pg).unwrap(),
            vec!["VACUUM FULL \"public\".\"Order\"\"s\""]
        );
        assert_eq!(
            maintain_sql(MaintainOp::Reindex, &Driver::Postgres, &pg).unwrap(),
            vec!["REINDEX TABLE \"public\".\"Order\"\"s\""]
        );
        assert!(maintain_sql(MaintainOp::Repair, &Driver::Postgres, &pg).is_err());
        assert!(maintain_sql(MaintainOp::Check, &Driver::Sqlite, &pg).is_err());
        let lite = [table("t", "")];
        assert_eq!(
            maintain_sql(MaintainOp::IntegrityCheck, &Driver::Sqlite, &lite).unwrap(),
            vec!["PRAGMA integrity_check(\"t\")"]
        );
        assert_eq!(
            maintain_sql(MaintainOp::Vacuum, &Driver::Sqlite, &[]).unwrap(),
            vec!["VACUUM"]
        );
        assert!(maintain_sql(MaintainOp::Analyze, &Driver::Sqlite, &[]).is_err());
        let view = TableInfo {
            kind: "view".into(),
            ..table("v", "")
        };
        assert!(maintain_sql(MaintainOp::Analyze, &Driver::Postgres, &[view]).is_err());
        assert!(repairable_engine("MyISAM") && repairable_engine("Aria"));
        assert!(!repairable_engine("InnoDB"));
        let op: MaintainOp = serde_json::from_value(json!("vacuum-analyze")).unwrap();
        assert_eq!(op, MaintainOp::VacuumAnalyze);
        assert!(serde_json::from_value::<MaintainOp>(json!("drop")).is_err());
    }
    #[tokio::test]
    async fn sqlite_maintenance_reports_each_table() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let conn = Connection {
            tunnel: None,
            pool: Pool::Lite(pool.clone()),
            config: crate::tests::config(Driver::Sqlite),
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        };
        raw_pool_query(&conn.pool, "CREATE TABLE \"odd \"\"t\" (id INTEGER PRIMARY KEY, n TEXT); CREATE INDEX odd_n ON \"odd \"\"t\"(n); CREATE TABLE b (x)")
            .await
            .unwrap();
        let tables = [table("odd \"t", ""), table("b", "")];
        let id = std::sync::Mutex::new(None);
        for op in [
            MaintainOp::Analyze,
            MaintainOp::IntegrityCheck,
            MaintainOp::QuickCheck,
            MaintainOp::Reindex,
        ] {
            let out = maintain(&conn, op, &tables, &id).await.unwrap();
            assert_eq!(out.rows.len(), 2, "{op:?}");
            assert!(out
                .rows
                .iter()
                .all(|r| r.msg_type == "status" && r.msg_text == "OK"));
            assert_eq!(out.rows[0].table, "odd \"t");
        }
        let vacuum = maintain(&conn, MaintainOp::Vacuum, &[], &id).await.unwrap();
        assert_eq!(vacuum.statements, vec!["VACUUM"]);
        assert_eq!(vacuum.rows.len(), 1);
        let missing = maintain(&conn, MaintainOp::Reindex, &[table("missing", "")], &id)
            .await
            .unwrap();
        assert_eq!(missing.rows[0].msg_type, "error");
        assert!(maintain(&conn, MaintainOp::Optimize, &tables, &id)
            .await
            .is_err());
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_PG_URL; creates only session-local temporary tables"]
    async fn postgres_vacuum_runs_outside_a_transaction_block() {
        let conn = crate::tests::server_connection("DBDE_TEST_PG_URL", Driver::Postgres).await;
        let (session, _) = open_session(&conn).await.unwrap();
        let SessionConn::Pg(mut c) = session else {
            unreachable!()
        };
        sqlx::raw_sql("CREATE TEMPORARY TABLE dbde_maint (id int primary key, n int); INSERT INTO dbde_maint SELECT g, g FROM generate_series(1, 50) g")
            .execute(&mut c)
            .await
            .unwrap();
        let schema: String = sqlx::query_scalar(
            "SELECT nspname::text FROM pg_namespace WHERE oid = pg_my_temp_schema()",
        )
        .fetch_one(&mut c)
        .await
        .unwrap();
        let mut target = Target::Pg(c);
        let tables = [table("dbde_maint", &schema)];
        for op in [
            MaintainOp::Analyze,
            MaintainOp::Vacuum,
            MaintainOp::VacuumAnalyze,
            MaintainOp::VacuumFull,
            MaintainOp::Reindex,
        ] {
            let out = maintain_on(&mut target, &Driver::Postgres, op, &tables, "postgres")
                .await
                .unwrap();
            assert_eq!(
                out.rows[0].msg_type, "status",
                "{op:?}: {}",
                out.rows[0].msg_text
            );
        }
        let missing = maintain_on(
            &mut target,
            &Driver::Postgres,
            MaintainOp::Vacuum,
            &[table("dbde_nope", &schema)],
            "postgres",
        )
        .await
        .unwrap();
        assert_eq!(missing.rows[0].msg_type, "error");
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_MYSQL_URL; creates only session-local temporary tables"]
    async fn mysql_maintenance_returns_server_messages() {
        let conn = crate::tests::server_connection("DBDE_TEST_MYSQL_URL", Driver::Mysql).await;
        let (session, _) = open_session(&conn).await.unwrap();
        let SessionConn::My(mut c) = session else {
            unreachable!()
        };
        sqlx::raw_sql("CREATE TEMPORARY TABLE dbde_maint (id int primary key) ENGINE=InnoDB; INSERT INTO dbde_maint VALUES (1), (2)")
            .execute(&mut c)
            .await
            .unwrap();
        let tables = [table("dbde_maint", "")];
        let mut target = Target::My(c);
        for (op, verb) in [
            (MaintainOp::Analyze, "analyze"),
            (MaintainOp::Check, "check"),
            (MaintainOp::Optimize, "optimize"),
        ] {
            let out = maintain_on(&mut target, &Driver::Mysql, op, &tables, "test")
                .await
                .unwrap();
            assert!(!out.rows.is_empty());
            assert!(out
                .rows
                .iter()
                .all(|r| r.op == verb && r.table.ends_with("dbde_maint")));
            assert_eq!(out.rows.last().unwrap().msg_text, "OK");
        }
        let count = fetch(&mut target, "SELECT COUNT(*) FROM dbde_maint")
            .await
            .unwrap();
        assert_eq!(count, vec![vec![json!(2)]]);
    }
}
