//! Query history, saved queries and user snippets, stored as files in the app data dir.
//!
//! Every window (main and detached) talks to this one backend, so a single lock
//! serialises all writers: no window can overwrite another window's entries.
//! History is append-only JSON Lines (one entry per line, compacted when it grows
//! past its caps); saved queries and snippets are JSON arrays written atomically.
//! Changes are broadcast to all windows with the `dbde://query-library` event.
use super::*;
use std::io::Write as _;
use std::path::Path;
use std::sync::Mutex as StdMutex;
use tauri::Emitter;

pub(crate) const MAX_HISTORY_ENTRIES: usize = 2_000;
pub(crate) const MAX_HISTORY_BYTES: u64 = 8 * 1024 * 1024;
/// 64 KB of SQL (the frontend truncates) plus metadata; JSON escaping can double it.
const MAX_HISTORY_ENTRY_BYTES: usize = 160 * 1024;
const MAX_LIBRARY_ITEMS: usize = 5_000;
const MAX_LIBRARY_ITEM_BYTES: usize = 2 * 1024 * 1024;
const MAX_LIBRARY_BYTES: usize = 32 * 1024 * 1024;
pub(crate) const CHANGE_EVENT: &str = "dbde://query-library";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum LibraryKind {
    SavedQueries,
    Snippets,
}
impl LibraryKind {
    fn file(self) -> &'static str {
        match self {
            LibraryKind::SavedQueries => "saved_queries.json",
            LibraryKind::Snippets => "snippets.json",
        }
    }
}

pub(crate) struct QueryLibrary {
    directory: PathBuf,
    /// Cached number of history lines; `None` until the file is first counted.
    history_lines: StdMutex<Option<usize>>,
}
impl QueryLibrary {
    pub(crate) fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            history_lines: StdMutex::new(None),
        }
    }
    fn history_path(&self) -> PathBuf {
        self.directory.join("query_history.jsonl")
    }
    fn library_path(&self, kind: LibraryKind) -> PathBuf {
        self.directory.join(kind.file())
    }
    fn lock(&self) -> DbResult<std::sync::MutexGuard<'_, Option<usize>>> {
        self.history_lines
            .lock()
            .map_err(|_| "The query library is unavailable".to_string())
    }
    pub(crate) fn list_history(&self) -> DbResult<Vec<Value>> {
        let mut lines = self.lock()?;
        let entries = read_history(&self.history_path())?;
        *lines = Some(entries.len());
        Ok(entries)
    }
    pub(crate) fn append_history(&self, entry: Value) -> DbResult<()> {
        let mut lines = self.lock()?;
        let path = self.history_path();
        let line = validated_line(&entry, MAX_HISTORY_ENTRY_BYTES)?;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(err)?;
        file.write_all(format!("{line}\n").as_bytes())
            .map_err(err)?;
        file.flush().map_err(err)?;
        drop(file);
        let count = match *lines {
            Some(count) => count + 1,
            None => read_history(&path)?.len(),
        };
        let size = std::fs::metadata(&path).map_err(err)?.len();
        *lines = Some(if count > MAX_HISTORY_ENTRIES || size > MAX_HISTORY_BYTES {
            compact_history(&path)?
        } else {
            count
        });
        Ok(())
    }
    pub(crate) fn delete_history(&self, ids: &[String]) -> DbResult<()> {
        let mut lines = self.lock()?;
        let path = self.history_path();
        let mut entries = read_history(&path)?;
        entries.retain(|entry| !ids.iter().any(|id| entry_id(entry) == Some(id)));
        write_history(&path, &entries)?;
        *lines = Some(entries.len());
        Ok(())
    }
    pub(crate) fn clear_history(&self) -> DbResult<()> {
        let mut lines = self.lock()?;
        match std::fs::remove_file(self.history_path()) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(err(e)),
        }
        *lines = Some(0);
        Ok(())
    }
    pub(crate) fn list_items(&self, kind: LibraryKind) -> DbResult<Vec<Value>> {
        let _guard = self.lock()?;
        read_items(&self.library_path(kind))
    }
    /// Inserts or replaces items by id, keeping the order of existing items.
    pub(crate) fn save_items(&self, kind: LibraryKind, items: Vec<Value>) -> DbResult<()> {
        let _guard = self.lock()?;
        let path = self.library_path(kind);
        let mut stored = read_items(&path)?;
        for item in items {
            validated_line(&item, MAX_LIBRARY_ITEM_BYTES)?;
            let id = entry_id(&item).map(str::to_owned);
            match stored.iter_mut().find(|old| entry_id(old) == id.as_deref()) {
                Some(old) => *old = item,
                None => stored.push(item),
            }
        }
        if stored.len() > MAX_LIBRARY_ITEMS {
            return Err(format!(
                "The library is limited to {MAX_LIBRARY_ITEMS} items. Delete some first."
            ));
        }
        write_items(&path, &stored)
    }
    pub(crate) fn delete_items(&self, kind: LibraryKind, ids: &[String]) -> DbResult<()> {
        let _guard = self.lock()?;
        let path = self.library_path(kind);
        let mut stored = read_items(&path)?;
        stored.retain(|item| !ids.iter().any(|id| entry_id(item) == Some(id)));
        write_items(&path, &stored)
    }
}

fn entry_id(value: &Value) -> Option<&str> {
    value.get("id").and_then(Value::as_str)
}
/// Entries must be objects with a short, non-empty string id.
fn validated_line(value: &Value, max_bytes: usize) -> DbResult<String> {
    if !value.is_object() {
        return Err("Library entries must be objects".into());
    }
    match entry_id(value) {
        Some(id) if !id.is_empty() && id.len() <= 128 => {}
        _ => return Err("Library entries need an id".into()),
    }
    let line = serde_json::to_string(value).map_err(err)?;
    if line.len() > max_bytes {
        return Err(format!(
            "This entry is too large to store ({} KB max)",
            max_bytes / 1024
        ));
    }
    Ok(line)
}
/// Reads history, skipping lines that do not parse (such as a write cut short by a crash).
fn read_history(path: &Path) -> DbResult<Vec<Value>> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(err(e)),
    };
    Ok(text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|value| value.is_object() && entry_id(value).is_some())
        .collect())
}
fn atomic_write(path: &Path, bytes: &[u8]) -> DbResult<()> {
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, bytes).map_err(err)?;
    std::fs::rename(&temp, path).map_err(err)
}
fn write_history(path: &Path, entries: &[Value]) -> DbResult<()> {
    let mut text = String::new();
    for entry in entries {
        text.push_str(&serde_json::to_string(entry).map_err(err)?);
        text.push('\n');
    }
    atomic_write(path, text.as_bytes())
}
/// Keeps the newest entries within the caps, leaving headroom so compaction is rare.
fn compact_history(path: &Path) -> DbResult<usize> {
    let entries = read_history(path)?;
    let budget = (MAX_HISTORY_BYTES as usize) * 3 / 4;
    let max_entries = MAX_HISTORY_ENTRIES * 9 / 10;
    let mut kept = Vec::new();
    let mut size = 0;
    for entry in entries.into_iter().rev() {
        let length = serde_json::to_string(&entry).map_err(err)?.len() + 1;
        if kept.len() >= max_entries || size + length > budget {
            break;
        }
        size += length;
        kept.push(entry);
    }
    kept.reverse();
    write_history(path, &kept)?;
    Ok(kept.len())
}
fn read_items(path: &Path) -> DbResult<Vec<Value>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let items: Vec<Value> = serde_json::from_slice(&bytes)
                .map_err(|e| format!("{} is damaged: {e}", path.display()))?;
            Ok(items
                .into_iter()
                .filter(|item| item.is_object() && entry_id(item).is_some())
                .collect())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(err(e)),
    }
}
fn write_items(path: &Path, items: &[Value]) -> DbResult<()> {
    let bytes = serde_json::to_vec(items).map_err(err)?;
    if bytes.len() > MAX_LIBRARY_BYTES {
        return Err("The library is too large to save. Delete some items first.".into());
    }
    atomic_write(path, &bytes)
}

fn changed(app: &tauri::AppHandle, payload: Value) {
    // Windows that miss the event still see the change the next time they load.
    let _ = app.emit(CHANGE_EVENT, payload);
}
#[tauri::command]
pub(crate) async fn dbde_history_list(library: State<'_, QueryLibrary>) -> DbResult<Vec<Value>> {
    library.list_history()
}
#[tauri::command]
pub(crate) async fn dbde_history_append(
    entry: Value,
    app: tauri::AppHandle,
    library: State<'_, QueryLibrary>,
) -> DbResult<()> {
    library.append_history(entry.clone())?;
    changed(
        &app,
        json!({ "kind": "history", "op": "append", "entry": entry }),
    );
    Ok(())
}
#[tauri::command]
pub(crate) async fn dbde_history_delete(
    ids: Vec<String>,
    app: tauri::AppHandle,
    library: State<'_, QueryLibrary>,
) -> DbResult<()> {
    library.delete_history(&ids)?;
    changed(&app, json!({ "kind": "history", "op": "reload" }));
    Ok(())
}
#[tauri::command]
pub(crate) async fn dbde_history_clear(
    app: tauri::AppHandle,
    library: State<'_, QueryLibrary>,
) -> DbResult<()> {
    library.clear_history()?;
    changed(&app, json!({ "kind": "history", "op": "reload" }));
    Ok(())
}
#[tauri::command]
pub(crate) async fn dbde_library_list(
    kind: LibraryKind,
    library: State<'_, QueryLibrary>,
) -> DbResult<Vec<Value>> {
    library.list_items(kind)
}
#[tauri::command]
pub(crate) async fn dbde_library_save(
    kind: LibraryKind,
    items: Vec<Value>,
    app: tauri::AppHandle,
    library: State<'_, QueryLibrary>,
) -> DbResult<()> {
    library.save_items(kind, items)?;
    changed(&app, json!({ "kind": kind, "op": "reload" }));
    Ok(())
}
#[tauri::command]
pub(crate) async fn dbde_library_delete(
    kind: LibraryKind,
    ids: Vec<String>,
    app: tauri::AppHandle,
    library: State<'_, QueryLibrary>,
) -> DbResult<()> {
    library.delete_items(kind, &ids)?;
    changed(&app, json!({ "kind": kind, "op": "reload" }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp_library() -> (QueryLibrary, PathBuf) {
        let directory = std::env::temp_dir().join(format!("dbde-library-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        (QueryLibrary::new(directory.clone()), directory)
    }
    fn entry(id: &str, sql: &str) -> Value {
        json!({ "id": id, "sql": sql, "status": "success" })
    }

    #[test]
    fn history_appends_lists_deletes_and_clears() {
        let (library, directory) = temp_library();
        assert!(library.list_history().unwrap().is_empty());
        library.append_history(entry("a", "SELECT 1")).unwrap();
        library.append_history(entry("b", "SELECT 2")).unwrap();
        let ids: Vec<_> = library
            .list_history()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(ids, ["a", "b"]);
        library.delete_history(&["a".into()]).unwrap();
        assert_eq!(
            library.list_history().unwrap(),
            vec![entry("b", "SELECT 2")]
        );
        library.clear_history().unwrap();
        assert!(library.list_history().unwrap().is_empty());
        library.clear_history().unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn history_skips_damaged_lines_and_rejects_invalid_entries() {
        let (library, directory) = temp_library();
        std::fs::write(
            library.history_path(),
            "{\"id\":\"ok\"}\n{\"id\":\"cut sho\n[1]\n",
        )
        .unwrap();
        library.append_history(entry("next", "SELECT 1")).unwrap();
        let list = library.list_history().unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[1]["id"], "next");
        assert!(library.append_history(json!([1])).is_err());
        assert!(library.append_history(json!({ "sql": "x" })).is_err());
        let huge = "x".repeat(MAX_HISTORY_ENTRY_BYTES + 1);
        assert!(library.append_history(entry("big", &huge)).is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn history_compacts_to_the_newest_entries() {
        let (library, directory) = temp_library();
        for index in 0..MAX_HISTORY_ENTRIES + 1 {
            library
                .append_history(entry(&index.to_string(), "SELECT 1"))
                .unwrap();
        }
        let list = library.list_history().unwrap();
        assert!(list.len() <= MAX_HISTORY_ENTRIES);
        assert_eq!(list.last().unwrap()["id"], MAX_HISTORY_ENTRIES.to_string());
        assert!(!directory.join("query_history.tmp").exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn concurrent_writers_do_not_lose_entries() {
        let (library, directory) = temp_library();
        let library = std::sync::Arc::new(library);
        let handles: Vec<_> = (0..8)
            .map(|thread| {
                let library = library.clone();
                std::thread::spawn(move || {
                    for index in 0..25 {
                        library
                            .append_history(entry(&format!("{thread}-{index}"), "SELECT 1"))
                            .unwrap();
                        library
                            .save_items(
                                LibraryKind::SavedQueries,
                                vec![json!({ "id": format!("{thread}-{index}") })],
                            )
                            .unwrap();
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(library.list_history().unwrap().len(), 200);
        assert_eq!(
            library.list_items(LibraryKind::SavedQueries).unwrap().len(),
            200
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn library_upserts_in_place_and_deletes_by_id() {
        let (library, directory) = temp_library();
        let kind = LibraryKind::Snippets;
        assert!(library.list_items(kind).unwrap().is_empty());
        library
            .save_items(
                kind,
                vec![json!({ "id": "a", "v": 1 }), json!({ "id": "b", "v": 1 })],
            )
            .unwrap();
        library
            .save_items(kind, vec![json!({ "id": "a", "v": 2 })])
            .unwrap();
        assert_eq!(
            library.list_items(kind).unwrap(),
            vec![json!({ "id": "a", "v": 2 }), json!({ "id": "b", "v": 1 })]
        );
        assert!(library
            .list_items(LibraryKind::SavedQueries)
            .unwrap()
            .is_empty());
        library.delete_items(kind, &["a".into()]).unwrap();
        assert_eq!(
            library.list_items(kind).unwrap(),
            vec![json!({ "id": "b", "v": 1 })]
        );
        assert!(library.save_items(kind, vec![json!({ "id": "" })]).is_err());
        assert!(!directory.join("snippets.tmp").exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn damaged_library_file_is_reported_not_overwritten() {
        let (library, directory) = temp_library();
        let path = directory.join("saved_queries.json");
        std::fs::write(&path, "not json").unwrap();
        assert!(library.list_items(LibraryKind::SavedQueries).is_err());
        assert!(library
            .save_items(LibraryKind::SavedQueries, vec![json!({ "id": "a" })])
            .is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "not json");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn library_kind_uses_snake_case_names() {
        assert_eq!(
            serde_json::from_value::<LibraryKind>(json!("saved_queries")).unwrap(),
            LibraryKind::SavedQueries
        );
        assert!(serde_json::from_value::<LibraryKind>(json!("../etc")).is_err());
    }
}
