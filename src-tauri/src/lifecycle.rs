use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Emitter;
#[derive(Default)]
pub(crate) struct Lifecycle(pub AtomicBool);
pub(crate) fn request(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit("dbde-close-requested", ());
    }
}
#[tauri::command]
pub(crate) fn dbde_finish_close(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    lifecycle: State<'_, Lifecycle>,
    operations: State<'_, operations::Operations>,
) -> DbResult<()> {
    if window.label() != "main" {
        return Err("Only the main window can quit the app.".into());
    }
    if operations.active() {
        return Err(
            "Wait for running copy, dump or transfer operations to finish, or cancel them first."
                .into(),
        );
    }
    if app
        .webview_windows()
        .keys()
        .any(|label| label.starts_with("tab-"))
    {
        return Err("Close detached table windows first so their unsaved changes and transactions can be reviewed.".into());
    }
    lifecycle.0.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}
