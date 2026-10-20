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
    validate(database)?;
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
        let sql = database_sql(&conn.config.driver, &database, &action, &change)?;
        let (admin, _) = maintenance_pool(&conn).await?;
        let result = async {
            if action == "delete" || (action == "edit" && conn.config.driver == Driver::Postgres) {
                close_database(&state, &connection_id, &database).await?;
            }
            query(&admin, &sql).await?;
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
    fn change(name: &str) -> DatabaseChange {
        DatabaseChange {
            name: name.into(),
            charset: String::new(),
            collation: String::new(),
        }
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
