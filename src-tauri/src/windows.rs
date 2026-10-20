use super::*;
use tokio::sync::oneshot;

struct PendingWindow {
    snapshot: Value,
    source: String,
    destination: String,
    tab_id: String,
    ready: oneshot::Sender<()>,
}
#[derive(Default)]
pub(crate) struct DetachedWindows(Mutex<HashMap<String, PendingWindow>>);

#[tauri::command]
pub(crate) async fn dbde_close_detached_window(window: tauri::WebviewWindow) -> DbResult<()> {
    if !window.label().starts_with("tab-") {
        return Err("Only detached windows can use this command.".into());
    }
    window.destroy().map_err(err)
}

async fn independent_pool(pool: &Pool, config: &ConnectionConfig) -> DbResult<Pool> {
    match pool {
        Pool::Pg(pool) => connection_options::pg_pool(config)
            .connect_with(pool.connect_options().as_ref().clone())
            .await
            .map(Pool::Pg)
            .map_err(err),
        Pool::My(pool) => connection_options::my_pool(config)
            .connect_with(pool.connect_options().as_ref().clone())
            .await
            .map(Pool::My)
            .map_err(err),
        Pool::Lite(pool) => connection_options::lite_pool(config)
            .connect_with(pool.connect_options().as_ref().clone())
            .await
            .map(Pool::Lite)
            .map_err(err),
    }
}

#[tauri::command]
pub(crate) async fn dbde_move_tab_to_window(
    app: tauri::AppHandle,
    connection_id: String,
    mut snapshot: Value,
    state: State<'_, AppState>,
    windows: State<'_, DetachedWindows>,
) -> DbResult<()> {
    if snapshot["tab"]["kind"].as_str() == Some("database") {
        return Err("Database tabs cannot be moved to a new window.".into());
    }
    let source = connection(&state, &connection_id).await?;
    if matches!(source.config.driver, Driver::Sqlite)
        && (source.config.file_path == ":memory:"
            || source.config.file_path.contains("mode=memory"))
    {
        return Err("In-memory SQLite tabs cannot move to a separate connection.".into());
    }
    let tab_id = snapshot["tab"]["id"]
        .as_str()
        .filter(|id| !id.is_empty())
        .ok_or("Invalid tab snapshot")?
        .to_owned();
    if snapshot["tab"]["connectionId"].as_str() != Some(&connection_id)
        || snapshot["tab"]["running"].as_bool() != Some(false)
    {
        return Err("Wait for the tab to finish before moving it.".into());
    }
    let pool = timed(independent_pool(&source.pool, &source.config)).await?;
    let destination = uuid::Uuid::new_v4().to_string();
    let label = format!("tab-{}", uuid::Uuid::new_v4());
    snapshot["tab"]["connectionId"] = json!(destination);
    snapshot["session"]["id"] = json!(destination);
    // Use the native profile: its serializer always omits passwords.
    snapshot["session"]["config"] = serde_json::to_value(&source.config).map_err(err)?;
    state.connections.lock().await.insert(
        destination.clone(),
        Connection {
            tunnel: source.tunnel.clone(),
            pool,
            config: source.config,
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        },
    );
    let (ready, receiver) = oneshot::channel();
    let title = format!(
        "{} — DBde",
        snapshot["tab"]["name"].as_str().unwrap_or("Workspace")
    );
    windows.0.lock().await.insert(
        label.clone(),
        PendingWindow {
            snapshot,
            source: connection_id,
            destination: destination.clone(),
            tab_id,
            ready,
        },
    );
    let created = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html#detached".into()),
    )
    .title(title)
    .focused(true)
    .inner_size(1100.0, 800.0)
    .min_inner_size(820.0, 600.0)
    .build();
    let window = match created {
        Ok(window) => window,
        Err(error) => {
            windows.0.lock().await.remove(&label);
            dbde_disconnect(destination, state).await?;
            return Err(err(error));
        }
    };
    let handle = app.clone();
    let cleanup_id = destination.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let handle = handle.clone();
            let id = cleanup_id.clone();
            tauri::async_runtime::spawn(async move {
                let _ = dbde_disconnect(id, handle.state::<AppState>()).await;
            });
        }
    });
    match tokio::time::timeout(Duration::from_secs(30), receiver).await {
        Ok(Ok(())) => Ok(()),
        _ => {
            windows.0.lock().await.remove(&label);
            let _ = window.destroy();
            dbde_disconnect(destination, state).await?;
            Err("The new window did not initialize. The tab remains in this window.".into())
        }
    }
}

#[tauri::command]
pub(crate) async fn dbde_get_detached_workspace(
    window: tauri::WebviewWindow,
    state: State<'_, AppState>,
    windows: State<'_, DetachedWindows>,
) -> DbResult<Value> {
    let pending = windows
        .0
        .lock()
        .await
        .remove(window.label())
        .ok_or("No workspace was assigned to this window.")?;
    if pending.ready.is_closed() {
        return Err("The move was cancelled.".into());
    }
    let source = connection(&state, &pending.source).await?;
    let destination = connection(&state, &pending.destination).await?;
    // Transfer the actual server session, preserving BEGIN/SET/temp tables.
    let slot = source.sessions.lock().await.remove(&pending.tab_id);
    if let Some(slot) = &slot {
        destination
            .sessions
            .lock()
            .await
            .insert(pending.tab_id.clone(), slot.clone());
    }
    if pending.ready.send(()).is_err() {
        if let Some(slot) = slot {
            destination.sessions.lock().await.remove(&pending.tab_id);
            source.sessions.lock().await.insert(pending.tab_id, slot);
        }
        return Err("The move was cancelled.".into());
    }
    Ok(pending.snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn detached_file_pool_survives_closing_the_original_pool() {
        let config = crate::tests::config(Driver::Sqlite);
        let path =
            std::env::temp_dir().join(format!("dbde-window-{}.sqlite", uuid::Uuid::new_v4()));
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true);
        let pool = connection_options::lite_pool(&config)
            .connect_with(options)
            .await
            .unwrap();
        sqlx::query("CREATE TABLE test (id INTEGER)")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO test VALUES (1)")
            .execute(&pool)
            .await
            .unwrap();
        let source = Pool::Lite(pool);
        let destination = independent_pool(&source, &crate::tests::config(Driver::Sqlite))
            .await
            .unwrap();
        close(source).await;
        let rows = query(&destination, "SELECT id FROM test").await.unwrap();
        assert_eq!(rows.rows, vec![vec![json!(1)]]);
        close(destination).await;
        std::fs::remove_file(path).unwrap();
    }
}
