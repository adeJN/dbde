use super::*;
use tauri_plugin_dialog::DialogExt;

#[derive(Deserialize)]
pub(crate) struct DatabaseChange {
    name: String,
    #[serde(default)]
    charset: String,
    #[serde(default)]
    collation: String,
}
fn database_sql(
    driver: &Driver,
    database: &str,
    action: &str,
    change: &DatabaseChange,
) -> DbResult<String> {
    if *driver == Driver::Sqlite {
        return Err("SQLite databases are files; manage them through connections".into());
    }
    let validate = |name: &str| -> DbResult<()> {
        let limit = if *driver == Driver::Postgres { 63 } else { 64 };
        if name.trim().is_empty() || name.len() > limit || name.contains('\0') {
            return Err(format!(
                "Database names must contain 1–{limit} bytes and no NUL characters"
            ));
        }
        Ok(())
    };
    // Creating from the connection menu has no existing database context.
    // Only edit/delete require a valid source database.
    if action != "create" {
        validate(database)?;
    }
    validate(&change.name)?;
    if ["edit", "delete"].contains(&action) && protected_database(driver, database) {
        return Err("System databases cannot be changed from this menu".into());
    }
    let q = |name: &str| rows::quote(name, driver);
    match action {
        "delete" => Ok(format!("DROP DATABASE {}", q(database))),
        "create" | "edit" if *driver == Driver::Mysql => {
            if action == "edit" && change.name != database {
                return Err("MySQL does not support renaming a database".into());
            }
            let mut options = Vec::new();
            for (label, value) in [
                ("CHARACTER SET", &change.charset),
                ("COLLATE", &change.collation),
            ] {
                if value.is_empty() {
                    continue;
                }
                if !value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_')
                {
                    return Err("Choose a valid character set or collation name".into());
                }
                options.push(format!("{label} {}", q(value)));
            }
            if action == "edit" && options.is_empty() {
                return Err("Enter a character set or collation".into());
            }
            Ok(format!(
                "{} DATABASE {} {}",
                if action == "create" {
                    "CREATE"
                } else {
                    "ALTER"
                },
                q(&change.name),
                options.join(" ")
            ))
        }
        "create" => Ok(format!("CREATE DATABASE {}", q(&change.name))),
        "edit" => {
            if change.name == database {
                return Err("Enter a different database name".into());
            }
            Ok(format!(
                "ALTER DATABASE {} RENAME TO {}",
                q(database),
                q(&change.name)
            ))
        }
        _ => Err("Unsupported database action".into()),
    }
}
fn protected_database(driver: &Driver, database: &str) -> bool {
    match driver {
        Driver::Mysql => ["mysql", "information_schema", "performance_schema", "sys"]
            .contains(&database.to_ascii_lowercase().as_str()),
        Driver::Postgres => ["postgres", "template0", "template1"].contains(&database),
        Driver::Sqlite => true,
    }
}
fn mysql_move_tables(database: &str, target: &str, tables: &[String]) -> Option<String> {
    if tables.is_empty() {
        return None;
    }
    let q = |name: &str| rows::quote(name, &Driver::Mysql);
    Some(format!(
        "RENAME TABLE {}",
        tables
            .iter()
            .map(|table| format!("{}.{} TO {}.{}", q(database), q(table), q(target), q(table)))
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

// MySQL has no RENAME DATABASE. Move supported base tables in one RENAME TABLE
// statement, retaining the source if anything prevents completing the move.
async fn rename_mysql_database(
    state: &AppState,
    id: &str,
    admin: &Pool,
    database: &str,
    target: &str,
) -> DbResult<()> {
    // Reuse create/delete validation without allowing a system database to move.
    let change = DatabaseChange {
        name: target.into(),
        charset: String::new(),
        collation: String::new(),
    };
    database_sql(&Driver::Mysql, database, "delete", &change)?;
    database_sql(&Driver::Mysql, "", "create", &change)?;
    if protected_database(&Driver::Mysql, target) {
        return Err("Choose a non-system destination database name".into());
    }
    // Bound metadata-lock waits on this dedicated, single-connection admin pool.
    query(admin, "SET SESSION lock_wait_timeout = 5").await?;
    let params = vec![database.into(), target.into()];
    let schemas = metadata_query(admin,
        "SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (?, ?)", &params).await?;
    let source = schemas
        .rows
        .iter()
        .find(|row| row[0].as_str() == Some(database))
        .ok_or("The source database no longer exists")?;
    if schemas
        .rows
        .iter()
        .any(|row| row[0].as_str() == Some(target))
    {
        return Err("The destination database already exists; choose a new name".into());
    }
    let charset = source[1]
        .as_str()
        .ok_or("Unable to read the database character set")?;
    let collation = source[2]
        .as_str()
        .ok_or("Unable to read the database collation")?;
    let source_params = vec![database.into()];
    // Catalog rows are privilege-filtered. Require full visibility of source
    // objects before treating an empty catalog as permission to remove it.
    let visibility = metadata_query(admin,
        "SELECT COUNT(DISTINCT PRIVILEGE_TYPE) FROM (SELECT PRIVILEGE_TYPE FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = CONCAT(QUOTE(SUBSTRING_INDEX(CURRENT_USER(), '@', 1)), '@', QUOTE(SUBSTRING_INDEX(CURRENT_USER(), '@', -1))) UNION ALL SELECT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = CONCAT(QUOTE(SUBSTRING_INDEX(CURRENT_USER(), '@', 1)), '@', QUOTE(SUBSTRING_INDEX(CURRENT_USER(), '@', -1))) AND TABLE_SCHEMA = ?) AS privileges WHERE PRIVILEGE_TYPE IN ('SELECT', 'SHOW VIEW', 'TRIGGER', 'EVENT', 'ALTER ROUTINE')",
        &source_params).await?;
    if visibility.rows[0][0].as_i64() != Some(5) {
        return Err("Rename requires direct SELECT, SHOW VIEW, TRIGGER, EVENT and ALTER ROUTINE privileges on the source so all objects can be checked. Ask an administrator to perform the migration; no changes were made".into());
    }
    // Triggers/views/routines/events and cross-schema references require a full
    // reviewed migration. Do not silently omit or rewrite their SQL definitions.
    let blockers = metadata_query(admin,
        "SELECT (SELECT COUNT(*) FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?) + (SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ?) + (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?) + (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?) + (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE REFERENCED_TABLE_SCHEMA IS NOT NULL AND ((TABLE_SCHEMA = ? AND REFERENCED_TABLE_SCHEMA <> ?) OR (REFERENCED_TABLE_SCHEMA = ? AND TABLE_SCHEMA <> ?))) AS blockers",
        &vec![database.into(); 8]).await?;
    if blockers.rows[0][0].as_i64().unwrap_or(-1) != 0 {
        return Err("This database has views, triggers, routines, events or cross-database foreign keys. Rename requires a reviewed dump/restore migration; no changes were made".into());
    }
    let tables = metadata_query(admin,
        "SELECT TABLE_NAME, TABLE_TYPE, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME", &source_params).await?;
    let mut names = Vec::new();
    for row in &tables.rows {
        if row[1].as_str() != Some("BASE TABLE") || row[2].as_str() != Some("InnoDB") {
            return Err("Rename supports InnoDB base tables only; no changes were made".into());
        }
        names.push(
            row[0]
                .as_str()
                .ok_or("Unable to read a table name")?
                .to_string(),
        );
    }
    let create = database_sql(
        &Driver::Mysql,
        "",
        "create",
        &DatabaseChange {
            name: target.into(),
            charset: charset.into(),
            collation: collation.into(),
        },
    )?;
    close_database(state, id, database).await?;
    query(admin, &create).await?;
    if let Some(sql) = mysql_move_tables(database, target, &names) {
        query(admin, &sql).await.map_err(|e| format!(
            "Could not finish renaming {database} to {target}: {e}. Both databases have been retained. Refresh and inspect them before retrying"
        ))?;
    }
    // A concurrent writer may have added an object after preflight. Never drop
    // a source that still contains tables or programmable objects.
    let remaining = metadata_query(admin,
        "SELECT (SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?) + (SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ?) + (SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?) AS remaining",
        &vec![database.into(); 3]).await?;
    if remaining.rows[0][0].as_i64().unwrap_or(-1) != 0 {
        return Err(format!("Tables moved to {target}, but new objects appeared in {database}. The source was retained; inspect both databases before continuing"));
    }
    query(admin, &format!("DROP DATABASE {}", rows::quote(database, &Driver::Mysql)))
        .await.map_err(|e| format!("Tables moved to {target}, but the empty source {database} could not be removed: {e}. Refresh the database list"))?;
    Ok(())
}
async fn maintenance_pool(conn: &Connection) -> DbResult<(Pool, String)> {
    match &conn.pool {
        Pool::Pg(p) => {
            let name = "postgres";
            sqlx::postgres::PgPoolOptions::new()
                .max_connections(1)
                .acquire_timeout(Duration::from_secs(10))
                .connect_with(p.connect_options().as_ref().clone().database(name))
                .await
                .map(|p| (Pool::Pg(p), name.into()))
                .map_err(err)
        }
        Pool::My(p) => {
            let name = "information_schema";
            sqlx::mysql::MySqlPoolOptions::new()
                .max_connections(1)
                .acquire_timeout(Duration::from_secs(10))
                .connect_with(p.connect_options().as_ref().clone().database(name))
                .await
                .map(|p| (Pool::My(p), name.into()))
                .map_err(err)
        }
        Pool::Lite(_) => Err("SQLite databases are files".into()),
    }
}
// Release our own connections before PostgreSQL DROP/RENAME, without terminating other clients.
async fn close_database(state: &AppState, id: &str, database: &str) -> DbResult<()> {
    let conn = connection(state, id).await?;
    if matches!(conn.pool, Pool::Lite(_)) {
        return Ok(());
    }
    let slots: Vec<_> = conn
        .sessions
        .lock()
        .await
        .iter()
        .map(|(id, slot)| (id.clone(), slot.clone()))
        .collect();
    let mut affected = Vec::new();
    for (id, slot) in slots {
        let session = slot
            .session
            .try_lock()
            .map_err(|_| "Wait for running queries to finish before closing the database")?;
        if session.as_ref().is_some_and(|s| s.database == database) {
            affected.push((id, slot.clone()));
        }
    }
    // Prepare the replacement before closing any pooled connections.
    let replacement = if conn.config.database == database {
        Some(maintenance_pool(&conn).await?)
    } else {
        None
    };
    for (session_id, slot) in affected {
        conn.sessions.lock().await.remove(&session_id);
        if let Some(session) = slot.session.lock().await.take() {
            close_session(session).await;
        }
    }
    if let Some(pool) = conn.databases.lock().await.remove(database) {
        close(pool).await;
    }
    if let Some((pool, maintenance)) = replacement {
        let previous = {
            let mut connections = state.connections.lock().await;
            let current = connections.get_mut(id).ok_or("Connection was closed")?;
            current.config.database = maintenance;
            std::mem::replace(&mut current.pool, pool)
        };
        close(previous).await;
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn dbde_close_database(
    connection_id: String,
    database: String,
    state: State<'_, AppState>,
) -> DbResult<()> {
    timed(close_database(&state, &connection_id, &database)).await
}
#[tauri::command]
pub(crate) async fn dbde_manage_database(
    connection_id: String,
    database: String,
    action: String,
    change: DatabaseChange,
    state: State<'_, AppState>,
) -> DbResult<()> {
    timed(async {
        let conn = connection(&state, &connection_id).await?;
        let mysql_rename =
            action == "edit" && conn.config.driver == Driver::Mysql && database != change.name;
        let sql = if mysql_rename {
            None
        } else {
            Some(database_sql(
                &conn.config.driver,
                &database,
                &action,
                &change,
            )?)
        };
        let (admin, _) = maintenance_pool(&conn).await?;
        let result = async {
            if mysql_rename {
                return rename_mysql_database(
                    &state,
                    &connection_id,
                    &admin,
                    &database,
                    &change.name,
                )
                .await;
            }
            if action == "delete" || (action == "edit" && conn.config.driver == Driver::Postgres) {
                close_database(&state, &connection_id, &database).await?;
            }
            query(&admin, sql.as_deref().ok_or("Missing database statement")?).await?;
            Ok(())
        }
        .await;
        close(admin).await;
        result
    })
    .await
}
#[derive(Serialize)]
pub(crate) struct SqlFile {
    name: String,
    contents: String,
}
#[tauri::command]
pub(crate) async fn dbde_open_sql_file(app: tauri::AppHandle) -> DbResult<Option<SqlFile>> {
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("SQL", &["sql"])
            .blocking_pick_file()
    })
    .await
    .map_err(err)?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let path = path.into_path().map_err(err)?;
    if tokio::fs::metadata(&path).await.map_err(err)?.len() > 20 * 1024 * 1024 {
        return Err("SQL files must not exceed 20 MB".into());
    }
    let contents = tokio::fs::read_to_string(&path).await.map_err(err)?;
    if contents.len() > 20 * 1024 * 1024 || contents.contains('\0') {
        return Err("Choose a UTF-8 SQL text file up to 20 MB".into());
    }
    Ok(Some(SqlFile {
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into(),
        contents: contents.trim_start_matches('\u{feff}').into(),
    }))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires an isolated disposable DBDE_TEST_MYSQL_URL with CREATE/DROP DATABASE privileges"]
    async fn mysql_database_rename_preserves_records_and_blocks_unsupported_objects() {
        let mut conn = crate::tests::server_connection("DBDE_TEST_MYSQL_URL", Driver::Mysql).await;
        let prefix = format!("dbde_rename_{}", uuid::Uuid::new_v4().simple());
        let source = format!("{prefix} old");
        let target = format!("{prefix} new");
        let (admin, _) = maintenance_pool(&conn).await.unwrap();
        let q = |name: &str| rows::quote(name, &Driver::Mysql);
        query(
            &admin,
            &format!(
                "CREATE DATABASE {} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
                q(&source)
            ),
        )
        .await
        .unwrap();
        conn.config.database = source.clone();
        let state = AppState {
            connections: Mutex::new(HashMap::from([("rename".into(), conn)])),
            profiles: Mutex::new(()),
            profile_path: PathBuf::new(),
        };
        query(&admin, &format!("CREATE TABLE {}.parent (id INT PRIMARY KEY, note VARCHAR(100), payload BLOB) ENGINE=InnoDB", q(&source))).await.unwrap();
        query(&admin, &format!("CREATE TABLE {}.child (id INT PRIMARY KEY, parent_id INT, FOREIGN KEY (parent_id) REFERENCES {}.parent(id)) ENGINE=InnoDB", q(&source), q(&source))).await.unwrap();
        query(
            &admin,
            &format!(
                "INSERT INTO {}.parent VALUES (1, 'café', X'00FF')",
                q(&source)
            ),
        )
        .await
        .unwrap();
        query(
            &admin,
            &format!("INSERT INTO {}.child VALUES (1,1)", q(&source)),
        )
        .await
        .unwrap();
        query(
            &admin,
            &format!(
                "CREATE VIEW {}.blocked AS SELECT id FROM {}.parent",
                q(&source),
                q(&source)
            ),
        )
        .await
        .unwrap();
        let blocked = rename_mysql_database(&state, "rename", &admin, &source, &target)
            .await
            .unwrap_err();
        assert!(blocked.contains("views"), "{blocked}");
        let schemas = metadata_query(
            &admin,
            "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
            std::slice::from_ref(&target),
        )
        .await
        .unwrap();
        assert!(schemas.rows.is_empty());
        query(&admin, &format!("DROP VIEW {}.blocked", q(&source)))
            .await
            .unwrap();
        rename_mysql_database(&state, "rename", &admin, &source, &target)
            .await
            .unwrap();
        let data = query(
            &admin,
            &format!("SELECT note, HEX(payload) FROM {}.parent", q(&target)),
        )
        .await
        .unwrap();
        assert_eq!(data.rows, vec![vec![json!("café"), json!("00FF")]]);
        let fk = metadata_query(&admin, "SELECT REFERENCED_TABLE_SCHEMA FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME = 'parent'", std::slice::from_ref(&target)).await.unwrap();
        assert_eq!(fk.rows[0][0], json!(target));
        let defaults = metadata_query(
            &admin,
            "SELECT DEFAULT_COLLATION_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?",
            std::slice::from_ref(&target),
        )
        .await
        .unwrap();
        assert_eq!(defaults.rows[0][0], json!("utf8mb4_unicode_ci"));
        let empty = format!("{prefix} empty");
        rename_mysql_database(&state, "rename", &admin, &target, &source)
            .await
            .unwrap();
        query(&admin, &format!("CREATE DATABASE {}", q(&empty)))
            .await
            .unwrap();
        let collision = rename_mysql_database(&state, "rename", &admin, &source, &empty)
            .await
            .unwrap_err();
        assert!(collision.contains("already exists"));
        query(&admin, &format!("DROP DATABASE {}", q(&source)))
            .await
            .unwrap();
        rename_mysql_database(&state, "rename", &admin, &empty, &target)
            .await
            .unwrap();
        query(&admin, &format!("DROP DATABASE {}", q(&target)))
            .await
            .unwrap();
        close(admin).await;
    }
    fn change(name: &str) -> DatabaseChange {
        DatabaseChange {
            name: name.into(),
            charset: String::new(),
            collation: String::new(),
        }
    }
    #[test]
    fn creating_from_connection_root_only_requires_the_new_database_name() {
        let mut new = change("backend");
        new.charset = "utf8mb4".into();
        assert_eq!(
            database_sql(&Driver::Mysql, "", "create", &new).unwrap(),
            "CREATE DATABASE `backend` CHARACTER SET `utf8mb4`"
        );
        assert_eq!(
            database_sql(&Driver::Postgres, "", "create", &change("backend")).unwrap(),
            "CREATE DATABASE \"backend\""
        );
        for name in ["", " ", "bad\0name", &"x".repeat(65)] {
            assert!(database_sql(&Driver::Mysql, "", "create", &change(name)).is_err());
        }
        for action in ["edit", "delete"] {
            assert!(database_sql(&Driver::Mysql, "", action, &new).is_err());
        }
    }
    #[test]
    fn mysql_database_moves_quote_every_identifier_and_handle_empty_databases() {
        assert_eq!(mysql_move_tables("old db", "new`db", &["a`b".into(), "other".into()]).unwrap(),
            "RENAME TABLE `old db`.`a``b` TO `new``db`.`a``b`, `old db`.`other` TO `new``db`.`other`");
        assert!(mysql_move_tables("old", "new", &[]).is_none());
    }
    #[test]
    fn database_commands_quote_names_and_reject_system_deletion_and_unsafe_options() {
        assert_eq!(
            database_sql(&Driver::Mysql, "app", "create", &change("a`b")).unwrap(),
            "CREATE DATABASE `a``b` "
        );
        assert_eq!(
            database_sql(&Driver::Postgres, "app", "edit", &change("new\"db")).unwrap(),
            "ALTER DATABASE \"app\" RENAME TO \"new\"\"db\""
        );
        assert!(database_sql(&Driver::Mysql, "mysql", "delete", &change("mysql")).is_err());
        assert!(
            database_sql(&Driver::Postgres, "postgres", "delete", &change("postgres")).is_err()
        );
        assert!(database_sql(&Driver::Mysql, "app", "edit", &change("rename")).is_err());
        let mut c = change("app");
        c.charset = "utf8mb4; DROP DATABASE app".into();
        assert!(database_sql(&Driver::Mysql, "app", "edit", &c).is_err());
        assert!(database_sql(&Driver::Sqlite, "app", "delete", &change("app")).is_err());
        assert!(
            database_sql(&Driver::Postgres, "app", "create", &change(&"x".repeat(64))).is_err()
        );
    }
}
