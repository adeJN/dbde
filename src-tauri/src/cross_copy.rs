use super::*;
use rows::{qualified, quote};
#[derive(Clone, Serialize)]
pub(crate) struct CopyProgress {
    pub(crate) stage: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) rows: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) tables_copied: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) table_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) phase: Option<String>,
}
pub(crate) fn report(
    channel: Option<&tauri::ipc::Channel<CopyProgress>>,
    stage: &str,
    rows: Option<u64>,
) {
    if let Some(channel) = channel {
        let _ = channel.send(CopyProgress {
            stage: stage.into(),
            rows,
            tables_copied: None,
            table_index: None,
            phase: None,
        });
    }
}

fn insert_batch(
    target: &str,
    columns: &[String],
    rows: &[Vec<Value>],
) -> DbResult<sqlx::QueryBuilder<'static, sqlx::MySql>> {
    let mut sql = sqlx::QueryBuilder::new(format!(
        "INSERT INTO {target} ({}) VALUES ",
        columns
            .iter()
            .map(|c| quote(c, &Driver::Mysql))
            .collect::<Vec<_>>()
            .join(", ")
    ));
    for (index, row) in rows.iter().enumerate() {
        if row.len() != columns.len() {
            return Err("The source row does not match its columns".into());
        }
        if index > 0 {
            sql.push(", ");
        }
        sql.push("(");
        for (column, value) in row.iter().enumerate() {
            if column > 0 {
                sql.push(", ");
            }
            match value {
                Value::Null => {
                    sql.push_bind(Option::<String>::None);
                }
                Value::Bool(value) => {
                    sql.push_bind(*value);
                }
                Value::Number(value) => {
                    if let Some(value) = value.as_i64() {
                        sql.push_bind(value);
                    } else if let Some(value) = value.as_u64() {
                        sql.push_bind(value);
                    } else {
                        sql.push_bind(value.as_f64().ok_or("Invalid numeric value")?);
                    }
                }
                Value::String(value) => {
                    sql.push_bind(value.clone());
                }
                Value::Object(value) => {
                    let hex = value
                        .get("hex")
                        .and_then(Value::as_str)
                        .ok_or("Unsupported source value")?;
                    if hex.len() % 2 != 0 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                        return Err("Invalid binary source value".into());
                    }
                    let bytes = hex
                        .as_bytes()
                        .chunks(2)
                        .map(|pair| {
                            u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap()
                        })
                        .collect::<Vec<_>>();
                    sql.push_bind(bytes);
                }
                _ => return Err("Unsupported source value".into()),
            }
        }
        sql.push(")");
    }
    Ok(sql)
}

/// Cross-server MySQL-compatible copy. A private staging table prevents a failed
/// transfer from exposing an incomplete destination or overwriting existing data.
#[cfg(test)]
pub(crate) async fn copy_mysql_table(
    source: &Connection,
    table: &TableInfo,
    destination: &Connection,
    target: &TableInfo,
    data: bool,
    progress: Option<&tauri::ipc::Channel<CopyProgress>>,
) -> DbResult<()> {
    copy_mysql_table_controlled(
        source,
        table,
        destination,
        target,
        data,
        progress,
        &std::sync::atomic::AtomicBool::new(false),
    )
    .await
}
#[allow(clippy::too_many_arguments)]
pub(crate) async fn copy_mysql_table_controlled(
    source: &Connection,
    table: &TableInfo,
    destination: &Connection,
    target: &TableInfo,
    data: bool,
    progress: Option<&tauri::ipc::Channel<CopyProgress>>,
    cancel: &std::sync::atomic::AtomicBool,
) -> DbResult<()> {
    copy_mysql_table_prepared(
        source,
        table,
        destination,
        target,
        data,
        progress,
        cancel,
        None,
    )
    .await
    .map(|_| ())
}
#[allow(clippy::too_many_arguments)]
pub(crate) async fn copy_mysql_table_prepared(
    source: &Connection,
    table: &TableInfo,
    destination: &Connection,
    target: &TableInfo,
    data: bool,
    progress: Option<&tauri::ipc::Channel<CopyProgress>>,
    cancel: &std::sync::atomic::AtomicBool,
    prepared_ddl: Option<&str>,
) -> DbResult<u64> {
    report(progress, "Checking source and destination", None);
    let (Pool::My(source_pool), Pool::My(target_pool)) = (&source.pool, &destination.pool) else {
        return Err(
            "Cross-server table copy currently supports MySQL, MariaDB and TiDB connections".into(),
        );
    };
    if table.kind != "table"
        || table.schema != source.config.database
        || target.schema != destination.config.database
        || target.name.trim().is_empty()
        || target.name.len() > 64
        || target.name.contains('\0')
    {
        return Err(
            "Choose a source table and a valid destination in the selected database".into(),
        );
    }
    let (columns, select_columns, ddl, mut socket, staging_sql, target_sql) = operations::controlled(cancel, 30, async {
    let existing: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
    )
    .bind(&target.schema)
    .bind(&target.name)
    .fetch_one(target_pool)
    .await
    .map_err(err)?;
    if existing != 0 {
        return Err("The destination table already exists; choose a new name".into());
    }
    let foreign_keys: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'")
        .bind(&table.schema).bind(&table.name).fetch_one(source_pool).await.map_err(err)?;
    if foreign_keys != 0 && prepared_ddl.is_none() {
        return Err("This source has foreign keys. Review and migrate its related tables and constraints separately before copying across servers".into());
    }
    let engine = metadata_query(
        &source.pool,
        "SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?",
        &[table.schema.clone(), table.name.clone()],
    )
    .await?;
    if engine
        .rows
        .first()
        .and_then(|r| r.first())
        .and_then(Value::as_str)
        != Some("InnoDB")
    {
        return Err("Cross-server copy supports InnoDB-compatible tables only".into());
    }
    let ddl = match prepared_ddl {
        Some(ddl) => ddl.to_owned(),
        None => schema::table_ddl(source, table, true).await?,
    };
    if ddl.contains("AUTO_RANDOM") {
        return Err(
            "TiDB AUTO_RANDOM requires a reviewed conversion before copying to MySQL/MariaDB"
                .into(),
        );
    }
    let columns = table_actions::writable_columns(source, table).await?;
    if columns.is_empty() {
        return Err("No writable source columns found".into());
    }
    let metadata = column_meta::table_columns(&source.pool, table).await?;
    let select_columns = columns
        .iter()
        .map(|name| {
            let quoted = quote(name, &Driver::Mysql);
            let kind = metadata
                .iter()
                .find(|c| &c.name == name)
                .map(|c| c.data_type.to_ascii_uppercase())
                .unwrap_or_default();
            if [
                "DATE",
                "DATETIME",
                "TIMESTAMP",
                "TIME",
                "DECIMAL",
                "NUMERIC",
                "JSON",
            ]
            .iter()
            .any(|t| kind == *t || kind.starts_with(&format!("{t}(")))
            {
                format!("CAST({quoted} AS CHAR) AS {quoted}")
            } else {
                quoted
            }
        })
        .collect::<Vec<_>>()
        .join(", ");
    let staging = TableInfo {
        name: format!("_dbde_copy_{}", uuid::Uuid::new_v4().simple()),
        schema: target.schema.clone(),
        kind: "table".into(),
    };
    let staging_sql = qualified(&staging, &Driver::Mysql);
    let target_sql = qualified(target, &Driver::Mysql);
    // Keep one destination socket so SQL mode and ownership remain stable. Closing
    // it on drop also prevents session changes leaking into the shared pool.
    let mut socket = target_pool.acquire().await.map_err(err)?;
    socket.close_on_drop();
    sqlx::query("SET NAMES utf8mb4")
        .execute(&mut *socket)
        .await
        .map_err(err)?;
    sqlx::query("SET SESSION sql_mode = CONCAT_WS(',', @@sql_mode, 'NO_AUTO_VALUE_ON_ZERO', 'STRICT_ALL_TABLES')").execute(&mut *socket).await.map_err(err)?;
    sqlx::query("SET SESSION time_zone = '+00:00'")
        .execute(&mut *socket)
        .await
        .map_err(err)?;
        Ok((columns, select_columns, ddl, socket, staging_sql, target_sql))
    }).await?;
    let seconds = source
        .config
        .options
        .query_timeout_secs
        .unwrap_or(300)
        .max(300);
    let result: DbResult<u64> = operations::controlled(cancel, seconds, async {
        report(progress, "Creating destination structure", None);
        sqlx::query(&format!(
            "CREATE TABLE {staging_sql} {}",
            table_actions::definition_body(&ddl)?.trim_end_matches(';')
        ))
        .execute(&mut *socket)
        .await
        .map_err(|e| {
            format!("Cannot create the destination structure: {e}. No existing table was replaced")
        })?;
        let mut copied = 0u64;
        if data {
            report(progress, "Copying records", Some(0));
            let mut reader = source_pool.acquire().await.map_err(err)?;
            reader.close_on_drop();
            sqlx::query("SET NAMES utf8mb4")
                .execute(&mut *reader)
                .await
                .map_err(err)?;
            sqlx::query("SET SESSION time_zone = '+00:00'")
                .execute(&mut *reader)
                .await
                .map_err(err)?;
            sqlx::query("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ")
                .execute(&mut *reader)
                .await
                .map_err(err)?;
            let mut source_tx = reader.begin().await.map_err(err)?;
            let mut tx = socket.begin().await.map_err(err)?;
            let select = format!(
                "SELECT {} FROM {}",
                select_columns,
                qualified(table, &Driver::Mysql)
            );
            let mut stream = sqlx::query(&select).fetch(&mut *source_tx);
            let mut batch = Vec::new();
            let mut bytes = 0;
            while let Some(row) = stream.try_next().await.map_err(err)? {
                if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                    return Err("Copy cancelled before publishing the destination.".into());
                }
                let values = (0..columns.len())
                    .map(|i| {
                        if row.try_get_raw(i).map_err(err)?.is_null() {
                            return Ok(Value::Null);
                        }
                        if matches!(
                            row.columns()[i].type_info().name(),
                            "BINARY"
                                | "VARBINARY"
                                | "BLOB"
                                | "TINYBLOB"
                                | "MEDIUMBLOB"
                                | "LONGBLOB"
                        ) {
                            unknown_bytes(row.try_get_unchecked::<Vec<u8>, _>(i).map_err(err)?)
                        } else {
                            my_cell(&row, i)
                        }
                    })
                    .collect::<DbResult<Vec<_>>>()?;
                bytes += values.iter().map(|v| v.to_string().len()).sum::<usize>();
                batch.push(values);
                if batch.len() >= (60_000 / columns.len()).clamp(1, 100) || bytes >= 1_000_000 {
                    insert_batch(&staging_sql, &columns, &batch)?
                        .build()
                        .execute(&mut *tx)
                        .await
                        .map_err(err)?;
                    copied += batch.len() as u64;
                    report(progress, "Copying records", Some(copied));
                    batch.clear();
                    bytes = 0;
                }
            }
            drop(stream);
            source_tx.rollback().await.map_err(err)?;
            if !batch.is_empty() {
                insert_batch(&staging_sql, &columns, &batch)?
                    .build()
                    .execute(&mut *tx)
                    .await
                    .map_err(err)?;
                copied += batch.len() as u64;
                report(progress, "Copying records", Some(copied));
            }
            if cancel.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("Copy cancelled before publishing the destination.".into());
            }
            tx.commit().await.map_err(err)?;
        }
        let actual: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {staging_sql}"))
            .fetch_one(&mut *socket)
            .await
            .map_err(err)?;
        if actual < 0 || actual as u64 != copied {
            return Err("Destination row count does not match the streamed source snapshot".into());
        }
        // RENAME fails if another client created the final name during the copy.
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("Copy cancelled before publishing the destination.".into());
        }
        report(progress, "Publishing completed table", Some(copied));
        sqlx::query(&format!("RENAME TABLE {staging_sql} TO {target_sql}"))
            .execute(&mut *socket)
            .await
            .map_err(err)?;
        Ok(copied)
    })
    .await;
    if let Err(cause) = &result {
        report(progress, "Cleaning up interrupted copy", None);
        let cleanup = tokio::time::timeout(Duration::from_secs(10), async {
            sqlx::query(&format!("DROP TABLE IF EXISTS {staging_sql}"))
                .execute(&mut *socket)
                .await
                .map_err(err)
        })
        .await;
        let cleaned = matches!(cleanup, Ok(Ok(_)));
        return Err(format!("Copy failed: {cause}. {} Refresh the destination before retrying; commands were not replayed.", if cleaned { "The private staging table was removed; existing tables were not changed." } else { "Inspect the destination and its _dbde_copy_ staging tables; the final rename may already have completed." }));
    }
    report(progress, "Table copied", None);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn copy_progress_omits_unknown_row_counts() {
        let value = serde_json::to_value(CopyProgress {
            stage: "Preparing".into(),
            rows: None,
            tables_copied: None,
            table_index: None,
            phase: None,
        })
        .unwrap();
        assert!(value.get("rows").is_none());
        assert_eq!(
            serde_json::to_value(CopyProgress {
                stage: "Copying".into(),
                rows: Some(200),
                tables_copied: None,
                table_index: None,
                phase: None,
            })
            .unwrap()["rows"],
            json!(200)
        );
    }
    #[test]
    fn batch_values_are_bound_and_binary_is_validated() {
        let columns = vec!["note".into(), "payload".into()];
        let sql = insert_batch(
            "`db`.`t`",
            &columns,
            &[vec![json!("'); DROP TABLE t; --"), json!({"hex":"00ff"})]],
        )
        .unwrap();
        assert_eq!(
            sql.sql(),
            "INSERT INTO `db`.`t` (`note`, `payload`) VALUES (?, ?)"
        );
        assert!(insert_batch("t", &columns, &[vec![Value::Null]]).is_err());
        assert!(insert_batch("t", &["x".into()], &[vec![json!({"hex":"0xyz"})]]).is_err());
    }
    #[tokio::test]
    #[ignore = "requires an isolated disposable DBDE_TEST_MYSQL_URL; creates only uniquely named fixture databases"]
    async fn mysql_streaming_copy_preserves_data_and_never_overwrites() {
        let source = crate::tests::server_connection("DBDE_TEST_MYSQL_URL", Driver::Mysql).await;
        let destination =
            crate::tests::server_connection("DBDE_TEST_MYSQL_URL", Driver::Mysql).await;
        let prefix = format!("dbde_copy_{}", uuid::Uuid::new_v4().simple());
        let source_db = format!("{prefix}_a");
        let target_db = format!("{prefix}_b");
        for name in [&source_db, &target_db] {
            query(
                &source.pool,
                &format!(
                    "CREATE DATABASE {} CHARACTER SET utf8mb4",
                    quote(name, &Driver::Mysql)
                ),
            )
            .await
            .unwrap();
        }
        let Pool::My(pool) = &source.pool else {
            unreachable!()
        };
        let source_pool = sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(2)
            .connect_with(pool.connect_options().as_ref().clone().database(&source_db))
            .await
            .unwrap();
        let target_pool = sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(2)
            .connect_with(pool.connect_options().as_ref().clone().database(&target_db))
            .await
            .unwrap();
        let source = Connection {
            config: ConnectionConfig {
                database: source_db.clone(),
                ..source.config
            },
            pool: Pool::My(source_pool.clone()),
            ..source
        };
        let destination = Connection {
            config: ConnectionConfig {
                database: target_db.clone(),
                ..destination.config
            },
            pool: Pool::My(target_pool.clone()),
            ..destination
        };
        query(&source.pool, "CREATE TABLE records (id BIGINT UNSIGNED PRIMARY KEY AUTO_INCREMENT, note VARCHAR(100), amount DECIMAL(40,8), payload BLOB, created_at TIMESTAMP(6) NULL, computed INT AS (LENGTH(note)) STORED, INDEX note_idx(note)) ENGINE=InnoDB").await.unwrap();
        let mut writer = source_pool.acquire().await.unwrap();
        sqlx::query("SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO'")
            .execute(&mut *writer)
            .await
            .unwrap();
        sqlx::query("SET SESSION time_zone = '+00:00'")
            .execute(&mut *writer)
            .await
            .unwrap();
        for id in 0..205u64 {
            sqlx::query(
                "INSERT INTO records(id,note,amount,payload,created_at) VALUES (?,?,?,?,?)",
            )
            .bind(id)
            .bind("café ' \\ test")
            .bind("123456789012345678901234567890.12345678")
            .bind(vec![0u8, 255, 1])
            .bind("2026-10-31 10:15:30.123456")
            .execute(&mut *writer)
            .await
            .unwrap();
        }
        sqlx::query("INSERT INTO records(id,note) VALUES (?,NULL)")
            .bind(u64::MAX)
            .execute(&mut *writer)
            .await
            .unwrap();
        drop(writer);
        let table = TableInfo {
            name: "records".into(),
            schema: source_db.clone(),
            kind: "table".into(),
        };
        let target = TableInfo {
            name: "copied ` records".into(),
            schema: target_db.clone(),
            kind: "table".into(),
        };
        let events = Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
        let received = events.clone();
        let channel = tauri::ipc::Channel::<CopyProgress>::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(text) = body else {
                panic!("Expected JSON progress")
            };
            received
                .lock()
                .unwrap()
                .push(serde_json::from_str(&text).unwrap());
            Ok(())
        });
        copy_mysql_table(&source, &table, &destination, &target, true, Some(&channel))
            .await
            .unwrap();
        assert!(events
            .lock()
            .unwrap()
            .iter()
            .any(|event| event["stage"] == "Copying records" && event["rows"] == 206));
        assert_eq!(
            events.lock().unwrap().last().unwrap()["stage"],
            json!("Table copied")
        );
        let count = query(
            &destination.pool,
            &format!(
                "SELECT COUNT(*) FROM {}",
                qualified(&target, &Driver::Mysql)
            ),
        )
        .await
        .unwrap();
        assert_eq!(count.rows[0][0], json!(206));
        let copied = query(&destination.pool, &format!("SELECT note, CAST(amount AS CHAR), HEX(payload), CAST(created_at AS CHAR), computed FROM {} WHERE id=0", qualified(&target, &Driver::Mysql))).await.unwrap();
        assert_eq!(copied.rows[0][0], json!("café ' \\ test"));
        assert_eq!(
            copied.rows[0][1],
            json!("123456789012345678901234567890.12345678")
        );
        assert_eq!(copied.rows[0][2], json!("00FF01"));
        assert_eq!(copied.rows[0][3], json!("2026-10-31 10:15:30.123456"));
        assert!(!copied.rows[0][4].is_null());
        assert!(
            copy_mysql_table(&source, &table, &destination, &target, true, None)
                .await
                .err()
                .unwrap()
                .contains("already exists")
        );
        let empty = TableInfo {
            name: "structure_only".into(),
            ..target.clone()
        };
        copy_mysql_table(&source, &table, &destination, &empty, false, None)
            .await
            .unwrap();
        assert_eq!(
            query(&destination.pool, "SELECT COUNT(*) FROM structure_only")
                .await
                .unwrap()
                .rows[0][0],
            json!(0)
        );
        let failed = TableInfo {
            name: "must_not_exist".into(),
            ..target
        };
        query(
            &source.pool,
            "CREATE TABLE rejected (id INT, CONSTRAINT valid_id CHECK (id > 0)) ENGINE=InnoDB",
        )
        .await
        .unwrap();
        let mut writer = source_pool.acquire().await.unwrap();
        sqlx::query("SET SESSION check_constraint_checks = OFF")
            .execute(&mut *writer)
            .await
            .unwrap();
        sqlx::query("INSERT INTO rejected VALUES (-1)")
            .execute(&mut *writer)
            .await
            .unwrap();
        drop(writer);
        assert!(copy_mysql_table(
            &source,
            &TableInfo {
                name: "rejected".into(),
                ..table
            },
            &destination,
            &failed,
            true,
            None
        )
        .await
        .is_err());
        let remaining = metadata_query(
            &destination.pool,
            "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
            std::slice::from_ref(&target_db),
        )
        .await
        .unwrap();
        assert_eq!(
            remaining.rows.len(),
            2,
            "Failed copy must remove its private staging table"
        );
        close(source.pool).await;
        close(destination.pool).await;
        for name in [&source_db, &target_db] {
            query(
                &Pool::My(pool.clone()),
                &format!("DROP DATABASE {}", quote(name, &Driver::Mysql)),
            )
            .await
            .unwrap();
        }
        pool.close().await;
    }
}
