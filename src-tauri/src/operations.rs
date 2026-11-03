use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
pub(crate) struct Operations(std::sync::Mutex<HashMap<String, Arc<AtomicBool>>>);
pub(crate) struct Running<'a> {
    pub flag: Arc<AtomicBool>,
    id: String,
    registry: &'a Operations,
}
impl Operations {
    pub fn start(&self, id: String) -> DbResult<Running<'_>> {
        uuid::Uuid::parse_str(&id).map_err(err)?;
        let mut tasks = self.0.lock().map_err(err)?;
        if tasks.contains_key(&id) {
            return Err("This operation is already running.".into());
        }
        let flag = Arc::new(AtomicBool::new(false));
        tasks.insert(id.clone(), flag.clone());
        Ok(Running {
            flag,
            id,
            registry: self,
        })
    }
    pub fn active(&self) -> bool {
        self.0.lock().map_or(true, |tasks| !tasks.is_empty())
    }
}
impl Drop for Running<'_> {
    fn drop(&mut self) {
        if let Ok(mut tasks) = self.registry.0.lock() {
            tasks.remove(&self.id);
        }
    }
}
#[tauri::command]
pub(crate) fn dbde_cancel_operation(
    operation_id: String,
    operations: State<'_, Operations>,
) -> DbResult<()> {
    if let Some(flag) = operations.0.lock().map_err(err)?.get(&operation_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}
pub(crate) async fn controlled<T>(
    flag: &AtomicBool,
    seconds: u64,
    work: impl std::future::Future<Output = DbResult<T>>,
) -> DbResult<T> {
    tokio::pin!(work);
    let deadline = tokio::time::sleep(Duration::from_secs(seconds));
    tokio::pin!(deadline);
    loop {
        if flag.load(Ordering::Relaxed) {
            return Err("Operation cancelled. Refresh the destination before retrying.".into());
        }
        tokio::select! {
            result = &mut work => return result,
            _ = &mut deadline => return Err("Operation timed out. Refresh and verify the destination before retrying; work may have completed.".into()),
            _ = tokio::time::sleep(Duration::from_millis(100)) => {},
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn cancellation_drops_pending_work_and_releases_registry() {
        let tasks = Operations::default();
        let id = uuid::Uuid::new_v4().to_string();
        let job = tasks.start(id.clone()).unwrap();
        assert!(tasks.active());
        assert!(tasks.start(id).is_err());
        job.flag.store(true, Ordering::Relaxed);
        assert!(controlled::<()>(&job.flag, 30, std::future::pending())
            .await
            .unwrap_err()
            .contains("cancelled"));
        drop(job);
        assert!(!tasks.active());
    }
}
