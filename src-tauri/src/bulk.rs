use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::ipc::Channel;

pub(crate) struct TempWorkspace(pub PathBuf);
impl TempWorkspace {
    pub fn new() -> DbResult<Self> {
        let path = std::env::temp_dir().join(format!("dbde-operation-{}", uuid::Uuid::new_v4()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&path)
                .map_err(err)?;
        }
        #[cfg(not(unix))]
        std::fs::create_dir(&path).map_err(err)?;
        Ok(Self(path))
    }
}
impl Drop for TempWorkspace {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub(crate) async fn check_source(conn: &Connection, table: &TableInfo) -> DbResult<()> {
    if table.kind != "table" {
        return Err("Choose a base table for a consistent snapshot.".into());
    }
    if matches!(conn.config.driver, Driver::Mysql) {
        let result = metadata_query(&conn.pool, "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?", &[table.schema.clone(), table.name.clone()]).await?;
        let engine = result
            .rows
            .first()
            .and_then(|r| r.first())
            .and_then(Value::as_str)
            .unwrap_or("");
        if !engine.eq_ignore_ascii_case("InnoDB") {
            return Err("Consistent reads require an InnoDB source table.".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn dbde_read_table_snapshot(
    connection_id: String,
    database: String,
    table: TableInfo,
    limit: usize,
    state: State<'_, AppState>,
) -> DbResult<QueryResult> {
    if limit == 0 || limit > 100_000 {
        return Err(
            "Read at most 100,000 records in memory; use streaming export for larger tables."
                .into(),
        );
    }
    let conn = database_connection(&state, &connection_id, Some(&database)).await?;
    check_source(&conn, &table).await?;
    let columns = table_actions::writable_columns(&conn, &table).await?;
    let temp = TempWorkspace::new()?;
    let path = temp.0.join("snapshot.json");
    let cancel = AtomicBool::new(false);
    let bounded = |rows| {
        if rows > limit as u64
            || std::fs::read_dir(&temp.0).is_ok_and(|files| {
                files
                    .filter_map(Result::ok)
                    .filter_map(|f| f.metadata().ok())
                    .map(|m| m.len())
                    .sum::<u64>()
                    > 64 * 1024 * 1024
            })
        {
            cancel.store(true, Ordering::Relaxed);
        }
    };
    let result = export::snapshot_file(&conn, &table, &columns, &path, &cancel, &bounded).await;
    if cancel.load(Ordering::Relaxed) {
        return Err(format!("This operation supports up to {limit} records and 64 MB in memory; use streaming export."));
    }
    result?;
    if std::fs::metadata(&path).map_err(err)?.len() > 64 * 1024 * 1024 {
        return Err("Use streaming export for snapshots larger than 64 MB.".into());
    }
    let file = std::fs::File::open(&path).map_err(err)?;
    let objects: Vec<serde_json::Map<String, Value>> =
        serde_json::from_reader(std::io::BufReader::new(file)).map_err(err)?;
    if objects.len() > limit {
        return Err(format!("This operation supports up to {limit} records."));
    }
    let rows = objects
        .into_iter()
        .map(|mut row| {
            columns
                .iter()
                .map(|c| row.remove(c).unwrap_or(Value::Null))
                .collect()
        })
        .collect();
    Ok(QueryResult {
        columns,
        rows,
        affected_rows: 0,
        execution_ms: 0.0,
        truncated: false,
        source: None,
        pagination: None,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn dbde_transfer_records(
    connection_id: String,
    database: String,
    table: TableInfo,
    target_connection_id: String,
    target_database: String,
    target: TableInfo,
    mapping: Vec<serde_json::Value>,
    operation_id: String,
    on_progress: Channel<cross_copy::CopyProgress>,
    state: State<'_, AppState>,
    operations: State<'_, operations::Operations>,
) -> DbResult<u64> {
    let running = operations.start(operation_id)?;
    let (source, destination, columns) = operations::controlled(&running.flag, 30, async {
        let source = database_connection(&state, &connection_id, Some(&database)).await?;
        let destination =
            database_connection(&state, &target_connection_id, Some(&target_database)).await?;
        let same_storage = if matches!(source.config.driver, Driver::Sqlite) {
            connection_id == target_connection_id
                || (source.config.file_path != ":memory:"
                    && std::fs::canonicalize(&source.config.file_path)
                        .ok()
                        .zip(std::fs::canonicalize(&destination.config.file_path).ok())
                        .is_some_and(|(a, b)| a == b))
        } else {
            source.config.driver == destination.config.driver
                && source.config.host == destination.config.host
                && source.config.port == destination.config.port
                && source.config.options.socket_path == destination.config.options.socket_path
                && source
                    .config
                    .options
                    .ssh
                    .same_endpoint(&destination.config.options.ssh)
        };
        if table.name == target.name
            && table.schema == target.schema
            && same_storage
            && database == target_database
        {
            return Err("Source and destination must be different tables.".into());
        }
        check_source(&source, &table).await?;
        let columns = mapping
            .iter()
            .map(|m| {
                m["source"]
                    .as_str()
                    .map(str::to_string)
                    .ok_or("Invalid column mapping".to_string())
            })
            .collect::<DbResult<Vec<_>>>()?;
        if columns.is_empty() {
            return Err("Choose columns to transfer.".into());
        }
        Ok((source, destination, columns))
    })
    .await?;
    let temp = TempWorkspace::new()?;
    let path = temp.0.join("snapshot.json");
    let exceeded = AtomicBool::new(false);
    let read_progress = |rows| {
        if rows > 5_000_000
            || std::fs::read_dir(&temp.0).is_ok_and(|files| {
                files
                    .filter_map(Result::ok)
                    .filter_map(|f| f.metadata().ok())
                    .map(|m| m.len())
                    .sum::<u64>()
                    > 512 * 1024 * 1024
            })
        {
            exceeded.store(true, Ordering::Relaxed);
            running.flag.store(true, Ordering::Relaxed);
        }
        cross_copy::report(Some(&on_progress), "Reading snapshot", Some(rows));
    };
    let write_progress =
        |rows| cross_copy::report(Some(&on_progress), "Writing destination", Some(rows));
    let seconds = source
        .config
        .options
        .query_timeout_secs
        .unwrap_or(300)
        .max(300);
    operations::controlled(&running.flag, seconds, async {
        let snapshot = export::snapshot_file(&source, &table, &columns, &path, &running.flag, &read_progress).await;
        if exceeded.load(Ordering::Relaxed) { return Err("Transfer snapshot exceeds 5,000,000 rows or 512 MB; no destination records were written.".into()); }
        snapshot?;
        import::transfer_file(&destination, &target, &path, json!(mapping), &running.flag, &write_progress).await
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn setup() -> Connection {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        Connection {
            tunnel: None,
            pool: Pool::Lite(pool),
            config: super::super::tests::config(Driver::Sqlite),
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    fn table(name: &str) -> TableInfo {
        TableInfo {
            name: name.into(),
            schema: "".into(),
            kind: "table".into(),
        }
    }
    #[tokio::test]
    async fn snapshot_and_transfer_stream_more_than_five_thousand_and_roll_back_conflicts() {
        let conn = setup().await;
        if let Pool::Lite(pool) = &conn.pool {
            sqlx::raw_sql("CREATE TABLE source (id INTEGER PRIMARY KEY, name TEXT, computed TEXT GENERATED ALWAYS AS (upper(name)) STORED); CREATE TABLE target (id INTEGER PRIMARY KEY, name TEXT); WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<6005) INSERT INTO source(id,name) SELECT n,'row '||n FROM seq;").execute(pool).await.unwrap();
        }
        let temp = TempWorkspace::new().unwrap();
        let path = temp.0.join("snapshot.json");
        let flag = AtomicBool::new(false);
        let columns = table_actions::writable_columns(&conn, &table("source"))
            .await
            .unwrap();
        assert_eq!(columns, vec!["id", "name"]);
        let rows = export::snapshot_file(&conn, &table("source"), &columns, &path, &flag, &|_| {})
            .await
            .unwrap();
        assert_eq!(rows, 6005);
        let mapping = json!([{"source":"id","target":"id"},{"source":"name","target":"name"}]);
        assert_eq!(
            import::transfer_file(
                &conn,
                &table("target"),
                &path,
                mapping.clone(),
                &flag,
                &|_| {}
            )
            .await
            .unwrap(),
            6005
        );
        if let Pool::Lite(pool) = &conn.pool {
            sqlx::raw_sql("DELETE FROM target; INSERT INTO target VALUES (6005,'existing');")
                .execute(pool)
                .await
                .unwrap();
        }
        assert!(import::transfer_file(
            &conn,
            &table("target"),
            &path,
            mapping.clone(),
            &flag,
            &|_| {}
        )
        .await
        .is_err());
        let result = query(&conn.pool, "SELECT COUNT(*) FROM target")
            .await
            .unwrap();
        assert_eq!(result.rows[0][0], json!(1));
        query(&conn.pool, "DELETE FROM target").await.unwrap();
        let cancel_after_chunk = |rows| {
            if rows >= 1000 {
                flag.store(true, Ordering::Relaxed);
            }
        };
        assert!(import::transfer_file(
            &conn,
            &table("target"),
            &path,
            mapping,
            &flag,
            &cancel_after_chunk
        )
        .await
        .is_err());
        assert_eq!(
            query(&conn.pool, "SELECT COUNT(*) FROM target")
                .await
                .unwrap()
                .rows[0][0],
            json!(0)
        );
        let folder = temp.0.clone();
        drop(temp);
        assert!(!folder.exists());
    }
    #[tokio::test]
    async fn cancelling_snapshot_leaves_no_completed_file() {
        let conn = setup().await;
        if let Pool::Lite(pool) = &conn.pool {
            sqlx::raw_sql("CREATE TABLE t(id INTEGER); INSERT INTO t VALUES (1);")
                .execute(pool)
                .await
                .unwrap();
        }
        let temp = TempWorkspace::new().unwrap();
        let path = temp.0.join("snapshot.json");
        let flag = AtomicBool::new(true);
        assert!(
            export::snapshot_file(&conn, &table("t"), &["id".into()], &path, &flag, &|_| {})
                .await
                .is_err()
        );
        assert!(!path.exists());
    }
}

#[cfg(test)]
mod consistency_tests {
    use super::*;
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn snapshot_keeps_original_rows_when_another_connection_replaces_rows_mid_read() {
        let temp = TempWorkspace::new().unwrap();
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(temp.0.join("source.db"))
            .create_if_missing(true)
            .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TABLE source(id INTEGER PRIMARY KEY); WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<6005) INSERT INTO source SELECT n FROM seq;").execute(&pool).await.unwrap();
        let conn = Connection {
            tunnel: None,
            pool: Pool::Lite(pool.clone()),
            config: super::super::tests::config(Driver::Sqlite),
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        };
        let (start, ready) = tokio::sync::oneshot::channel();
        let (resume, wait) = std::sync::mpsc::channel();
        let writer = tokio::spawn(async move {
            ready.await.unwrap();
            sqlx::raw_sql("BEGIN; DELETE FROM source WHERE id=5000; INSERT INTO source VALUES(99999); COMMIT;").execute(&pool).await.unwrap();
            resume.send(()).unwrap();
        });
        let start = std::sync::Mutex::new(Some(start));
        let wait = std::sync::Mutex::new(wait);
        let progress = |rows| {
            if rows >= 1000 {
                if let Some(start) = start.lock().unwrap().take() {
                    start.send(()).unwrap();
                    wait.lock()
                        .unwrap()
                        .recv_timeout(Duration::from_secs(5))
                        .unwrap();
                }
            }
        };
        let path = temp.0.join("snapshot.json");
        export::snapshot_file(
            &conn,
            &TableInfo {
                name: "source".into(),
                schema: "".into(),
                kind: "table".into(),
            },
            &["id".into()],
            &path,
            &AtomicBool::new(false),
            &progress,
        )
        .await
        .unwrap();
        writer.await.unwrap();
        let rows: Vec<Value> = serde_json::from_reader(std::fs::File::open(path).unwrap()).unwrap();
        assert_eq!(rows.len(), 6005);
        assert!(rows.iter().any(|r| r["id"] == 5000));
        assert!(!rows.iter().any(|r| r["id"] == 99999));
    }
}
