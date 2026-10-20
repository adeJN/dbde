use super::*;
use tauri::{ipc::Channel, AppHandle, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Default)]
pub(crate) struct Updates {
    pending: Mutex<Option<Update>>,
    operation: Mutex<()>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateStatus {
    current_version: String,
    configured: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AvailableUpdate {
    version: String,
    current_version: String,
    notes: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "event", rename_all = "camelCase")]
pub(crate) enum Progress {
    Download { downloaded: u64, total: Option<u64> },
    Installing,
}

fn main_only(window: &WebviewWindow) -> DbResult<()> {
    if window.label() != "main" {
        return Err("Manage app updates from the main window.".into());
    }
    Ok(())
}

fn validate_config(config: &tauri_plugin_updater::Config) -> DbResult<()> {
    if config.pubkey.trim().is_empty() || config.endpoints.is_empty() {
        return Err("App updates have not been configured for this build.".into());
    }
    if config.dangerous_insecure_transport_protocol
        || config.dangerous_accept_invalid_certs
        || config.dangerous_accept_invalid_hostnames
        || config.allow_downgrades
        || config.endpoints.iter().any(|url| url.scheme() != "https")
    {
        return Err(
            "App updates require HTTPS, valid certificates and upgrade-only releases.".into(),
        );
    }
    Ok(())
}

fn configured(app: &AppHandle) -> DbResult<()> {
    let value = app
        .config()
        .plugins
        .0
        .get("updater")
        .cloned()
        .ok_or("App updates have not been configured for this build.")?;
    let config: tauri_plugin_updater::Config = serde_json::from_value(value).map_err(err)?;
    validate_config(&config)
}

#[tauri::command]
pub(crate) fn dbde_update_status(app: AppHandle, window: WebviewWindow) -> DbResult<UpdateStatus> {
    main_only(&window)?;
    Ok(UpdateStatus {
        current_version: app.package_info().version.to_string(),
        configured: configured(&app).is_ok(),
    })
}

#[tauri::command]
pub(crate) async fn dbde_check_update(
    app: AppHandle,
    window: WebviewWindow,
    updates: State<'_, Updates>,
) -> DbResult<Option<AvailableUpdate>> {
    main_only(&window)?;
    configured(&app)?;
    let _operation = updates
        .operation
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    *updates.pending.lock().await = None;
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(err)?;
    let found = tokio::time::timeout(Duration::from_secs(20), updater.check())
        .await.map_err(|_| "Update check timed out. Check your internet connection and retry.")?
        .map_err(|e| format!("Unable to check GitHub Releases. If this is the first release, publish latest.json first. {e}"))?;
    let info = found.as_ref().map(|update| AvailableUpdate {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone().unwrap_or_default(),
    });
    *updates.pending.lock().await = found;
    Ok(info)
}

#[tauri::command]
pub(crate) async fn dbde_install_update(
    app: AppHandle,
    window: WebviewWindow,
    updates: State<'_, Updates>,
    state: State<'_, AppState>,
    exports: State<'_, export::Exports>,
    imports: State<'_, import::Imports>,
    on_event: Channel<Progress>,
) -> DbResult<()> {
    main_only(&window)?;
    configured(&app)?;
    let _operation = updates
        .operation
        .try_lock()
        .map_err(|_| "An update operation is already running.")?;
    // Keep this lock until restart: new connections cannot start during installation.
    let connections = state.connections.lock().await;
    if !connections.is_empty() {
        return Err(
            "Save your work and close every connection before installing the update.".into(),
        );
    }
    if app.webview_windows().len() > 1 {
        return Err("Close detached table windows before installing the update.".into());
    }
    if exports.is_busy()? || imports.is_busy()? {
        return Err("Wait for imports and exports to finish before installing the update.".into());
    }
    let pending = updates.pending.lock().await;
    let update = pending
        .as_ref()
        .ok_or("Check for updates before installing.")?;
    let mut downloaded = 0u64;
    let bytes = update
        .download(
            |length, total| {
                downloaded = downloaded.saturating_add(length as u64);
                let _ = on_event.send(Progress::Download { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| format!("Update download or signature verification failed: {e}"))?;
    // download() verifies the signature. Never install bytes received from the webview.
    let _ = on_event.send(Progress::Installing);
    update
        .install(bytes)
        .map_err(|e| format!("Unable to install the update: {e}"))?;
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_unconfigured_and_unsafe_updates() {
        assert!(validate_config(&Default::default()).is_err());
        let mut config = tauri_plugin_updater::Config {
            pubkey: "public-key".into(),
            endpoints: vec![
                "https://github.com/adeJN/dbde/releases/latest/download/latest.json"
                    .parse()
                    .unwrap(),
            ],
            ..Default::default()
        };
        assert!(validate_config(&config).is_ok());
        config.allow_downgrades = true;
        assert!(validate_config(&config).is_err());
        config.allow_downgrades = false;
        config.endpoints = vec!["http://example.com/latest.json".parse().unwrap()];
        assert!(validate_config(&config).is_err());
    }
}
