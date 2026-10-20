use super::*;

#[derive(Clone, Deserialize)]
pub(crate) struct FieldRename {
    pub(crate) from: String,
    pub(crate) to: String,
}

pub(crate) fn validate(names: &[String], renames: &[FieldRename], driver: &Driver) -> DbResult<()> {
    if renames.is_empty() || renames.len() > 256 {
        return Err("Choose between 1 and 256 fields to rename.".into());
    }
    let normalize = |name: &str| {
        if matches!(driver, Driver::Postgres) {
            name.to_string()
        } else {
            name.to_lowercase()
        }
    };
    let limit = match driver {
        Driver::Mysql => 64,
        Driver::Postgres => 63,
        Driver::Sqlite => 255,
    };
    let mut sources = std::collections::HashSet::new();
    let mut targets = std::collections::HashSet::new();
    for rename in renames {
        let too_long = if matches!(driver, Driver::Mysql) {
            rename.to.chars().count() > limit
        } else {
            rename.to.len() > limit
        };
        if rename.to.trim().is_empty() || rename.to.contains('\0') || too_long {
            return Err(format!("Invalid field name: {}", rename.to));
        }
        if matches!(driver, Driver::Mysql) && rename.to.ends_with(' ') {
            return Err("MySQL field names cannot end with a space.".into());
        }
        if !names.contains(&rename.from) || !sources.insert(rename.from.clone()) {
            return Err("The table fields changed. Refresh the design before saving.".into());
        }
        if !targets.insert(normalize(&rename.to))
            || names
                .iter()
                .any(|name| name != &rename.from && normalize(name) == normalize(&rename.to))
        {
            return Err(format!(
                "Field name already exists: {}. Save its rename separately first.",
                rename.to
            ));
        }
    }
    Ok(())
}

// Preserve the server's complete column definition on older MariaDB/MySQL,
// where CHANGE COLUMN requires restating type, default, collation and extras.
pub(crate) fn mysql_definition(ddl: &str, name: &str, backslash_escapes: bool) -> DbResult<String> {
    let bytes = ddl.as_bytes();
    let (mut quote, mut depth, mut start, mut i) = (0u8, 0usize, 0usize, 0usize);
    let mut parts = Vec::new();
    while i < bytes.len() {
        let byte = bytes[i];
        if quote != 0 {
            if byte == b'\\' && backslash_escapes && quote != b'`' {
                i += 2;
                continue;
            }
            if byte == quote {
                if bytes.get(i + 1) == Some(&quote) {
                    i += 2;
                    continue;
                }
                quote = 0;
            }
        } else if byte == b'\'' || byte == b'"' || byte == b'`' {
            quote = byte;
        } else if byte == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                i += 1;
            }
            i += 2;
            continue;
        } else if byte == b'(' {
            depth += 1;
            if depth == 1 {
                start = i + 1;
            }
        } else if byte == b',' && depth == 1 {
            parts.push(ddl[start..i].trim());
            start = i + 1;
        } else if byte == b')' {
            if depth == 1 {
                parts.push(ddl[start..i].trim());
                break;
            }
            depth = depth.saturating_sub(1);
        }
        i += 1;
    }
    for part in parts {
        if !part.starts_with('`') {
            continue;
        }
        let p = part.as_bytes();
        let mut at = 1;
        while at < p.len() {
            if p[at] == b'`' {
                if p.get(at + 1) == Some(&b'`') {
                    at += 2;
                    continue;
                }
                if part[1..at].replace("``", "`") == name {
                    let definition = part[at + 1..].trim();
                    if !definition.is_empty() {
                        return Ok(definition.to_string());
                    }
                }
                break;
            }
            at += 1;
        }
    }
    Err(format!(
        "Cannot preserve the definition of {name}. Use SQL Editor for this field."
    ))
}

async fn rename_fields(
    conn: &Connection,
    table: &TableInfo,
    renames: &[FieldRename],
) -> DbResult<()> {
    if table.kind != "table" {
        return Err("Rename fields is available for tables only.".into());
    }
    let target = rows::qualified(table, &conn.config.driver);
    let q = |name: &str| rows::quote(name, &conn.config.driver);
    match &conn.pool {
        Pool::My(pool) => {
            let mut connection = pool.acquire().await.map_err(err)?;
            let names: Vec<String> = sqlx::query(&format!("SHOW FULL COLUMNS FROM {target}"))
                .fetch_all(&mut *connection)
                .await
                .map_err(err)?
                .iter()
                .map(|row| row.try_get(0).map_err(err))
                .collect::<DbResult<_>>()?;
            validate(&names, renames, &Driver::Mysql)?;
            let mode: String = sqlx::query_scalar("SELECT @@SESSION.sql_mode")
                .fetch_one(&mut *connection)
                .await
                .map_err(err)?;
            let row = sqlx::query(&format!("SHOW CREATE TABLE {target}"))
                .fetch_one(&mut *connection)
                .await
                .map_err(err)?;
            let ddl: String = row.try_get(1).map_err(err)?;
            let mut changes = Vec::new();
            for rename in renames {
                changes.push(format!(
                    "CHANGE COLUMN {} {} {}",
                    q(&rename.from),
                    q(&rename.to),
                    mysql_definition(
                        &ddl,
                        &rename.from,
                        !mode.split(',').any(|mode| mode == "NO_BACKSLASH_ESCAPES")
                    )?
                ));
            }
            // One ALTER statement: never leave a partially renamed batch after a SQL error.
            sqlx::query(&format!("ALTER TABLE {target} {}", changes.join(", ")))
                .execute(&mut *connection)
                .await
                .map_err(err)?;
        }
        Pool::Pg(pool) => {
            let mut tx = pool.begin().await.map_err(err)?;
            sqlx::query(&format!("LOCK TABLE {target} IN ACCESS EXCLUSIVE MODE"))
                .execute(&mut *tx)
                .await
                .map_err(err)?;
            let names: Vec<String> = sqlx::query_scalar("SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2")
                .bind(&table.schema).bind(&table.name).fetch_all(&mut *tx).await.map_err(err)?;
            validate(&names, renames, &Driver::Postgres)?;
            for rename in renames {
                sqlx::query(&format!(
                    "ALTER TABLE {target} RENAME COLUMN {} TO {}",
                    q(&rename.from),
                    q(&rename.to)
                ))
                .execute(&mut *tx)
                .await
                .map_err(err)?;
            }
            tx.commit().await.map_err(err)?;
        }
        Pool::Lite(pool) => {
            let mut tx = pool.begin().await.map_err(err)?;
            let names: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_xinfo(?)")
                .bind(&table.name)
                .fetch_all(&mut *tx)
                .await
                .map_err(err)?;
            validate(&names, renames, &Driver::Sqlite)?;
            for rename in renames {
                sqlx::query(&format!(
                    "ALTER TABLE {target} RENAME COLUMN {} TO {}",
                    q(&rename.from),
                    q(&rename.to)
                ))
                .execute(&mut *tx)
                .await
                .map_err(err)?;
            }
            tx.commit().await.map_err(err)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn dbde_rename_table_fields(
    connection_id: String,
    database: String,
    table: TableInfo,
    renames: Vec<FieldRename>,
    state: State<'_, AppState>,
) -> DbResult<()> {
    timed(async {
        let conn = database_connection(&state, &connection_id, Some(&database)).await?;
        rename_fields(&conn, &table, &renames).await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_full_mysql_definition_including_quoted_commas_and_nested_expressions() {
        let ddl = "CREATE TABLE `t(x` (\n`id` int(11) NOT NULL AUTO_INCREMENT,\n`na``me` varchar(40) COLLATE utf8mb4_bin DEFAULT 'a,b' COMMENT 'x) y',\n`total` decimal(10,2) GENERATED ALWAYS AS ((`qty` * 2)) STORED, PRIMARY KEY (`id`)) ENGINE=InnoDB";
        assert_eq!(
            mysql_definition(ddl, "na`me", true).unwrap(),
            "varchar(40) COLLATE utf8mb4_bin DEFAULT 'a,b' COMMENT 'x) y'"
        );
        assert_eq!(
            mysql_definition(ddl, "id", true).unwrap(),
            "int(11) NOT NULL AUTO_INCREMENT"
        );
        assert!(mysql_definition(ddl, "total", true)
            .unwrap()
            .ends_with("STORED"));
        assert!(mysql_definition(ddl, "missing", true).is_err());
        assert_eq!(
            mysql_definition(
                "CREATE TABLE `t` (`x` text DEFAULT 'it''s\\', `y` int)",
                "y",
                false
            )
            .unwrap(),
            "int"
        );
    }
    #[tokio::test]
    async fn sqlite_rename_preserves_records_and_rolls_back_on_dependency_failure() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::raw_sql("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT DEFAULT 'Guest', note TEXT); CREATE INDEX ix_name ON t(name); INSERT INTO t VALUES (1,'Ada','x');").execute(&pool).await.unwrap();
        let conn = Connection {
            tunnel: None,
            pool: Pool::Lite(pool.clone()),
            config: super::super::tests::config(Driver::Sqlite),
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        };
        let table = TableInfo {
            name: "t".into(),
            schema: "".into(),
            kind: "table".into(),
        };
        rename_fields(
            &conn,
            &table,
            &[FieldRename {
                from: "name".into(),
                to: "full name".into(),
            }],
        )
        .await
        .unwrap();
        let value: String = sqlx::query_scalar("SELECT \"full name\" FROM t")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(value, "Ada");
        let index: String =
            sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE name='ix_name'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(index.contains("full name"));
        assert!(rename_fields(
            &conn,
            &table,
            &[FieldRename {
                from: "note".into(),
                to: "ID".into()
            }]
        )
        .await
        .is_err());
        sqlx::raw_sql(
            "CREATE TABLE u (other TEXT); CREATE VIEW dependent AS SELECT note FROM t,u;",
        )
        .execute(&pool)
        .await
        .unwrap();
        assert!(rename_fields(
            &conn,
            &table,
            &[
                FieldRename {
                    from: "id".into(),
                    to: "record_id".into()
                },
                FieldRename {
                    from: "note".into(),
                    to: "other".into()
                },
            ]
        )
        .await
        .is_err());
        let names: Vec<String> = sqlx::query_scalar("SELECT name FROM pragma_table_info('t')")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(names.contains(&"id".to_string()));
        assert!(!names.contains(&"record_id".to_string()));
    }
    #[tokio::test]
    #[ignore = "Uses session-local temporary tables only; requires DBDE_TEST_MYSQL_URL"]
    async fn mysql_rename_keeps_full_definition_and_data() {
        let url = std::env::var("DBDE_TEST_MYSQL_URL")
            .expect("Set DBDE_TEST_MYSQL_URL to a test database URL");
        let pool = sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        sqlx::query("CREATE TEMPORARY TABLE dbde_rename_test (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY, label VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'Guest' COMMENT 'keep, (all)', qty DECIMAL(10,2) DEFAULT 0, total DECIMAL(10,2) GENERATED ALWAYS AS (qty * 2) STORED, UNIQUE KEY ix_label(label))").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO dbde_rename_test(label,qty) VALUES ('Ada',3)")
            .execute(&pool)
            .await
            .unwrap();
        let conn = Connection {
            tunnel: None,
            pool: Pool::My(pool.clone()),
            config: super::super::tests::config(Driver::Mysql),
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        };
        let table = TableInfo {
            name: "dbde_rename_test".into(),
            schema: "".into(),
            kind: "table".into(),
        };
        let row = sqlx::query("SHOW CREATE TABLE dbde_rename_test")
            .fetch_one(&pool)
            .await
            .unwrap();
        let before: String = row.try_get(1).unwrap();
        rename_fields(
            &conn,
            &table,
            &[FieldRename {
                from: "label".into(),
                to: "display label".into(),
            }],
        )
        .await
        .unwrap();
        let row = sqlx::query("SHOW CREATE TABLE dbde_rename_test")
            .fetch_one(&pool)
            .await
            .unwrap();
        let after: String = row.try_get(1).unwrap();
        assert_eq!(
            mysql_definition(&before, "label", true).unwrap(),
            mysql_definition(&after, "display label", true).unwrap()
        );
        let value: Vec<u8> = sqlx::query_scalar("SELECT `display label` FROM dbde_rename_test")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(value, b"Ada");
        assert!(after.contains("ix_label` (`display label`)"));
        sqlx::query("DROP TEMPORARY TABLE dbde_rename_test")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
    }
}
