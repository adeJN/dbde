//! MySQL-compatible table groups: private copies, validated relationships, then publication.
use super::*;
use rows::{qualified, quote};

#[derive(Clone, Deserialize)]
pub(crate) struct CopyItem {
    table: TableInfo,
    target: TableInfo,
}
struct ForeignKey {
    name: String,
    columns: Vec<String>,
    parent: TableInfo,
    parent_columns: Vec<String>,
    on_update: String,
    on_delete: String,
}
struct Plan {
    item: CopyItem,
    staging: TableInfo,
    ddl: String,
    keys: Vec<ForeignKey>,
}

/// Split only top-level SHOW CREATE definitions; quoted values and nested expressions
/// may contain commas, parentheses and the words FOREIGN KEY.
fn without_foreign_keys(ddl: &str) -> DbResult<(String, usize)> {
    let body = table_actions::definition_body(ddl)?;
    let bytes = body.as_bytes();
    let (mut depth, mut start, mut i) = (0usize, 1usize, 0usize);
    let mut quote_char = None;
    let mut comment = false;
    let mut entries = Vec::new();
    while i < bytes.len() {
        let ch = bytes[i];
        if comment {
            if ch == b'*' && bytes.get(i + 1) == Some(&b'/') {
                comment = false;
                i += 1;
            }
        } else if let Some(q) = quote_char {
            if ch == b'\\' {
                i += 1;
            } else if ch == q {
                if bytes.get(i + 1) == Some(&q) {
                    i += 1;
                } else {
                    quote_char = None;
                }
            }
        } else if ch == b'/' && bytes.get(i + 1) == Some(&b'*') {
            comment = true;
            i += 1;
        } else if matches!(ch, b'`' | b'\'' | b'"') {
            quote_char = Some(ch);
        } else if ch == b'(' {
            depth += 1;
        } else if ch == b')' {
            depth = depth
                .checked_sub(1)
                .ok_or("Invalid source table definition")?;
            if depth == 0 {
                entries.push(body[start..i].trim());
                let original_count = entries.len();
                let kept: Vec<&str> = entries
                    .into_iter()
                    .filter(|entry| !is_foreign_key(entry))
                    .collect();
                if kept.is_empty() {
                    return Err("Source table has no column definitions".into());
                }
                return Ok((
                    format!("({}){}", kept.join(",\n"), &body[i + 1..]),
                    original_count - kept.len(),
                ));
            }
        } else if ch == b',' && depth == 1 {
            entries.push(body[start..i].trim());
            start = i + 1;
        }
        i += 1;
    }
    Err("Cannot parse source table definition safely".into())
}
fn is_foreign_key(entry: &str) -> bool {
    let mut rest = entry.trim_start();
    if rest.to_ascii_uppercase().starts_with("CONSTRAINT ") {
        rest = rest[11..].trim_start();
        if rest.starts_with('`') {
            let bytes = rest.as_bytes();
            let mut i = 1;
            while i < bytes.len() {
                if bytes[i] == b'`' {
                    if bytes.get(i + 1) == Some(&b'`') {
                        i += 2;
                        continue;
                    }
                    rest = &rest[i + 1..];
                    break;
                }
                i += 1;
            }
        } else {
            rest = rest
                .split_once(char::is_whitespace)
                .map(|(_, tail)| tail)
                .unwrap_or("");
        }
    }
    let mut words = rest.split_whitespace();
    matches!((words.next(), words.next()), (Some(a), Some(b)) if a.eq_ignore_ascii_case("FOREIGN") && (b.eq_ignore_ascii_case("KEY") || b.to_ascii_uppercase().starts_with("KEY(")))
}
fn action(rule: &str) -> DbResult<&str> {
    match rule {
        "CASCADE" | "SET NULL" | "RESTRICT" | "NO ACTION" => Ok(rule),
        _ => Err("Unsupported foreign key action; review the source schema".into()),
    }
}
async fn foreign_keys(pool: &sqlx::MySqlPool, table: &TableInfo) -> DbResult<Vec<ForeignKey>> {
    let rows = sqlx::query("SELECT CAST(k.CONSTRAINT_NAME AS CHAR), CAST(k.COLUMN_NAME AS CHAR), CAST(k.REFERENCED_TABLE_SCHEMA AS CHAR), CAST(k.REFERENCED_TABLE_NAME AS CHAR), CAST(k.REFERENCED_COLUMN_NAME AS CHAR), CAST(r.UPDATE_RULE AS CHAR), CAST(r.DELETE_RULE AS CHAR) FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION")
        .bind(&table.schema).bind(&table.name).fetch_all(pool).await.map_err(err)?;
    let mut keys: Vec<ForeignKey> = Vec::new();
    for row in rows {
        let name = mysql_metadata_text(&row, 0)?;
        let column = mysql_metadata_text(&row, 1)?;
        let parent_column = mysql_metadata_text(&row, 4)?;
        if let Some(last) = keys.last_mut().filter(|key| key.name == name) {
            last.columns.push(column);
            last.parent_columns.push(parent_column);
        } else {
            let on_update = mysql_metadata_text(&row, 5)?;
            let on_delete = mysql_metadata_text(&row, 6)?;
            action(&on_update)?;
            action(&on_delete)?;
            keys.push(ForeignKey {
                name,
                columns: vec![column],
                parent: TableInfo {
                    schema: mysql_metadata_text(&row, 2)?,
                    name: mysql_metadata_text(&row, 3)?,
                    kind: "table".into(),
                },
                parent_columns: vec![parent_column],
                on_update,
                on_delete,
            });
        }
    }
    Ok(keys)
}
fn parent_index(items: &[CopyItem], parent: &TableInfo) -> DbResult<usize> {
    items.iter().position(|item| item.table.schema == parent.schema && item.table.name == parent.name)
        .ok_or_else(|| format!("Copy dependency missing: include table {}.{} in the selection to preserve its foreign keys", parent.schema, parent.name))
}
fn emit(
    channel: Option<&tauri::ipc::Channel<cross_copy::CopyProgress>>,
    stage: String,
    completed: usize,
    index: Option<usize>,
    phase: &str,
) {
    if let Some(channel) = channel {
        let _ = channel.send(cross_copy::CopyProgress {
            stage,
            rows: None,
            tables_copied: Some(completed),
            table_index: index,
            phase: Some(phase.into()),
        });
    }
}

#[allow(clippy::too_many_arguments)]
async fn copy_group(
    source: &Connection,
    destination: &Connection,
    items: &[CopyItem],
    data: bool,
    progress: Option<&tauri::ipc::Channel<cross_copy::CopyProgress>>,
    cancel: &std::sync::atomic::AtomicBool,
) -> DbResult<()> {
    let (Pool::My(source_pool), Pool::My(target_pool)) = (&source.pool, &destination.pool) else {
        return Err("Related-table copy requires MySQL/MariaDB/TiDB connections".into());
    };
    if items.is_empty() || items.len() > 100 {
        return Err("Choose 1–100 tables per copy operation".into());
    }
    let mut sources = std::collections::HashSet::new();
    let mut targets = std::collections::HashSet::new();
    for item in items {
        if item.table.schema != source.config.database
            || item.target.schema != destination.config.database
            || item.table.kind != "table"
            || item.target.kind != "table"
            || item.target.name.is_empty()
            || item.target.name.len() > 64
            || item.target.name.contains('\0')
            || !sources.insert((item.table.schema.clone(), item.table.name.clone()))
            || !targets.insert(item.target.name.to_lowercase())
        {
            return Err(
                "Choose unique source and destination tables in the selected databases".into(),
            );
        }
    }
    emit(
        progress,
        "Checking all destination names and foreign key dependencies".into(),
        0,
        None,
        "preflight",
    );
    let mut plans = Vec::new();
    operations::controlled(cancel, 120, async {
        for item in items {
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?")
                .bind(&item.target.schema).bind(&item.target.name).fetch_one(target_pool).await.map_err(err)?;
            if count != 0 { return Err(format!("Destination already exists: {}. No existing table was replaced", item.target.name)); }
            let keys = foreign_keys(source_pool, &item.table).await?;
            for key in &keys { parent_index(items, &key.parent)?; }
            let (ddl, removed_keys) = without_foreign_keys(&schema::table_ddl(source, &item.table, false).await?)?;
            if removed_keys != keys.len() { return Err(format!("Foreign key metadata does not match SHOW CREATE for {}. Copy stopped before creating tables", item.table.name)); }
            plans.push(Plan { item: item.clone(), staging: TableInfo { name: format!("_dbde_group_{}", uuid::Uuid::new_v4().simple()), schema: item.target.schema.clone(), kind: "table".into() }, ddl, keys });
        }
        Ok(())
    }).await?;
    // Track only names created for this operation. Never remove any final/existing table.
    let mut prepared = 0usize;
    let result: DbResult<()> = async {
        for (index, plan) in plans.iter().enumerate() {
            emit(progress, format!("Copying {} → {} ({}/{})", plan.item.table.name, plan.item.target.name, index + 1, plans.len()), prepared, Some(index), "copying");
            let rows = cross_copy::copy_mysql_table_prepared(source, &plan.item.table, destination, &plan.staging, data, None, cancel, Some(&plan.ddl)).await?;
            prepared += 1;
            emit(progress, format!("Prepared {}: {} records verified", plan.item.target.name, rows), prepared, Some(index), "prepared");
        }
        let mut socket = target_pool.acquire().await.map_err(err)?;
        socket.close_on_drop();
        sqlx::query("SET SESSION FOREIGN_KEY_CHECKS = 1").execute(&mut *socket).await.map_err(err)?;
        // Both parents and children now exist, including cycles and self references.
        operations::controlled(cancel, 300, async {
            for (index, plan) in plans.iter().enumerate() {
                for key in &plan.keys {
                    let parent = &plans[parent_index(items, &key.parent)?].staging;
                    emit(progress, format!("Validating foreign key {}.{}", plan.item.target.name, key.name), prepared, Some(index), "relations");
                    let columns = |names: &[String]| names.iter().map(|name| quote(name, &Driver::Mysql)).collect::<Vec<_>>().join(", ");
                    let name = format!("dbde_fk_{}", uuid::Uuid::new_v4().simple());
                    let sql = format!("ALTER TABLE {} ADD CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {} ({}) ON UPDATE {} ON DELETE {}", qualified(&plan.staging, &Driver::Mysql), quote(&name, &Driver::Mysql), columns(&key.columns), qualified(parent, &Driver::Mysql), columns(&key.parent_columns), action(&key.on_update)?, action(&key.on_delete)?);
                    sqlx::query(&sql).execute(&mut *socket).await.map_err(|_| format!("Foreign key validation failed: {}.{}. Check parent keys, column types and orphan records; no completed group was published", plan.item.target.name, key.name))?;
                }
            }
            emit(progress, "Publishing validated table group".into(), prepared, None, "publishing");
            let names = plans.iter().map(|plan| format!("{} TO {}", qualified(&plan.staging, &Driver::Mysql), qualified(&plan.item.target, &Driver::Mysql))).collect::<Vec<_>>().join(", ");
            sqlx::query(&format!("RENAME TABLE {names}")).execute(&mut *socket).await.map_err(err)?;
            Ok(())
        }).await
    }.await;
    if let Err(cause) = result {
        emit(
            progress,
            "Cleaning private staging tables; existing destinations are kept".into(),
            prepared,
            None,
            "cleanup",
        );
        let cleaned = tokio::time::timeout(Duration::from_secs(30), async {
            let mut socket = target_pool.acquire().await.map_err(err)?;
            socket.close_on_drop();
            // These uniquely named private tables may form a cycle. The override
            // is limited to this disposable socket and only our staging names.
            sqlx::query("SET SESSION FOREIGN_KEY_CHECKS = 0")
                .execute(&mut *socket)
                .await
                .map_err(err)?;
            for plan in &plans {
                sqlx::query(&format!(
                    "DROP TABLE IF EXISTS {}",
                    qualified(&plan.staging, &Driver::Mysql)
                ))
                .execute(&mut *socket)
                .await
                .map_err(err)?;
            }
            Ok::<_, String>(())
        })
        .await;
        return Err(format!(
            "{cause}. {} Refresh the destination before retrying; commands were not replayed",
            if matches!(cleaned, Ok(Ok(()))) {
                "Private staging cleanup completed. Existing destination tables were kept. If publication was interrupted, verify final names before retrying."
            } else {
                "Staging cleanup could not be confirmed; inspect _dbde_group_ / _dbde_copy_ tables and final names before retrying."
            }
        ));
    }
    emit(
        progress,
        format!(
            "{} tables copied; row counts and foreign keys validated",
            plans.len()
        ),
        plans.len(),
        None,
        "complete",
    );
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn dbde_copy_tables(
    connection_id: String,
    database: String,
    destination_connection_id: String,
    destination_database: String,
    items: Vec<CopyItem>,
    data: bool,
    operation_id: Option<String>,
    on_progress: tauri::ipc::Channel<cross_copy::CopyProgress>,
    operations: State<'_, operations::Operations>,
    state: State<'_, AppState>,
) -> DbResult<()> {
    let running =
        operations.start(operation_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()))?;
    let source = database_connection(&state, &connection_id, Some(&database)).await?;
    let target = database_connection(
        &state,
        &destination_connection_id,
        Some(&destination_database),
    )
    .await?;
    copy_group(
        &source,
        &target,
        &items,
        data,
        Some(&on_progress),
        &running.flag,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removes_only_foreign_keys_and_keeps_nested_values_indexes_and_options() {
        let ddl = "CREATE TABLE `odd` (`id` int, `text` enum('a,b','FOREIGN KEY','x)') DEFAULT 'comma,', `FOREIGN KEY` int, KEY `idx` (`id`), CONSTRAINT `odd``fk` FOREIGN KEY (`id`) REFERENCES `parent` (`id`) ON DELETE CASCADE, CHECK (`id` IN (1,2))) ENGINE=InnoDB COMMENT='value, ( )';";
        let (result, removed) = without_foreign_keys(ddl).unwrap();
        assert_eq!(removed, 1);
        assert!(!result.contains("REFERENCES"));
        assert!(result.contains("`FOREIGN KEY` int"));
        assert!(result.contains("enum('a,b','FOREIGN KEY','x)')"));
        assert!(result.contains("KEY `idx` (`id`)"));
        assert!(result.contains("CHECK (`id` IN (1,2))"));
        assert!(result.ends_with("ENGINE=InnoDB COMMENT='value, ( )';"));
        assert!(without_foreign_keys("CREATE TABLE x (bad").is_err());
    }
    #[test]
    fn dependency_mapping_uses_full_source_identity_and_target_renames() {
        let items = vec![CopyItem {
            table: TableInfo {
                name: "parent".into(),
                schema: "source".into(),
                kind: "table".into(),
            },
            target: TableInfo {
                name: "renamed".into(),
                schema: "dest".into(),
                kind: "table".into(),
            },
        }];
        assert_eq!(parent_index(&items, &items[0].table).unwrap(), 0);
        assert!(parent_index(&items, &items[0].target)
            .unwrap_err()
            .contains("include table dest.renamed"));
        assert!(action("CASCADE").is_ok());
        assert!(action("SET DEFAULT; DROP TABLE x").is_err());
    }
    #[tokio::test]
    #[ignore = "requires isolated DBDE_TEST_MYSQL_URL; creates uniquely named fixture databases"]
    async fn mysql_group_copy_validates_cycles_remaps_names_and_cleans_failed_groups() {
        let base = crate::tests::server_connection("DBDE_TEST_MYSQL_URL", Driver::Mysql).await;
        let Pool::My(root) = &base.pool else {
            unreachable!()
        };
        let prefix = format!("dbde_group_test_{}", uuid::Uuid::new_v4().simple());
        let source_db = format!("{prefix}_s");
        let dest_db = format!("{prefix}_d");
        for db in [&source_db, &dest_db] {
            sqlx::query(&format!(
                "CREATE DATABASE {} CHARACTER SET utf8mb4",
                quote(db, &Driver::Mysql)
            ))
            .execute(root)
            .await
            .unwrap();
        }
        let source_pool = sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(3)
            .connect_with(root.connect_options().as_ref().clone().database(&source_db))
            .await
            .unwrap();
        let target_pool = sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(3)
            .connect_with(root.connect_options().as_ref().clone().database(&dest_db))
            .await
            .unwrap();
        let source = Connection {
            pool: Pool::My(source_pool.clone()),
            config: ConnectionConfig {
                database: source_db.clone(),
                ..base.config.clone()
            },
            ..base.clone()
        };
        let dest = Connection {
            pool: Pool::My(target_pool.clone()),
            config: ConnectionConfig {
                database: dest_db.clone(),
                ..base.config.clone()
            },
            ..base.clone()
        };
        for sql in [
            "CREATE TABLE parent (tenant INT, id INT, note VARCHAR(50), PRIMARY KEY(tenant,id)) ENGINE=InnoDB",
            "CREATE TABLE child (id INT PRIMARY KEY, tenant INT, parent_id INT, self_id INT NULL, CONSTRAINT child_parent FOREIGN KEY(tenant,parent_id) REFERENCES parent(tenant,id) ON DELETE CASCADE ON UPDATE CASCADE, CONSTRAINT child_self FOREIGN KEY(self_id) REFERENCES child(id)) ENGINE=InnoDB",
            "CREATE TABLE cycle_a (id INT PRIMARY KEY, b_id INT NULL) ENGINE=InnoDB",
            "CREATE TABLE cycle_b (id INT PRIMARY KEY, a_id INT NULL, CONSTRAINT b_a FOREIGN KEY(a_id) REFERENCES cycle_a(id)) ENGINE=InnoDB",
            "ALTER TABLE cycle_a ADD CONSTRAINT a_b FOREIGN KEY(b_id) REFERENCES cycle_b(id)",
            "INSERT INTO parent VALUES (1,10,'quoted, value')",
            "INSERT INTO child VALUES (1,1,10,NULL),(2,1,10,1)",
            "INSERT INTO cycle_a VALUES(1,NULL)", "INSERT INTO cycle_b VALUES(1,1)", "UPDATE cycle_a SET b_id=1 WHERE id=1",
        ] { sqlx::query(sql).execute(&source_pool).await.unwrap(); }
        let item = |name: &str, target: &str| CopyItem {
            table: TableInfo {
                schema: source_db.clone(),
                name: name.into(),
                kind: "table".into(),
            },
            target: TableInfo {
                schema: dest_db.clone(),
                name: target.into(),
                kind: "table".into(),
            },
        };
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let items = vec![
            item("child", "child_new"),
            item("cycle_b", "b_new"),
            item("cycle_a", "a_new"),
            item("parent", "parent_new"),
        ];
        // Incomplete selections stop before writing anything.
        assert!(copy_group(&source, &dest, &items[..1], true, None, &cancel)
            .await
            .unwrap_err()
            .contains("Copy dependency missing"));
        let count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
        )
        .bind(&dest_db)
        .fetch_one(root)
        .await
        .unwrap();
        assert_eq!(count, 0);
        copy_group(&source, &dest, &items, true, None, &cancel)
            .await
            .unwrap();
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM child_new")
            .fetch_one(&target_pool)
            .await
            .unwrap();
        assert_eq!(count, 2);
        let keys = foreign_keys(&target_pool, &items[0].target).await.unwrap();
        assert!(keys.iter().any(|key| key.parent.name == "parent_new"
            && key.parent_columns == ["tenant", "id"]
            && key.on_delete == "CASCADE"));
        assert!(keys.iter().any(|key| key.parent.name == "child_new"));
        assert_eq!(
            foreign_keys(&target_pool, &items[1].target).await.unwrap()[0]
                .parent
                .name,
            "a_new"
        );
        assert_eq!(
            foreign_keys(&target_pool, &items[2].target).await.unwrap()[0]
                .parent
                .name,
            "b_new"
        );
        assert!(copy_group(&source, &dest, &items, true, None, &cancel)
            .await
            .unwrap_err()
            .contains("Destination already exists"));
        // A source orphan must fail FK installation, never publish an unchecked group.
        let mut socket = source_pool.acquire().await.unwrap();
        socket.close_on_drop();
        sqlx::query("SET SESSION FOREIGN_KEY_CHECKS = 0")
            .execute(&mut *socket)
            .await
            .unwrap();
        sqlx::query("INSERT INTO child VALUES(3,99,999,NULL)")
            .execute(&mut *socket)
            .await
            .unwrap();
        drop(socket);
        let broken = vec![item("parent", "bad_parent"), item("child", "bad_child")];
        assert!(copy_group(&source, &dest, &broken, true, None, &cancel)
            .await
            .unwrap_err()
            .contains("Foreign key validation failed"));
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND (TABLE_NAME IN ('bad_child','bad_parent') OR TABLE_NAME LIKE '_dbde_%')").bind(&dest_db).fetch_one(root).await.unwrap();
        assert_eq!(count, 0);
        // Existing published tables are untouched by cleanup.
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM child_new")
            .fetch_one(&target_pool)
            .await
            .unwrap();
        assert_eq!(count, 2);
        source_pool.close().await;
        target_pool.close().await;
        for db in [&source_db, &dest_db] {
            sqlx::query(&format!("DROP DATABASE {}", quote(db, &Driver::Mysql)))
                .execute(root)
                .await
                .unwrap();
        }
        root.close().await;
    }
}
