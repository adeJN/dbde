// Import wizard backend. The file is chosen in the native open dialog here, so the
// webview only ever holds an opaque import ID, never a path. Files are parsed on a
// blocking thread and streamed to the database in batches of bound, multi-row
// statements inside one transaction: everything is imported, or nothing is.
use super::*;
use futures_util::future::{BoxFuture, FutureExt, TryFutureExt};
use rows::{qualified, quote};
use serde::de::{self, Deserializer as _, SeqAccess, Visitor};
use std::{
    collections::HashSet,
    fs::File,
    io::{BufRead, BufReader, Read},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::ipc::Channel;
use tauri_plugin_dialog::DialogExt;

const MAX_FILE_BYTES: u64 = 512 * 1024 * 1024;
// calamine reads a whole sheet into memory, so workbooks get a lower limit.
const MAX_EXCEL_BYTES: u64 = 100 * 1024 * 1024;
const MAX_IMPORT_ROWS: u64 = 5_000_000;
const PREVIEW_ROWS: usize = 50;
const PREVIEW_TEXT: usize = 500;
const MAX_SOURCE_COLUMNS: usize = 4096;
const MAX_VALUE_BYTES: usize = 4 * 1024 * 1024;
// Keeps each statement well below MySQL's max_allowed_packet (16 MB on older servers).
const MAX_BATCH_BYTES: usize = 4 * 1024 * 1024;
const MAX_ERRORS: usize = 200;
const MAX_STAGED: usize = 16;
const CHUNK_ROWS: usize = 500;
// A statement that runs longer than the connection's query timeout (at least five
// minutes) stops the import.
const MIN_STALL_SECS: u64 = 300;
const CANCELLED: &str = "Import cancelled.";
const SAVEPOINT: &str = "dbde_import";
const EXTENSIONS: [&str; 12] = [
    "csv", "tsv", "tab", "txt", "json", "jsonl", "ndjson", "xlsx", "xlsm", "xls", "xlsb", "ods",
];

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ImportFormat {
    Csv,
    Tsv,
    /// An array of objects.
    Json,
    /// One object per line (JSON Lines / NDJSON).
    Jsonl,
    /// .xlsx, .xlsm, .xls, .xlsb or .ods.
    Excel,
}
fn yes() -> bool {
    true
}
fn comma() -> String {
    ",".into()
}
fn double_quote() -> String {
    "\"".into()
}
fn default_batch() -> u32 {
    500
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ParseOptions {
    format: ImportFormat,
    #[serde(default = "comma")]
    delimiter: String,
    #[serde(default = "double_quote")]
    quote: String,
    #[serde(default = "yes")]
    header: bool,
    /// A CSV, TSV or Excel text cell equal to this becomes NULL. Empty by default, so
    /// empty cells are NULL; with "NULL" or "\N" empty cells stay empty strings.
    #[serde(default)]
    null_text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sheet: Option<String>,
}
impl ParseOptions {
    fn new(format: ImportFormat) -> Self {
        Self {
            format,
            delimiter: if format == ImportFormat::Tsv {
                "\t".into()
            } else {
                comma()
            },
            quote: double_quote(),
            header: true,
            null_text: String::new(),
            sheet: None,
        }
    }
}
#[derive(Clone)]
struct Parse {
    format: ImportFormat,
    delimiter: u8,
    quote: u8,
    header: bool,
    null_text: String,
    sheet: Option<String>,
}
fn ascii_char(value: &str, what: &str) -> DbResult<u8> {
    match value.as_bytes() {
        [b] if b.is_ascii() && !matches!(b, b'\r' | b'\n' | b'\0') => Ok(*b),
        _ => Err(format!(
            "The {what} must be a single ASCII character other than a line break."
        )),
    }
}
impl ParseOptions {
    fn plan(&self) -> DbResult<Parse> {
        let delimiter = if self.format == ImportFormat::Tsv {
            b'\t'
        } else {
            ascii_char(&self.delimiter, "delimiter")?
        };
        let quote = ascii_char(&self.quote, "quote character")?;
        if quote == delimiter {
            return Err("The quote character must differ from the delimiter.".into());
        }
        if self.null_text.chars().count() > 64 || self.null_text.contains(['\r', '\n', '\0']) {
            return Err("The NULL marker must be at most 64 characters on one line.".into());
        }
        if self
            .sheet
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.chars().count() > 255 || s.contains('\0'))
        {
            return Err("Invalid sheet name".into());
        }
        Ok(Parse {
            format: self.format,
            delimiter,
            quote,
            header: self.header,
            null_text: self.null_text.clone(),
            sheet: self.sheet.clone(),
        })
    }
}

/// One source value. Numbers, dates and times are text the database converts.
#[derive(Clone, Debug, PartialEq)]
enum Cell {
    Null,
    Text(String),
    Bool(bool),
}
impl Cell {
    fn text(text: String, null_text: &str) -> Self {
        if text == null_text {
            Cell::Null
        } else {
            Cell::Text(text)
        }
    }
    // JSON null is NULL; strings are kept exactly; nested values become JSON text.
    fn from_json(value: &Value) -> Self {
        match value {
            Value::Null => Cell::Null,
            Value::String(text) => Cell::Text(text.clone()),
            Value::Bool(b) => Cell::Bool(*b),
            Value::Number(n) => Cell::Text(n.to_string()),
            other => Cell::Text(other.to_string()),
        }
    }
    fn preview(&self) -> Option<String> {
        match self {
            Cell::Null => None,
            Cell::Bool(b) => Some(b.to_string()),
            Cell::Text(text) => Some(match text.char_indices().nth(PREVIEW_TEXT) {
                Some((end, _)) => format!("{}…", &text[..end]),
                None => text.clone(),
            }),
        }
    }
    fn bind(self, driver: &Driver) -> Option<String> {
        match self {
            Cell::Null => None,
            Cell::Text(text) => Some(text),
            Cell::Bool(b) => Some(match (driver, b) {
                (Driver::Postgres, true) => "true".into(),
                (Driver::Postgres, false) => "false".into(),
                (_, true) => "1".into(),
                (_, false) => "0".into(),
            }),
        }
    }
}
enum Record {
    Fields(Vec<Cell>),
    Object(serde_json::Map<String, Value>),
}
enum Item {
    Header(Vec<String>),
    /// Exact number of data rows, when the reader knows it up front (Excel).
    Total(u64),
    Row(u64, Record),
    /// A row that could not be parsed, such as invalid UTF-8 or a non-object JSON line.
    Bad(u64, String),
}
#[derive(PartialEq)]
enum Flow {
    More,
    Stop,
}
type Each<'a> = &'a mut dyn FnMut(Item) -> Flow;

fn open_text(path: &Path) -> DbResult<BufReader<File>> {
    let mut reader = BufReader::with_capacity(256 * 1024, File::open(path).map_err(err)?);
    let start = reader.fill_buf().map_err(err)?;
    if start.starts_with(&[0xFF, 0xFE]) || start.starts_with(&[0xFE, 0xFF]) {
        return Err(
            "This file is UTF-16 encoded. Save it as UTF-8 (with or without BOM) and try again."
                .into(),
        );
    }
    if start.starts_with(b"\xEF\xBB\xBF") {
        reader.consume(3);
    }
    Ok(reader)
}
fn too_wide() -> String {
    format!("Rows may have at most {MAX_SOURCE_COLUMNS} columns. Check the delimiter.")
}
fn read_delimited(reader: impl Read, parse: &Parse, each: Each) -> DbResult<()> {
    let mut csv = csv::ReaderBuilder::new()
        .delimiter(parse.delimiter)
        .quote(parse.quote)
        .has_headers(false)
        .flexible(true)
        .from_reader(reader);
    let mut record = csv::ByteRecord::new();
    let mut header = parse.header;
    let mut row = 0u64;
    loop {
        match csv.read_byte_record(&mut record) {
            Ok(true) => {}
            Ok(false) => return Ok(()),
            Err(e) => return Err(format!("Could not read the file: {e}")),
        }
        if record.len() > MAX_SOURCE_COLUMNS {
            return Err(too_wide());
        }
        let item = if header {
            header = false;
            Item::Header(
                record
                    .iter()
                    .map(|field| {
                        String::from_utf8(field.to_vec()).map_err(|_| {
                            "The header row is not valid UTF-8. Save the file as UTF-8.".to_string()
                        })
                    })
                    .collect::<DbResult<_>>()?,
            )
        } else {
            row += 1;
            match record
                .iter()
                .map(|field| {
                    std::str::from_utf8(field).map(|text| Cell::text(text.into(), &parse.null_text))
                })
                .collect::<Result<Vec<_>, _>>()
            {
                Ok(cells) => Item::Row(row, Record::Fields(cells)),
                Err(_) => Item::Bad(row, "Not valid UTF-8. Save the file as UTF-8.".into()),
            }
        };
        if each(item) == Flow::Stop {
            return Ok(());
        }
    }
}
fn read_json_lines(mut reader: impl BufRead, each: Each) -> DbResult<()> {
    let mut line = Vec::new();
    let mut row = 0u64;
    loop {
        line.clear();
        if reader.read_until(b'\n', &mut line).map_err(err)? == 0 {
            return Ok(());
        }
        let text = line.trim_ascii();
        if text.is_empty() {
            continue;
        }
        row += 1;
        let item = match serde_json::from_slice::<Value>(text) {
            Ok(Value::Object(map)) => Item::Row(row, Record::Object(map)),
            Ok(_) => Item::Bad(row, "Not a JSON object.".into()),
            Err(e) => Item::Bad(row, format!("Invalid JSON: {e}.")),
        };
        if each(item) == Flow::Stop {
            return Ok(());
        }
    }
}
// Visits the array's elements one at a time, so the file is never held in memory.
struct Elements<'a> {
    each: Each<'a>,
    row: u64,
    stopped: bool,
}
impl<'de> Visitor<'de> for &mut Elements<'_> {
    type Value = ();
    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        f.write_str("an array of objects")
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<(), A::Error> {
        while let Some(value) = seq.next_element::<Value>()? {
            self.row += 1;
            let item = match value {
                Value::Object(map) => Item::Row(self.row, Record::Object(map)),
                _ => Item::Bad(self.row, "Not a JSON object.".into()),
            };
            if (self.each)(item) == Flow::Stop {
                self.stopped = true;
                return Err(de::Error::custom("stopped"));
            }
        }
        Ok(())
    }
}
fn read_json_array(reader: impl Read, each: Each) -> DbResult<()> {
    let mut json = serde_json::Deserializer::from_reader(reader);
    let mut elements = Elements {
        each,
        row: 0,
        stopped: false,
    };
    match (&mut json).deserialize_seq(&mut elements) {
        Ok(()) => json
            .end()
            .map_err(|e| format!("Unexpected content after the JSON array: {e}")),
        Err(_) if elements.stopped => Ok(()),
        Err(e) => Err(format!(
            "The file is not a JSON array of objects ({e}). For one object per line, choose JSON Lines."
        )),
    }
}
fn excel_error(error: impl std::fmt::Display) -> String {
    format!("Could not read the workbook: {error}")
}
fn number_text(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}
// Excel stores dates as day numbers; they become ISO text the database parses.
fn excel_date_text(value: &calamine::ExcelDateTime) -> String {
    if value.is_duration() {
        let seconds = (value.as_f64() * 86_400.0).round() as i64;
        return format!(
            "{:02}:{:02}:{:02}",
            seconds / 3600,
            seconds % 3600 / 60,
            seconds % 60
        );
    }
    let (year, month, day, hour, minute, second, milli) = value.to_ymd_hms_milli();
    let time = if milli > 0 {
        format!("{hour:02}:{minute:02}:{second:02}.{milli:03}")
    } else {
        format!("{hour:02}:{minute:02}:{second:02}")
    };
    if value.as_f64() < 1.0 {
        time
    } else if (hour, minute, second, milli) == (0, 0, 0, 0) {
        format!("{year:04}-{month:02}-{day:02}")
    } else {
        format!("{year:04}-{month:02}-{day:02} {time}")
    }
}
fn excel_cell(cell: &calamine::Data, null_text: &str) -> Cell {
    use calamine::Data;
    match cell {
        Data::Empty => Cell::Null,
        Data::String(text) => Cell::text(text.clone(), null_text),
        Data::Int(i) => Cell::Text(i.to_string()),
        Data::Float(f) => Cell::Text(number_text(*f)),
        Data::Bool(b) => Cell::Bool(*b),
        Data::DateTime(d) => Cell::Text(excel_date_text(d)),
        Data::DateTimeIso(text) | Data::DurationIso(text) => Cell::Text(text.clone()),
        Data::Error(e) => Cell::Text(e.to_string()),
    }
}
fn excel_sheets(path: &Path) -> DbResult<Vec<String>> {
    use calamine::Reader;
    Ok(calamine::open_workbook_auto(path)
        .map_err(excel_error)?
        .sheet_names())
}
fn read_excel(path: &Path, parse: &Parse, each: Each) -> DbResult<()> {
    use calamine::{Data, Reader};
    let mut workbook = calamine::open_workbook_auto(path).map_err(excel_error)?;
    let names = workbook.sheet_names();
    let sheet = match &parse.sheet {
        Some(sheet) => names
            .iter()
            .find(|name| *name == sheet)
            .cloned()
            .ok_or_else(|| format!("The workbook has no sheet named {sheet}."))?,
        None => names
            .first()
            .cloned()
            .ok_or("The workbook has no sheets.")?,
    };
    let range = workbook.worksheet_range(&sheet).map_err(excel_error)?;
    if range.width() > MAX_SOURCE_COLUMNS {
        return Err(too_wide());
    }
    let mut header = parse.header;
    let data_rows = (range.height() as u64).saturating_sub(u64::from(parse.header));
    if each(Item::Total(data_rows)) == Flow::Stop {
        return Ok(());
    }
    let mut row = 0u64;
    for cells in range.rows() {
        let item = if header {
            header = false;
            Item::Header(
                cells
                    .iter()
                    .map(|cell| match excel_cell(cell, "") {
                        Cell::Null => String::new(),
                        Cell::Bool(b) => b.to_string(),
                        Cell::Text(text) => text,
                    })
                    .collect(),
            )
        } else {
            row += 1;
            if cells.iter().all(|cell| matches!(cell, Data::Empty)) {
                continue;
            }
            Item::Row(
                row,
                Record::Fields(
                    cells
                        .iter()
                        .map(|cell| excel_cell(cell, &parse.null_text))
                        .collect(),
                ),
            )
        };
        if each(item) == Flow::Stop {
            break;
        }
    }
    Ok(())
}
fn read_file(path: &Path, parse: &Parse, each: Each) -> DbResult<()> {
    match parse.format {
        ImportFormat::Csv | ImportFormat::Tsv => read_delimited(open_text(path)?, parse, each),
        ImportFormat::Json => read_json_array(open_text(path)?, each),
        ImportFormat::Jsonl => read_json_lines(open_text(path)?, each),
        ImportFormat::Excel => read_excel(path, parse, each),
    }
}
/// Header names as the wizard shows them: blank names are numbered, duplicates suffixed.
fn source_names(raw: Vec<String>) -> Vec<String> {
    let mut seen = HashSet::new();
    raw.into_iter()
        .enumerate()
        .map(|(i, name)| {
            let name: String = name
                .trim()
                .chars()
                .filter(|c| !c.is_control())
                .take(256)
                .collect();
            let base = if name.is_empty() {
                format!("Column {}", i + 1)
            } else {
                name
            };
            let mut unique = base.clone();
            let mut n = 2;
            while !seen.insert(unique.to_lowercase()) {
                unique = format!("{base} ({n})");
                n += 1;
            }
            unique
        })
        .collect()
}
fn numbered(width: usize) -> Vec<String> {
    (1..=width).map(|i| format!("Column {i}")).collect()
}
fn is_json(format: ImportFormat) -> bool {
    matches!(format, ImportFormat::Json | ImportFormat::Jsonl)
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub(crate) struct RowIssue {
    row: u64,
    message: String,
}
#[derive(Debug)]
struct PreviewData {
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    issues: Vec<RowIssue>,
    estimated_rows: u64,
    exact: bool,
}
fn preview_file(path: &Path, size: u64, parse: &Parse) -> DbResult<PreviewData> {
    let mut header = None;
    let mut total = None;
    let mut records = Vec::new();
    let mut issues = Vec::new();
    let mut more = false;
    read_file(path, parse, &mut |item| {
        match item {
            Item::Header(names) => header = Some(source_names(names)),
            Item::Total(rows) => total = Some(rows),
            Item::Row(_, record) => records.push(record),
            Item::Bad(row, message) => issues.push(RowIssue { row, message }),
        }
        if records.len() + issues.len() > PREVIEW_ROWS {
            more = true;
            Flow::Stop
        } else {
            Flow::More
        }
    })?;
    let seen = (records.len() + issues.len()) as u64;
    if more {
        if records.len() > PREVIEW_ROWS {
            records.pop();
        } else {
            issues.pop();
        }
    }
    let columns = if is_json(parse.format) {
        let mut names: Vec<String> = Vec::new();
        let mut known = HashSet::new();
        for record in &records {
            if let Record::Object(map) = record {
                for key in map.keys() {
                    if names.len() < MAX_SOURCE_COLUMNS && known.insert(key.clone()) {
                        names.push(key.clone());
                    }
                }
            }
        }
        names
    } else {
        header.unwrap_or_else(|| {
            numbered(
                records
                    .iter()
                    .map(|r| match r {
                        Record::Fields(cells) => cells.len(),
                        Record::Object(_) => 0,
                    })
                    .max()
                    .unwrap_or(0),
            )
        })
    };
    let mut bytes = 0usize;
    let rows = records
        .iter()
        .map(|record| match record {
            Record::Fields(cells) => {
                bytes += cells
                    .iter()
                    .map(|c| match c {
                        Cell::Text(t) => t.len() + 1,
                        _ => 1,
                    })
                    .sum::<usize>()
                    + 1;
                (0..columns.len())
                    .map(|i| cells.get(i).and_then(Cell::preview))
                    .collect()
            }
            Record::Object(map) => {
                bytes += serde_json::to_string(map).map_or(0, |t| t.len()) + 2;
                columns
                    .iter()
                    .map(|key| map.get(key).and_then(|v| Cell::from_json(v).preview()))
                    .collect()
            }
        })
        .collect::<Vec<_>>();
    let (estimated_rows, exact) = match total {
        Some(total) => (total, true),
        None if !more => (seen, true),
        None => {
            let average = (bytes / records.len().max(1)).max(1) as u64;
            ((size / average).max(seen), false)
        }
    };
    Ok(PreviewData {
        columns,
        rows,
        issues,
        estimated_rows,
        exact,
    })
}
fn check_size(format: ImportFormat, size: u64) -> DbResult<()> {
    if size > MAX_FILE_BYTES {
        return Err(
            "Import files must not exceed 512 MB. Split the file and import it in parts.".into(),
        );
    }
    if format == ImportFormat::Excel && size > MAX_EXCEL_BYTES {
        return Err(
            "Excel workbooks must not exceed 100 MB. Save the sheet as CSV to import a larger file."
                .into(),
        );
    }
    Ok(())
}
fn detect_format(path: &Path) -> DbResult<ImportFormat> {
    let extension = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    Ok(match extension.as_str() {
        "tsv" | "tab" => ImportFormat::Tsv,
        "jsonl" | "ndjson" => ImportFormat::Jsonl,
        "xlsx" | "xlsm" | "xls" | "xlsb" | "ods" => ImportFormat::Excel,
        "json" | "txt" => {
            let mut start = Vec::new();
            open_text(path)?
                .take(64 * 1024)
                .read_to_end(&mut start)
                .map_err(err)?;
            let first = start.iter().find(|b| !b.is_ascii_whitespace()).copied();
            let line = start.split(|b| *b == b'\n').next().unwrap_or_default();
            match (extension.as_str(), first) {
                ("json", Some(b'{')) => ImportFormat::Jsonl,
                ("json", _) => ImportFormat::Json,
                _ if line.contains(&b'\t') && !line.contains(&b',') => ImportFormat::Tsv,
                _ => ImportFormat::Csv,
            }
        }
        _ => ImportFormat::Csv,
    })
}

struct StagedFile {
    path: PathBuf,
    name: String,
    size: u64,
    opened: Instant,
}
/// Files picked in the open dialog, keyed by an opaque ID, and the running imports.
#[derive(Default)]
pub(crate) struct Imports {
    files: std::sync::Mutex<HashMap<String, StagedFile>>,
    running: std::sync::Mutex<HashMap<String, Arc<AtomicBool>>>,
}
struct Running<'a> {
    imports: &'a Imports,
    id: String,
    flag: Arc<AtomicBool>,
}
impl Drop for Running<'_> {
    fn drop(&mut self) {
        if let Ok(mut running) = self.imports.running.lock() {
            running.remove(&self.id);
        }
    }
}
fn check_id(id: &str) -> DbResult<()> {
    if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
        Err("Invalid import ID".into())
    } else {
        Ok(())
    }
}
impl Imports {
    pub(crate) fn is_busy(&self) -> DbResult<bool> {
        Ok(!self.running.lock().map_err(err)?.is_empty())
    }

    fn stage(&self, path: PathBuf, size: u64) -> DbResult<String> {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let mut files = self.files.lock().map_err(err)?;
        while files.len() >= MAX_STAGED {
            let Some(oldest) = files
                .iter()
                .min_by_key(|(_, file)| file.opened)
                .map(|(id, _)| id.clone())
            else {
                break;
            };
            files.remove(&oldest);
        }
        files.insert(
            id.clone(),
            StagedFile {
                path,
                name,
                size,
                opened: Instant::now(),
            },
        );
        Ok(id)
    }
    fn file(&self, id: &str) -> DbResult<(PathBuf, String, u64)> {
        check_id(id)?;
        let files = self.files.lock().map_err(err)?;
        let file = files
            .get(id)
            .ok_or("This import file is no longer open. Choose the file again.")?;
        Ok((file.path.clone(), file.name.clone(), file.size))
    }
    fn forget(&self, id: &str) {
        if let Ok(mut files) = self.files.lock() {
            files.remove(id);
        }
    }
    fn start(&self, id: &str) -> DbResult<Running<'_>> {
        check_id(id)?;
        let flag = Arc::new(AtomicBool::new(false));
        let mut running = self.running.lock().map_err(err)?;
        if running.contains_key(id) {
            return Err("This import is already running".into());
        }
        running.insert(id.into(), flag.clone());
        Ok(Running {
            imports: self,
            id: id.into(),
            flag,
        })
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct ImportPreview {
    import_id: String,
    file_name: String,
    file_size: u64,
    /// The options this preview was parsed with (format detected, first sheet chosen).
    options: ParseOptions,
    sheets: Vec<String>,
    columns: Vec<String>,
    rows: Vec<Vec<Option<String>>>,
    row_errors: Vec<RowIssue>,
    estimated_rows: u64,
    exact_rows: bool,
}
async fn build_preview(
    import_id: String,
    file: (PathBuf, String, u64),
    options: Option<ParseOptions>,
) -> DbResult<ImportPreview> {
    let (path, file_name, file_size) = file;
    tokio::task::spawn_blocking(move || {
        let mut options = match options {
            Some(options) => options,
            None => ParseOptions::new(detect_format(&path)?),
        };
        check_size(options.format, file_size)?;
        options.plan()?;
        let sheets = if options.format == ImportFormat::Excel {
            let sheets = excel_sheets(&path)?;
            if options.sheet.is_none() {
                options.sheet = sheets.first().cloned();
            }
            sheets
        } else {
            options.sheet = None;
            Vec::new()
        };
        let data = preview_file(&path, file_size, &options.plan()?)?;
        Ok(ImportPreview {
            import_id,
            file_name,
            file_size,
            options,
            sheets,
            columns: data.columns,
            rows: data.rows,
            row_errors: data.issues,
            estimated_rows: data.estimated_rows,
            exact_rows: data.exact,
        })
    })
    .await
    .map_err(err)?
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct TargetColumn {
    name: String,
    data_type: String,
    nullable: bool,
    has_default: bool,
    generated: bool,
}
#[derive(Debug, Serialize)]
pub(crate) struct ImportTarget {
    columns: Vec<TargetColumn>,
    primary_keys: Vec<String>,
    /// False for MySQL tables whose engine cannot roll back (such as MyISAM).
    transactional: bool,
}
// SHOW output is text, binary or numeric depending on the column and server version.
fn my_text(row: &sqlx::mysql::MySqlRow, i: usize) -> DbResult<Option<String>> {
    if let Ok(text) = row.try_get::<Option<String>, _>(i) {
        return Ok(text);
    }
    if let Ok(number) = row.try_get::<Option<i64>, _>(i) {
        return Ok(number.map(|n| n.to_string()));
    }
    if let Ok(number) = row.try_get::<Option<u64>, _>(i) {
        return Ok(number.map(|n| n.to_string()));
    }
    row.try_get::<Option<Vec<u8>>, _>(i)
        .map(|bytes| bytes.map(|b| String::from_utf8_lossy(&b).into_owned()))
        .map_err(err)
}
async fn target_info(conn: &Connection, table: &TableInfo) -> DbResult<ImportTarget> {
    if table.kind != "table" {
        return Err("Data can only be imported into a table.".into());
    }
    let driver = &conn.config.driver;
    let target = qualified(table, driver);
    let (columns, primary_keys, transactional) = match &conn.pool {
        Pool::Pg(p) => {
            let rows = sqlx::query("SELECT a.attname::text, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull, a.atthasdef OR a.attidentity <> '', a.attgenerated <> '' FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum")
                .bind(&table.schema).bind(&table.name).fetch_all(p).await.map_err(err)?;
            let columns = rows
                .iter()
                .map(|r| {
                    Ok(TargetColumn {
                        name: r.try_get(0).map_err(err)?,
                        data_type: r.try_get(1).map_err(err)?,
                        nullable: r.try_get(2).map_err(err)?,
                        has_default: r.try_get(3).map_err(err)?,
                        generated: r.try_get(4).map_err(err)?,
                    })
                })
                .collect::<DbResult<Vec<_>>>()?;
            (columns, rows::primary_keys(conn, table).await?, true)
        }
        // SHOW works for TEMPORARY tables too, which information_schema does not list.
        Pool::My(p) => {
            if table.schema != conn.config.database {
                return Err("Table does not belong to the selected database".into());
            }
            let sql = format!("SHOW FULL COLUMNS FROM {target}");
            let rows = sqlx::query(&sql).fetch_all(p).await.map_err(err)?;
            let mut columns = Vec::new();
            for row in &rows {
                let extra = my_text(row, 6)?.unwrap_or_default().to_uppercase();
                columns.push(TargetColumn {
                    name: my_text(row, 0)?.unwrap_or_default(),
                    data_type: my_text(row, 1)?.unwrap_or_default(),
                    nullable: my_text(row, 3)?.as_deref() == Some("YES"),
                    has_default: my_text(row, 5)?.is_some()
                        || extra.contains("AUTO_INCREMENT")
                        || extra.contains("DEFAULT_GENERATED"),
                    generated: extra.contains("VIRTUAL")
                        || extra.contains("STORED")
                        || extra.contains("PERSISTENT"),
                });
            }
            let sql = format!("SHOW INDEX FROM {target}");
            let mut keys = Vec::new();
            for row in sqlx::query(&sql).fetch_all(p).await.map_err(err)? {
                if my_text(&row, 2)?.as_deref() == Some("PRIMARY") {
                    let seq: u64 = my_text(&row, 3)?.and_then(|s| s.parse().ok()).unwrap_or(0);
                    keys.push((seq, my_text(&row, 4)?.unwrap_or_default()));
                }
            }
            keys.sort();
            let sql = format!("SHOW CREATE TABLE {target}");
            let ddl = sqlx::query(&sql)
                .fetch_one(p)
                .await
                .map_err(err)
                .and_then(|row| my_text(&row, 1))?
                .unwrap_or_default();
            let engine = ddl
                .rsplit_once("ENGINE=")
                .map(|(_, rest)| rest.split_whitespace().next().unwrap_or_default())
                .unwrap_or_default();
            (
                columns,
                keys.into_iter().map(|(_, name)| name).collect(),
                engine.eq_ignore_ascii_case("InnoDB"),
            )
        }
        Pool::Lite(p) => {
            if !table.schema.is_empty() && table.schema != "main" {
                return Err("Only the main SQLite database supports imports".into());
            }
            let rows = sqlx::query("SELECT name, type, \"notnull\", dflt_value IS NOT NULL, hidden, pk FROM pragma_table_xinfo(?)")
                .bind(&table.name).fetch_all(p).await.map_err(err)?;
            let key_count = rows
                .iter()
                .filter(|r| r.try_get::<i64, _>(5).unwrap_or(0) > 0)
                .count();
            let columns = rows
                .iter()
                .map(|r| {
                    let data_type: String = r.try_get(1).map_err(err)?;
                    // A lone INTEGER PRIMARY KEY is the rowid, which SQLite assigns.
                    let rowid = key_count == 1
                        && r.try_get::<i64, _>(5).map_err(err)? > 0
                        && data_type.eq_ignore_ascii_case("INTEGER");
                    Ok(TargetColumn {
                        name: r.try_get(0).map_err(err)?,
                        nullable: r.try_get::<i64, _>(2).map_err(err)? == 0,
                        has_default: rowid || r.try_get::<i64, _>(3).map_err(err)? != 0,
                        generated: r.try_get::<i64, _>(4).map_err(err)? != 0,
                        data_type,
                    })
                })
                .collect::<DbResult<Vec<_>>>()?;
            (columns, rows::primary_keys(conn, table).await?, true)
        }
    };
    if columns.is_empty() {
        return Err(format!("No columns found for {}.", table.name));
    }
    Ok(ImportTarget {
        columns,
        primary_keys,
        transactional,
    })
}
async fn row_count(conn: &Connection, table: &TableInfo) -> DbResult<u64> {
    if table.kind != "table" {
        return Err("Data can only be imported into a table.".into());
    }
    let sql = format!(
        "SELECT COUNT(*) FROM {}",
        qualified(table, &conn.config.driver)
    );
    let count: i64 = match &conn.pool {
        Pool::Pg(p) => sqlx::query_scalar(&sql).fetch_one(p).await,
        Pool::My(p) => sqlx::query_scalar(&sql).fetch_one(p).await,
        Pool::Lite(p) => sqlx::query_scalar(&sql).fetch_one(p).await,
    }
    .map_err(err)?;
    Ok(count.max(0) as u64)
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ImportMode {
    /// INSERT every row.
    Append,
    /// UPDATE rows matched by primary key; rows not found are skipped.
    Update,
    /// INSERT, or UPDATE when the primary key exists.
    Upsert,
    /// DELETE every existing row, then INSERT.
    Copy,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ColumnMapping {
    source: String,
    target: String,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ImportRequest {
    options: ParseOptions,
    mapping: Vec<ColumnMapping>,
    mode: ImportMode,
    /// Skip rows the database rejects (each batch runs in a savepoint) instead of
    /// rolling back the whole import.
    #[serde(default)]
    continue_on_error: bool,
    #[serde(default = "default_batch")]
    batch_rows: u32,
}
#[derive(Debug, Default, Serialize)]
pub(crate) struct ImportSummary {
    /// Data rows read from the file, including rejected ones.
    rows: u64,
    inserted: u64,
    updated: u64,
    /// Update mode rows with no matching key, and upserts that changed nothing.
    skipped: u64,
    failed: u64,
    /// Rows deleted first in Copy mode.
    deleted: u64,
    /// The first rejected or skipped rows, by 1-based data row number.
    errors: Vec<RowIssue>,
    /// Issues beyond those listed in `errors`.
    more_errors: u64,
}
#[derive(Clone, Serialize)]
pub(crate) struct ImportProgress {
    rows: u64,
}
pub(crate) struct RunControl<'a> {
    pub cancel: &'a AtomicBool,
    pub progress: &'a (dyn Fn(u64) + Send + Sync),
    pub max_rows: u64,
}

enum Tx {
    Pg(sqlx::Transaction<'static, sqlx::Postgres>),
    My(sqlx::Transaction<'static, sqlx::MySql>),
    Lite(sqlx::Transaction<'static, sqlx::Sqlite>),
}
macro_rules! bound {
    ($query:expr, $params:expr) => {{
        let mut query = $query;
        for param in $params {
            query = query.bind(param);
        }
        query
    }};
}
fn db_error(error: sqlx::Error) -> String {
    match error {
        sqlx::Error::Database(e) => e.message().to_string(),
        other => other.to_string(),
    }
}
// Each statement is a boxed future: the concrete futures of the three drivers differ,
// and boxing keeps the command future provably Send.
impl Tx {
    async fn begin(pool: &Pool) -> DbResult<Self> {
        Ok(match pool {
            Pool::Pg(p) => Tx::Pg(p.begin().await.map_err(err)?),
            Pool::My(p) => Tx::My(p.begin().await.map_err(err)?),
            Pool::Lite(p) => Tx::Lite(p.begin().await.map_err(err)?),
        })
    }
    fn execute<'a>(
        &'a mut self,
        sql: &'a str,
        params: Vec<Option<String>>,
    ) -> BoxFuture<'a, Result<u64, sqlx::Error>> {
        match self {
            Tx::Pg(t) => bound!(sqlx::query(sql), params)
                .execute(&mut **t)
                .map_ok(|r| r.rows_affected())
                .boxed(),
            Tx::My(t) => bound!(sqlx::query(sql), params)
                .execute(&mut **t)
                .map_ok(|r| r.rows_affected())
                .boxed(),
            Tx::Lite(t) => bound!(sqlx::query(sql), params)
                .execute(&mut **t)
                .map_ok(|r| r.rows_affected())
                .boxed(),
        }
    }
    fn scalar<'a>(
        &'a mut self,
        sql: &'a str,
        params: Vec<Option<String>>,
    ) -> BoxFuture<'a, Result<i64, sqlx::Error>> {
        match self {
            Tx::Pg(t) => bound!(sqlx::query_scalar(sql), params)
                .fetch_one(&mut **t)
                .boxed(),
            Tx::My(t) => bound!(sqlx::query_scalar(sql), params)
                .fetch_one(&mut **t)
                .boxed(),
            Tx::Lite(t) => bound!(sqlx::query_scalar(sql), params)
                .fetch_one(&mut **t)
                .boxed(),
        }
    }
    async fn exec(
        &mut self,
        sql: &str,
        params: Vec<Option<String>>,
        stall: Duration,
    ) -> DbResult<u64> {
        stalled(stall, self.execute(sql, params)).await
    }
    async fn count(
        &mut self,
        sql: &str,
        params: Vec<Option<String>>,
        stall: Duration,
    ) -> DbResult<u64> {
        stalled(stall, self.scalar(sql, params))
            .await
            .map(|n| n.max(0) as u64)
    }
    fn raw<'a>(&'a mut self, sql: &'a str) -> BoxFuture<'a, DbResult<()>> {
        match self {
            Tx::Pg(t) => (&mut **t).execute(sql).map_ok(drop).boxed(),
            Tx::My(t) => (&mut **t).execute(sql).map_ok(drop).boxed(),
            Tx::Lite(t) => (&mut **t).execute(sql).map_ok(drop).boxed(),
        }
        .map_err(db_error)
        .boxed()
    }
    async fn commit(self) -> DbResult<()> {
        match self {
            Tx::Pg(t) => t.commit().await,
            Tx::My(t) => t.commit().await,
            Tx::Lite(t) => t.commit().await,
        }
        .map_err(err)
    }
    async fn rollback(self) -> DbResult<()> {
        match self {
            Tx::Pg(t) => t.rollback().await,
            Tx::My(t) => t.rollback().await,
            Tx::Lite(t) => t.rollback().await,
        }
        .map_err(err)
    }
}
async fn stalled<T>(
    stall: Duration,
    run: impl std::future::Future<Output = Result<T, sqlx::Error>>,
) -> DbResult<T> {
    tokio::time::timeout(stall, run)
        .await
        .map_err(|_| {
            format!(
                "A statement did not finish within {} seconds.",
                stall.as_secs()
            )
        })?
        .map_err(db_error)
}

enum Pick {
    Index(usize),
    Key(String),
}
fn check_mapping(mapping: &[ColumnMapping]) -> DbResult<()> {
    if mapping.is_empty() {
        return Err("Map at least one source column to a table column.".into());
    }
    if mapping.len() > MAX_SOURCE_COLUMNS {
        return Err(format!("Import at most {MAX_SOURCE_COLUMNS} columns."));
    }
    if mapping.iter().any(|m| {
        [&m.source, &m.target]
            .iter()
            .any(|name| name.is_empty() || name.len() > 1024 || name.contains('\0'))
    }) {
        return Err("Invalid column name".into());
    }
    let mut targets = HashSet::new();
    for m in mapping {
        if !targets.insert(&m.target) {
            return Err(format!("Column {} is mapped twice.", m.target));
        }
    }
    Ok(())
}
fn picks_by_name(names: &[String], mapping: &[ColumnMapping]) -> DbResult<Vec<Pick>> {
    mapping
        .iter()
        .map(|m| {
            names
                .iter()
                .position(|name| *name == m.source)
                .map(Pick::Index)
                .ok_or_else(|| format!("The file has no column named {}.", m.source))
        })
        .collect()
}
fn numbered_picks(mapping: &[ColumnMapping]) -> DbResult<Vec<Pick>> {
    mapping
        .iter()
        .map(|m| {
            m.source
                .strip_prefix("Column ")
                .and_then(|n| n.parse::<usize>().ok())
                .filter(|n| (1..=MAX_SOURCE_COLUMNS).contains(n))
                .map(|n| Pick::Index(n - 1))
                .ok_or_else(|| format!("The file has no column named {}.", m.source))
        })
        .collect()
}
fn project(
    record: Record,
    picks: &[Pick],
    width: Option<usize>,
    driver: &Driver,
) -> Result<Vec<Option<String>>, String> {
    let cells: Vec<Cell> = match record {
        Record::Fields(cells) => {
            if let Some(width) = width {
                // Trailing delimiters are tolerated; real extra values mean broken quoting.
                if cells
                    .iter()
                    .skip(width)
                    .any(|c| *c != Cell::Null && *c != Cell::Text(String::new()))
                {
                    return Err(format!(
                        "Has {} fields but the header has {width}. Check the delimiter and quotes.",
                        cells.len()
                    ));
                }
            }
            picks
                .iter()
                .map(|pick| match pick {
                    Pick::Index(i) => cells.get(*i).cloned().unwrap_or(Cell::Null),
                    Pick::Key(_) => Cell::Null,
                })
                .collect()
        }
        Record::Object(map) => picks
            .iter()
            .map(|pick| match pick {
                Pick::Key(key) => map.get(key).map_or(Cell::Null, Cell::from_json),
                Pick::Index(_) => Cell::Null,
            })
            .collect(),
    };
    let values: Vec<Option<String>> = cells.into_iter().map(|c| c.bind(driver)).collect();
    if values
        .iter()
        .any(|v| v.as_ref().is_some_and(|t| t.len() > MAX_VALUE_BYTES))
    {
        return Err("A value exceeds 4 MB.".into());
    }
    Ok(values)
}

#[derive(Default)]
struct Counts {
    inserted: u64,
    updated: u64,
    skipped: u64,
    not_found: Vec<u64>,
}
#[derive(Default)]
struct Batch {
    rows: Vec<(u64, Vec<Option<String>>)>,
    bytes: usize,
    keys: HashSet<Vec<Option<String>>>,
}
struct Importer {
    driver: Driver,
    target: String,
    columns: Vec<String>,
    /// Positions of the primary key columns within `columns`.
    keys: Vec<usize>,
    /// PostgreSQL type of each mapped column, for the CAST around its placeholder.
    types: Vec<String>,
    mode: ImportMode,
    keep_going: bool,
    transactional: bool,
    batch_rows: usize,
    stall: Duration,
    summary: ImportSummary,
}
fn param_limit_for(driver: &Driver, sqlite_version: &str) -> usize {
    match driver {
        Driver::Postgres | Driver::Mysql => 65_535,
        Driver::Sqlite => {
            let mut parts = sqlite_version
                .split('.')
                .map(|p| p.parse::<u32>().unwrap_or(0));
            let (major, minor) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
            if (major, minor) >= (3, 32) {
                32_766
            } else {
                999
            }
        }
    }
}
/// Rows per multi-row statement: the requested size, within the bind parameter limit.
fn rows_per_batch(requested: u32, width: usize, limit: usize) -> usize {
    (requested as usize).min(limit / width.max(1)).max(1)
}
impl Importer {
    async fn new(
        conn: &Connection,
        table: &TableInfo,
        info: &ImportTarget,
        request: &ImportRequest,
    ) -> DbResult<Self> {
        let driver = conn.config.driver.clone();
        let by_name: HashMap<&str, &TargetColumn> =
            info.columns.iter().map(|c| (c.name.as_str(), c)).collect();
        let mut types = Vec::new();
        for m in &request.mapping {
            let column = by_name
                .get(m.target.as_str())
                .ok_or_else(|| format!("Unknown column {}", m.target))?;
            if column.generated {
                return Err(format!(
                    "{} is a generated column and cannot be imported.",
                    m.target
                ));
            }
            types.push(column.data_type.clone());
        }
        let columns: Vec<String> = request.mapping.iter().map(|m| m.target.clone()).collect();
        let mode = request.mode;
        let mut keys = Vec::new();
        if matches!(mode, ImportMode::Update | ImportMode::Upsert) {
            let name = if mode == ImportMode::Update {
                "Update"
            } else {
                "Append/Update"
            };
            if info.primary_keys.is_empty() {
                return Err(format!(
                    "{name} matches existing rows by primary key, but this table has none."
                ));
            }
            for key in &info.primary_keys {
                keys.push(columns.iter().position(|c| c == key).ok_or_else(|| {
                    format!(
                        "Map every primary key column ({}) to match existing rows.",
                        info.primary_keys.join(", ")
                    )
                })?);
            }
            if mode == ImportMode::Update && keys.len() == columns.len() {
                return Err("Map at least one column besides the primary key to update.".into());
            }
        }
        if !info.transactional {
            if mode == ImportMode::Copy {
                return Err("Copy deletes every row first, which needs a transactional (InnoDB) table so a failure can be undone.".into());
            }
            if !request.continue_on_error {
                return Err("This table's storage engine cannot roll back, so an all-or-nothing import is not possible. Convert it to InnoDB, or enable Continue on error to import row by row (rows written before a failure or cancel are kept).".into());
            }
        }
        let version = match &conn.pool {
            Pool::Lite(p) => sqlx::query_scalar::<_, String>("SELECT sqlite_version()")
                .fetch_one(p)
                .await
                .map_err(err)?,
            _ => String::new(),
        };
        let batch_rows = if info.transactional {
            rows_per_batch(
                request.batch_rows,
                columns.len(),
                param_limit_for(&driver, &version),
            )
        } else {
            1
        };
        Ok(Self {
            target: qualified(table, &driver),
            stall: Duration::from_secs(
                conn.config
                    .options
                    .query_timeout_secs
                    .unwrap_or(DEADLINE.as_secs())
                    .clamp(MIN_STALL_SECS, MAX_QUERY_TIMEOUT_SECS),
            ),
            driver,
            columns,
            keys,
            types,
            mode,
            keep_going: request.continue_on_error,
            transactional: info.transactional,
            batch_rows,
            summary: ImportSummary::default(),
        })
    }
    fn param(&self, n: usize, column: usize) -> String {
        if matches!(self.driver, Driver::Postgres) {
            format!("CAST(${n} AS {})", self.types[column])
        } else {
            "?".into()
        }
    }
    fn others(&self) -> Vec<usize> {
        (0..self.columns.len())
            .filter(|i| !self.keys.contains(i))
            .collect()
    }
    fn name(&self, column: usize) -> String {
        quote(&self.columns[column], &self.driver)
    }
    fn insert_sql(&self, rows: usize) -> String {
        let width = self.columns.len();
        let names = (0..width)
            .map(|c| self.name(c))
            .collect::<Vec<_>>()
            .join(", ");
        let tuples = (0..rows)
            .map(|r| {
                let params = (0..width)
                    .map(|c| self.param(r * width + c + 1, c))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("({params})")
            })
            .collect::<Vec<_>>()
            .join(", ");
        let mut sql = format!("INSERT INTO {} ({names}) VALUES {tuples}", self.target);
        if self.mode == ImportMode::Upsert {
            let others = self.others();
            let keys = self
                .keys
                .iter()
                .map(|k| self.name(*k))
                .collect::<Vec<_>>()
                .join(", ");
            sql.push_str(&match self.driver {
                Driver::Mysql if others.is_empty() => {
                    let key = self.name(self.keys[0]);
                    format!(" ON DUPLICATE KEY UPDATE {key} = {key}")
                }
                Driver::Mysql => format!(
                    " ON DUPLICATE KEY UPDATE {}",
                    others
                        .iter()
                        .map(|c| format!("{0} = VALUES({0})", self.name(*c)))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
                _ if others.is_empty() => format!(" ON CONFLICT ({keys}) DO NOTHING"),
                _ => format!(
                    " ON CONFLICT ({keys}) DO UPDATE SET {}",
                    others
                        .iter()
                        .map(|c| format!("{0} = excluded.{0}", self.name(*c)))
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            });
        }
        sql
    }
    // The bare key column stays on the left so the primary key index serves the lookup.
    fn key_condition(&self, first: usize) -> String {
        self.keys
            .iter()
            .enumerate()
            .map(|(i, k)| format!("{} = {}", self.name(*k), self.param(first + i, *k)))
            .collect::<Vec<_>>()
            .join(" AND ")
    }
    fn exists_sql(&self, rows: usize) -> String {
        let conditions = (0..rows)
            .map(|r| format!("({})", self.key_condition(r * self.keys.len() + 1)))
            .collect::<Vec<_>>()
            .join(" OR ");
        format!("SELECT COUNT(*) FROM {} WHERE {conditions}", self.target)
    }
    fn update_sql(&self) -> String {
        let others = self.others();
        let assignments = others
            .iter()
            .enumerate()
            .map(|(i, c)| format!("{} = {}", self.name(*c), self.param(i + 1, *c)))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "UPDATE {} SET {assignments} WHERE {}",
            self.target,
            self.key_condition(others.len() + 1)
        )
    }
    fn key_values(&self, values: &[Option<String>]) -> Vec<Option<String>> {
        self.keys.iter().map(|k| values[*k].clone()).collect()
    }
    /// Writes rows in one statement (one per row for Update). An error carries the row
    /// when it is known.
    async fn write(
        &self,
        db: &mut Tx,
        rows: &[(u64, Vec<Option<String>>)],
    ) -> Result<Counts, (Option<u64>, String)> {
        let single = (rows.len() == 1).then(|| rows[0].0);
        let mut counts = Counts::default();
        match self.mode {
            ImportMode::Append | ImportMode::Copy => {
                let params: Vec<Option<String>> =
                    rows.iter().flat_map(|(_, v)| v.iter().cloned()).collect();
                db.exec(&self.insert_sql(rows.len()), params, self.stall)
                    .await
                    .map_err(|e| (single, e))?;
                counts.inserted = rows.len() as u64;
            }
            ImportMode::Upsert => {
                let keys: Vec<Option<String>> =
                    rows.iter().flat_map(|(_, v)| self.key_values(v)).collect();
                let existing = db
                    .count(&self.exists_sql(rows.len()), keys, self.stall)
                    .await
                    .map_err(|e| (single, e))?;
                let params: Vec<Option<String>> =
                    rows.iter().flat_map(|(_, v)| v.iter().cloned()).collect();
                db.exec(&self.insert_sql(rows.len()), params, self.stall)
                    .await
                    .map_err(|e| (single, e))?;
                counts.inserted = rows.len() as u64 - existing.min(rows.len() as u64);
                if self.others().is_empty() {
                    counts.skipped = existing;
                } else {
                    counts.updated = existing;
                }
            }
            ImportMode::Update => {
                let sql = self.update_sql();
                let others = self.others();
                for (row, values) in rows {
                    let params: Vec<Option<String>> = others
                        .iter()
                        .map(|c| values[*c].clone())
                        .chain(self.key_values(values))
                        .collect();
                    let changed = db
                        .exec(&sql, params, self.stall)
                        .await
                        .map_err(|e| (Some(*row), e))?;
                    if changed == 0 {
                        counts.not_found.push(*row);
                    } else {
                        counts.updated += 1;
                    }
                }
            }
        }
        Ok(counts)
    }
    fn note(&mut self, row: u64, message: String) {
        if self.summary.errors.len() < MAX_ERRORS {
            self.summary.errors.push(RowIssue { row, message });
        } else {
            self.summary.more_errors += 1;
        }
    }
    fn add(&mut self, counts: Counts) {
        self.summary.inserted += counts.inserted;
        self.summary.updated += counts.updated;
        self.summary.skipped += counts.skipped + counts.not_found.len() as u64;
        for row in counts.not_found {
            self.note(row, "No row with this primary key; skipped.".into());
        }
    }
    /// Records a rejected row, or stops the import when not continuing on errors.
    fn fail(&mut self, row: u64, message: String) -> DbResult<()> {
        if !self.keep_going {
            return Err(format!("Row {row}: {message}"));
        }
        self.summary.failed += 1;
        self.note(row, message);
        Ok(())
    }
    async fn flush(&mut self, db: &mut Tx, batch: &mut Batch) -> DbResult<()> {
        let rows = std::mem::take(&mut batch.rows);
        batch.bytes = 0;
        batch.keys.clear();
        if rows.is_empty() {
            return Ok(());
        }
        // Tables that cannot roll back write one row per statement, so a failure never
        // leaves half a batch behind.
        if !self.transactional {
            for row in &rows {
                match self.write(db, std::slice::from_ref(row)).await {
                    Ok(counts) => self.add(counts),
                    Err((_, e)) => self.fail(row.0, e)?,
                }
            }
            return Ok(());
        }
        let savepoint = format!("SAVEPOINT {SAVEPOINT}");
        let rollback = format!("ROLLBACK TO SAVEPOINT {SAVEPOINT}");
        let release = format!("RELEASE SAVEPOINT {SAVEPOINT}");
        db.raw(&savepoint).await?;
        let (at, error) = match self.write(db, &rows).await {
            Ok(counts) => {
                db.raw(&release).await?;
                self.add(counts);
                return Ok(());
            }
            Err(failure) => failure,
        };
        db.raw(&rollback).await?;
        db.raw(&release).await?;
        if rows.len() == 1 || (!self.keep_going && at.is_some()) {
            return self.fail(at.unwrap_or(rows[0].0), error);
        }
        // Replay row by row to find the rejected rows; good rows still go in.
        for row in &rows {
            if self.keep_going {
                db.raw(&savepoint).await?;
            }
            match self.write(db, std::slice::from_ref(row)).await {
                Ok(counts) => {
                    if self.keep_going {
                        db.raw(&release).await?;
                    }
                    self.add(counts);
                }
                Err((_, e)) => {
                    if self.keep_going {
                        db.raw(&rollback).await?;
                        db.raw(&release).await?;
                    }
                    self.fail(row.0, e)?;
                }
            }
        }
        Ok(())
    }
    async fn consume(
        &mut self,
        db: &mut Tx,
        receiver: &mut tokio::sync::mpsc::Receiver<DbResult<Vec<Item>>>,
        parse: &Parse,
        mapping: &[ColumnMapping],
        control: &RunControl<'_>,
    ) -> DbResult<()> {
        let mut picks = if is_json(parse.format) {
            Some(
                mapping
                    .iter()
                    .map(|m| Pick::Key(m.source.clone()))
                    .collect(),
            )
        } else if !parse.header {
            Some(numbered_picks(mapping)?)
        } else {
            None
        };
        let mut width = None;
        if self.mode == ImportMode::Copy {
            self.summary.deleted = db
                .exec(
                    &format!("DELETE FROM {}", self.target),
                    Vec::new(),
                    self.stall,
                )
                .await
                .map_err(|e| format!("Could not delete the existing rows: {e}"))?;
        }
        let mut batch = Batch::default();
        while let Some(chunk) = receiver.recv().await {
            if control.cancel.load(Ordering::Relaxed) {
                return Err(CANCELLED.into());
            }
            for item in chunk? {
                let (row, record) = match item {
                    Item::Total(_) => continue,
                    Item::Header(raw) => {
                        let names = source_names(raw);
                        picks = Some(picks_by_name(&names, mapping)?);
                        width = Some(names.len());
                        continue;
                    }
                    Item::Bad(row, message) => {
                        self.summary.rows = row;
                        check_rows(row, control.max_rows)?;
                        self.fail(row, message)?;
                        continue;
                    }
                    Item::Row(row, record) => (row, record),
                };
                self.summary.rows = row;
                check_rows(row, control.max_rows)?;
                let picks = picks.as_ref().ok_or("The file has no header row.")?;
                let values = match project(record, picks, width, &self.driver) {
                    Ok(values) => values,
                    Err(message) => {
                        self.fail(row, message)?;
                        continue;
                    }
                };
                let bytes: usize = values
                    .iter()
                    .map(|v| v.as_ref().map_or(1, String::len))
                    .sum();
                // A key twice in one statement fails in PostgreSQL; split the batch there.
                let repeated = self.mode == ImportMode::Upsert
                    && batch.keys.contains(&self.key_values(&values));
                if !batch.rows.is_empty() && (repeated || batch.bytes + bytes > MAX_BATCH_BYTES) {
                    self.flush(db, &mut batch).await?;
                }
                if self.mode == ImportMode::Upsert {
                    batch.keys.insert(self.key_values(&values));
                }
                batch.bytes += bytes;
                batch.rows.push((row, values));
                if batch.rows.len() >= self.batch_rows {
                    self.flush(db, &mut batch).await?;
                }
            }
            (control.progress)(self.summary.rows);
        }
        self.flush(db, &mut batch).await?;
        if control.cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        (control.progress)(self.summary.rows);
        Ok(())
    }
}
fn check_rows(row: u64, max: u64) -> DbResult<()> {
    if row > max {
        Err(format!(
            "The file has more than {max} rows. Split it and import at most {max} rows at a time."
        ))
    } else {
        Ok(())
    }
}
async fn run_import(
    conn: &Connection,
    table: &TableInfo,
    path: &Path,
    request: &ImportRequest,
    control: &RunControl<'_>,
) -> DbResult<ImportSummary> {
    let parse = request.options.plan()?;
    check_mapping(&request.mapping)?;
    if !(1..=5000).contains(&request.batch_rows) {
        return Err("Rows per statement must be between 1 and 5,000.".into());
    }
    let size = tokio::fs::metadata(path).await.map_err(err)?.len();
    check_size(parse.format, size)?;
    let info = target_info(conn, table).await?;
    let mut importer = Importer::new(conn, table, &info, request).await?;
    // The parser runs on a blocking thread and hands rows over in chunks; dropping the
    // receiver stops it.
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<DbResult<Vec<Item>>>(4);
    let (file, reader) = (path.to_path_buf(), parse.clone());
    tokio::task::spawn_blocking(move || {
        let mut chunk = Vec::with_capacity(CHUNK_ROWS);
        let result = read_file(&file, &reader, &mut |item| {
            chunk.push(item);
            if chunk.len() >= CHUNK_ROWS
                && sender
                    .blocking_send(Ok(std::mem::take(&mut chunk)))
                    .is_err()
            {
                return Flow::Stop;
            }
            Flow::More
        });
        let _ = sender.blocking_send(result.map(|()| chunk));
    });
    let mut db = Tx::begin(&conn.pool).await?;
    let outcome = importer
        .consume(&mut db, &mut receiver, &parse, &request.mapping, control)
        .await;
    drop(receiver);
    match outcome {
        Ok(()) => {
            db.commit().await?;
            Ok(importer.summary)
        }
        Err(error) => {
            let _ = db.rollback().await;
            let written = importer.summary.inserted + importer.summary.updated;
            let error = if error.ends_with('.') || error == CANCELLED {
                error
            } else {
                format!("{error}.")
            };
            Err(match (error == CANCELLED, importer.transactional) {
                (true, true) => error,
                (true, false) => format!("Import cancelled. {written} rows already written were kept because the table cannot roll back."),
                (false, true) => format!("{error} Nothing was imported."),
                (false, false) => format!("{error} {written} rows written before it were kept because the table cannot roll back."),
            })
        }
    }
}

/// Shows the native open dialog and previews the chosen file; None when cancelled.
#[tauri::command]
pub(crate) async fn dbde_import_open(
    app: tauri::AppHandle,
    imports: State<'_, Imports>,
) -> DbResult<Option<ImportPreview>> {
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Data files", &EXTENSIONS)
            .add_filter("CSV or TSV", &["csv", "tsv", "tab", "txt"])
            .add_filter("JSON or JSON Lines", &["json", "jsonl", "ndjson"])
            .add_filter("Excel", &["xlsx", "xlsm", "xls", "xlsb", "ods"])
            .blocking_pick_file()
    })
    .await
    .map_err(err)?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let path = path.into_path().map_err(err)?;
    let size = tokio::fs::metadata(&path).await.map_err(err)?.len();
    check_size(ImportFormat::Csv, size)?;
    let id = imports.stage(path, size)?;
    let file = imports.file(&id)?;
    match build_preview(id.clone(), file, None).await {
        Ok(preview) => Ok(Some(preview)),
        Err(error) => {
            imports.forget(&id);
            Err(error)
        }
    }
}
/// Parses the opened file again with new options (format, delimiter, header, sheet…).
#[tauri::command]
pub(crate) async fn dbde_import_preview(
    import_id: String,
    options: ParseOptions,
    imports: State<'_, Imports>,
) -> DbResult<ImportPreview> {
    let file = imports.file(&import_id)?;
    build_preview(import_id, file, Some(options)).await
}
#[tauri::command]
pub(crate) fn dbde_import_close(import_id: String, imports: State<'_, Imports>) -> DbResult<()> {
    check_id(&import_id)?;
    if !imports
        .running
        .lock()
        .map_err(err)?
        .contains_key(&import_id)
    {
        imports.forget(&import_id);
    }
    Ok(())
}
/// The target table's columns (type, NOT NULL, default), primary key and engine.
#[tauri::command]
pub(crate) async fn dbde_import_target(
    connection_id: String,
    database: String,
    table: TableInfo,
    state: State<'_, AppState>,
) -> DbResult<ImportTarget> {
    timed(async {
        let conn = database_connection(&state, &connection_id, Some(&database)).await?;
        target_info(&conn, &table).await
    })
    .await
}
/// Exact row count, shown when confirming a Copy import.
#[tauri::command]
pub(crate) async fn dbde_import_count(
    connection_id: String,
    database: String,
    table: TableInfo,
    state: State<'_, AppState>,
) -> DbResult<u64> {
    timed(async {
        let conn = database_connection(&state, &connection_id, Some(&database)).await?;
        row_count(&conn, &table).await
    })
    .await
}
/// Imports the opened file; None when cancelled (everything is rolled back).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Each argument is a named IPC field from the webview.
pub(crate) async fn dbde_import_run(
    connection_id: String,
    database: String,
    table: TableInfo,
    import_id: String,
    request: ImportRequest,
    on_progress: Channel<ImportProgress>,
    state: State<'_, AppState>,
    imports: State<'_, Imports>,
) -> DbResult<Option<ImportSummary>> {
    let (path, _, _) = imports.file(&import_id)?;
    let running = imports.start(&import_id)?;
    let conn = timed(database_connection(&state, &connection_id, Some(&database))).await?;
    let progress = move |rows| {
        let _ = on_progress.send(ImportProgress { rows });
    };
    let control = RunControl {
        cancel: &running.flag,
        progress: &progress,
        max_rows: MAX_IMPORT_ROWS,
    };
    match run_import(&conn, &table, &path, &request, &control).await {
        Ok(summary) => Ok(Some(summary)),
        Err(error) if error == CANCELLED => Ok(None),
        Err(error) => Err(error),
    }
}
#[tauri::command]
pub(crate) fn dbde_cancel_import(import_id: String, imports: State<'_, Imports>) -> DbResult<()> {
    if let Some(flag) = imports.running.lock().map_err(err)?.get(&import_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn sqlite(setup: &str) -> Connection {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let conn = Connection {
            tunnel: None,
            pool: Pool::Lite(pool),
            config: crate::tests::config(Driver::Sqlite),
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        };
        raw_pool_query(&conn.pool, setup).await.unwrap();
        conn
    }
    const PEOPLE: &str = "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT, score REAL, active INTEGER)";
    fn table(name: &str) -> TableInfo {
        TableInfo {
            name: name.into(),
            schema: "".into(),
            kind: "table".into(),
        }
    }
    fn temp_file(ext: &str, contents: &[u8]) -> PathBuf {
        let path = std::env::temp_dir().join(format!("dbde-import-{}.{ext}", uuid::Uuid::new_v4()));
        std::fs::write(&path, contents).unwrap();
        path
    }
    fn options(format: ImportFormat) -> ParseOptions {
        ParseOptions::new(format)
    }
    fn request(options: ParseOptions, mapping: &[(&str, &str)], mode: &str) -> ImportRequest {
        serde_json::from_value(json!({
            "options": options,
            "mapping": mapping.iter().map(|(s, t)| json!({"source": s, "target": t})).collect::<Vec<_>>(),
            "mode": mode,
        }))
        .unwrap()
    }
    async fn run_with(
        conn: &Connection,
        name: &str,
        path: &Path,
        request: &ImportRequest,
        cancel: bool,
        max_rows: u64,
    ) -> DbResult<ImportSummary> {
        let flag = AtomicBool::new(cancel);
        let seen = std::sync::Mutex::new(Vec::new());
        let progress = |rows| seen.lock().unwrap().push(rows);
        let control = RunControl {
            cancel: &flag,
            progress: &progress,
            max_rows,
        };
        let result = run_import(conn, &table(name), path, request, &control).await;
        if let Ok(summary) = &result {
            assert_eq!(seen.lock().unwrap().last(), Some(&summary.rows));
        }
        result
    }
    async fn run(
        conn: &Connection,
        name: &str,
        path: &Path,
        request: &ImportRequest,
    ) -> DbResult<ImportSummary> {
        run_with(conn, name, path, request, false, MAX_IMPORT_ROWS).await
    }
    async fn rows(conn: &Connection, sql: &str) -> Vec<Vec<Value>> {
        query(&conn.pool, sql).await.unwrap().rows
    }
    fn preview(path: &Path, options: &ParseOptions) -> PreviewData {
        let size = std::fs::metadata(path).unwrap().len();
        preview_file(path, size, &options.plan().unwrap()).unwrap()
    }
    const ALL: [(&str, &str); 5] = [
        ("id", "id"),
        ("name", "name"),
        ("note", "note"),
        ("score", "score"),
        ("active", "active"),
    ];

    #[test]
    fn options_ids_and_mappings_are_validated() {
        let mut o = options(ImportFormat::Csv);
        assert_eq!(o.plan().unwrap().delimiter, b',');
        o.delimiter = ";;".into();
        assert!(o.plan().is_err());
        o.delimiter = "\n".into();
        assert!(o.plan().is_err());
        o.delimiter = "é".into();
        assert!(o.plan().is_err());
        o.delimiter = "\"".into();
        assert!(o.plan().is_err());
        o.delimiter = ";".into();
        o.null_text = "x\ny".into();
        assert!(o.plan().is_err());
        let mut tsv = options(ImportFormat::Tsv);
        tsv.delimiter = ",".into();
        assert_eq!(tsv.plan().unwrap().delimiter, b'\t');
        assert!(serde_json::from_value::<ImportRequest>(
            json!({"options": options(ImportFormat::Csv), "mapping": [], "mode": "merge"})
        )
        .is_err());
        assert!(serde_json::from_value::<ParseOptions>(
            json!({"format": "csv", "path": "/etc/passwd"})
        )
        .is_err());
        assert!(check_mapping(&[]).is_err());
        let twice = request(
            options(ImportFormat::Csv),
            &[("a", "x"), ("b", "x")],
            "append",
        );
        assert!(check_mapping(&twice.mapping)
            .unwrap_err()
            .contains("mapped twice"));
        assert!(check_id("../x").is_err());
        assert!(check_id(&"a".repeat(65)).is_err());
        let imports = Imports::default();
        let id = imports.stage(PathBuf::from("/tmp/x.csv"), 1).unwrap();
        assert_eq!(imports.file(&id).unwrap().1, "x.csv");
        let running = imports.start(&id).unwrap();
        assert!(imports.start(&id).is_err());
        drop(running);
        assert!(imports.start(&id).is_ok());
        for _ in 0..MAX_STAGED {
            imports.stage(PathBuf::from("/tmp/y.csv"), 1).unwrap();
        }
        assert_eq!(imports.files.lock().unwrap().len(), MAX_STAGED);
        assert!(imports.file(&id).is_err(), "the oldest file is evicted");
        assert!(check_size(ImportFormat::Csv, MAX_FILE_BYTES + 1).is_err());
        assert!(check_size(ImportFormat::Excel, MAX_EXCEL_BYTES + 1).is_err());
        assert!(check_size(ImportFormat::Csv, MAX_EXCEL_BYTES + 1).is_ok());
    }
    #[test]
    fn batches_respect_bind_parameter_limits() {
        assert_eq!(param_limit_for(&Driver::Sqlite, "3.31.1"), 999);
        assert_eq!(param_limit_for(&Driver::Sqlite, "3.45.0"), 32_766);
        assert_eq!(param_limit_for(&Driver::Postgres, ""), 65_535);
        assert_eq!(param_limit_for(&Driver::Mysql, ""), 65_535);
        assert_eq!(rows_per_batch(500, 5, 999), 199);
        assert_eq!(rows_per_batch(500, 2000, 999), 1);
        assert_eq!(rows_per_batch(500, 10, 65_535), 500);
        assert_eq!(rows_per_batch(1000, 100, 65_535), 655);
    }
    #[test]
    fn formats_are_detected_from_the_extension_and_content() {
        let lines = temp_file("json", b"  {\"a\": 1}\n{\"a\": 2}\n");
        assert_eq!(detect_format(&lines).unwrap(), ImportFormat::Jsonl);
        let array = temp_file("json", b"\xEF\xBB\xBF[{\"a\": 1}]");
        assert_eq!(detect_format(&array).unwrap(), ImportFormat::Json);
        let tabs = temp_file("txt", b"a\tb\n1\t2\n");
        assert_eq!(detect_format(&tabs).unwrap(), ImportFormat::Tsv);
        assert_eq!(
            detect_format(Path::new("/x/data.XLSX")).unwrap(),
            ImportFormat::Excel
        );
        assert_eq!(
            detect_format(Path::new("/x/data.csv")).unwrap(),
            ImportFormat::Csv
        );
        let utf16 = temp_file("csv", b"\xFF\xFEa\0,\0");
        assert!(open_text(&utf16).unwrap_err().contains("UTF-16"));
        for path in [lines, array, tabs, utf16] {
            std::fs::remove_file(path).unwrap();
        }
    }
    #[test]
    fn previews_name_columns_and_estimate_rows() {
        let csv = temp_file(
            "csv",
            "\u{feff}id,Name,,name\r\n1,\"Ana \"\"A\"\", Jr.\",x,y\r\n2,\"multi\nline\",,\r\n"
                .as_bytes(),
        );
        let p = preview(&csv, &options(ImportFormat::Csv));
        assert_eq!(p.columns, ["id", "Name", "Column 3", "name (2)"]);
        assert_eq!(p.rows[0][1].as_deref(), Some("Ana \"A\", Jr."));
        assert_eq!(p.rows[1][1].as_deref(), Some("multi\nline"));
        assert_eq!(p.rows[1][2], None, "empty cells are NULL by default");
        assert!(p.exact);
        assert_eq!(p.estimated_rows, 2);
        let mut no_header = options(ImportFormat::Csv);
        no_header.header = false;
        let p = preview(&csv, &no_header);
        assert_eq!(p.columns, ["Column 1", "Column 2", "Column 3", "Column 4"]);
        assert_eq!(p.rows.len(), 3);
        let mut big = String::from("n,text\n");
        for i in 0..2000 {
            big.push_str(&format!("{i},row number {i}\n"));
        }
        let large = temp_file("csv", big.as_bytes());
        let p = preview(&large, &options(ImportFormat::Csv));
        assert_eq!(p.rows.len(), PREVIEW_ROWS);
        assert!(!p.exact);
        assert!(
            (1000..4000).contains(&p.estimated_rows),
            "{}",
            p.estimated_rows
        );
        let json = temp_file(
            "json",
            br#"[{"a": 1, "b": {"x": [1]}}, {"c": null, "a": true}, 5]"#,
        );
        let p = preview(&json, &options(ImportFormat::Json));
        assert_eq!(p.columns, ["a", "b", "c"]);
        assert_eq!(p.rows[0][1].as_deref(), Some(r#"{"x":[1]}"#));
        assert_eq!(p.rows[1][0].as_deref(), Some("true"));
        assert_eq!(
            p.issues,
            [RowIssue {
                row: 3,
                message: "Not a JSON object.".into()
            }]
        );
        let broken = temp_file("json", br#"[{"a": 1}, {"a": "#);
        let size = std::fs::metadata(&broken).unwrap().len();
        assert!(
            preview_file(&broken, size, &options(ImportFormat::Json).plan().unwrap())
                .unwrap_err()
                .contains("not a JSON array")
        );
        for path in [csv, large, json, broken] {
            std::fs::remove_file(path).unwrap();
        }
    }

    #[tokio::test]
    async fn csv_appends_quotes_newlines_bom_and_unicode() {
        let conn = sqlite(PEOPLE).await;
        let path = temp_file(
            "csv",
            "\u{feff}ID,Name,Note,Score,Active\r\n1,\"Ana \"\"Quote\"\", Jr.\",\"line1\nline2\",1.5,1\r\n2,Café ☕ 日本,,-3,0\r\n3,'=1+1',\"\",1e3,1\r\n".as_bytes(),
        );
        let mapping = [
            ("ID", "id"),
            ("Name", "name"),
            ("Note", "note"),
            ("Score", "score"),
            ("Active", "active"),
        ];
        let summary = run(
            &conn,
            "people",
            &path,
            &request(options(ImportFormat::Csv), &mapping, "append"),
        )
        .await
        .unwrap();
        assert_eq!((summary.rows, summary.inserted, summary.failed), (3, 3, 0));
        assert_eq!(
            rows(
                &conn,
                "SELECT id, name, note, score, active FROM people ORDER BY id"
            )
            .await,
            vec![
                vec![
                    json!(1),
                    json!("Ana \"Quote\", Jr."),
                    json!("line1\nline2"),
                    json!(1.5),
                    json!(1)
                ],
                vec![
                    json!(2),
                    json!("Café ☕ 日本"),
                    Value::Null,
                    json!(-3.0),
                    json!(0)
                ],
                vec![
                    json!(3),
                    json!("'=1+1'"),
                    Value::Null,
                    json!(1000.0),
                    json!(1)
                ],
            ]
        );
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn tsv_custom_delimiters_and_null_markers() {
        let conn = sqlite(PEOPLE).await;
        let tsv = temp_file("tsv", b"id\tname\tnote\n1\tA\t\\N\n2\tB\t\n");
        let mut o = options(ImportFormat::Tsv);
        o.null_text = "\\N".into();
        run(&conn, "people", &tsv, &request(o, &ALL[..3], "append"))
            .await
            .unwrap();
        assert_eq!(
            rows(&conn, "SELECT note FROM people ORDER BY id").await,
            vec![vec![Value::Null], vec![json!("")]],
            "\\N is NULL while an empty field stays an empty string"
        );
        let semi = temp_file("csv", b"3;'C;D';NULL\n4;E;\n");
        let mut o = options(ImportFormat::Csv);
        o.delimiter = ";".into();
        o.quote = "'".into();
        o.header = false;
        o.null_text = "NULL".into();
        let mapping = [
            ("Column 1", "id"),
            ("Column 2", "name"),
            ("Column 3", "note"),
        ];
        run(&conn, "people", &semi, &request(o, &mapping, "append"))
            .await
            .unwrap();
        assert_eq!(
            rows(
                &conn,
                "SELECT name, note FROM people WHERE id > 2 ORDER BY id"
            )
            .await,
            vec![vec![json!("C;D"), Value::Null], vec![json!("E"), json!("")]]
        );
        let mut o = options(ImportFormat::Csv);
        o.header = false;
        let wrong = request(o, &[("Column 9999", "id")], "append");
        assert!(run(&conn, "people", &semi, &wrong)
            .await
            .unwrap_err()
            .contains("no column named"));
        for path in [tsv, semi] {
            std::fs::remove_file(path).unwrap();
        }
    }
    #[tokio::test]
    async fn json_arrays_and_json_lines() {
        let conn = sqlite(PEOPLE).await;
        let array = temp_file(
            "json",
            r#"[{"id": 1, "name": "Ann", "note": {"tags": ["a"]}, "score": 2.5, "active": true},
                {"id": 2, "name": "Bo", "active": false}]"#
                .as_bytes(),
        );
        run(
            &conn,
            "people",
            &array,
            &request(options(ImportFormat::Json), &ALL, "append"),
        )
        .await
        .unwrap();
        let lines = temp_file(
            "jsonl",
            "{\"id\": 3, \"name\": \"Çé\", \"note\": \"\"}\r\n\n{\"id\": 4, \"name\": \"Di\", \"note\": null}\n".as_bytes(),
        );
        run(
            &conn,
            "people",
            &lines,
            &request(options(ImportFormat::Jsonl), &ALL, "append"),
        )
        .await
        .unwrap();
        assert_eq!(
            rows(
                &conn,
                "SELECT id, name, note, score, active FROM people ORDER BY id"
            )
            .await,
            vec![
                vec![
                    json!(1),
                    json!("Ann"),
                    json!(r#"{"tags":["a"]}"#),
                    json!(2.5),
                    json!(1)
                ],
                vec![json!(2), json!("Bo"), Value::Null, Value::Null, json!(0)],
                vec![json!(3), json!("Çé"), json!(""), Value::Null, Value::Null],
                vec![json!(4), json!("Di"), Value::Null, Value::Null, Value::Null],
            ]
        );
        let bad = temp_file("jsonl", b"{\"id\": 5, \"name\": \"E\"}\n[1]\n{oops\n");
        let error = run(
            &conn,
            "people",
            &bad,
            &request(options(ImportFormat::Jsonl), &ALL, "append"),
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("Row 2: Not a JSON object."), "{error}");
        assert_eq!(
            rows(&conn, "SELECT COUNT(*) FROM people").await,
            vec![vec![json!(4)]]
        );
        for path in [array, lines, bad] {
            std::fs::remove_file(path).unwrap();
        }
    }
    #[tokio::test]
    async fn excel_sheets_import_typed_cells() {
        use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};
        let path = std::env::temp_dir().join(format!("dbde-import-{}.xlsx", uuid::Uuid::new_v4()));
        let mut workbook = Workbook::new();
        workbook
            .add_worksheet()
            .set_name("Notes")
            .unwrap()
            .write_string(0, 0, "ignored")
            .unwrap();
        let sheet = workbook.add_worksheet().set_name("People").unwrap();
        for (c, name) in ["id", "name", "note", "score", "active"].iter().enumerate() {
            sheet.write_string(0, c as u16, *name).unwrap();
        }
        sheet.write_number(1, 0, 1).unwrap();
        sheet.write_string(1, 1, "Zoë \"Z\"").unwrap();
        let date = ExcelDateTime::from_ymd(2026, 10, 18).unwrap();
        sheet
            .write_datetime_with_format(1, 2, &date, &Format::new().set_num_format("yyyy-mm-dd"))
            .unwrap();
        sheet.write_number(1, 3, 12.25).unwrap();
        sheet.write_boolean(1, 4, true).unwrap();
        sheet.write_number(2, 0, 2).unwrap();
        sheet.write_string(2, 1, "Empty note").unwrap();
        sheet.write_string(2, 2, "NULL").unwrap();
        workbook.save(&path).unwrap();
        assert_eq!(excel_sheets(&path).unwrap(), ["Notes", "People"]);
        let mut o = options(ImportFormat::Excel);
        o.sheet = Some("People".into());
        o.null_text = "NULL".into();
        let p = preview(&path, &o);
        assert_eq!(p.columns, ["id", "name", "note", "score", "active"]);
        assert!(p.exact);
        assert_eq!(p.estimated_rows, 2);
        let conn = sqlite(PEOPLE).await;
        run(&conn, "people", &path, &request(o.clone(), &ALL, "append"))
            .await
            .unwrap();
        assert_eq!(
            rows(
                &conn,
                "SELECT id, name, note, score, active FROM people ORDER BY id"
            )
            .await,
            vec![
                vec![
                    json!(1),
                    json!("Zoë \"Z\""),
                    json!("2026-10-18"),
                    json!(12.25),
                    json!(1)
                ],
                vec![
                    json!(2),
                    json!("Empty note"),
                    Value::Null,
                    Value::Null,
                    Value::Null
                ],
            ]
        );
        o.sheet = Some("Missing".into());
        assert!(run(&conn, "people", &path, &request(o, &ALL, "append"))
            .await
            .unwrap_err()
            .contains("no sheet named"));
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn errors_roll_back_the_whole_import_with_the_row_number() {
        let conn = sqlite(&format!(
            "{PEOPLE}; INSERT INTO people (id, name) VALUES (5000, 'kept')"
        ))
        .await;
        let mut csv = String::from("id,name\n");
        for i in 1..=1200 {
            // Row 1100 has no name, which the NOT NULL constraint rejects.
            csv.push_str(&format!("{i},{}\n", if i == 1100 { "" } else { "n" }));
        }
        let path = temp_file("csv", csv.as_bytes());
        let error = run(
            &conn,
            "people",
            &path,
            &request(options(ImportFormat::Csv), &ALL[..2], "append"),
        )
        .await
        .unwrap_err();
        assert!(
            error.starts_with("Row 1100: NOT NULL constraint failed"),
            "{error}"
        );
        assert!(error.ends_with("Nothing was imported."));
        assert_eq!(
            rows(&conn, "SELECT id FROM people").await,
            vec![vec![json!(5000)]]
        );
        // Copy deletes first; the failure restores the deleted rows too.
        let error = run(
            &conn,
            "people",
            &path,
            &request(options(ImportFormat::Csv), &ALL[..2], "copy"),
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("Row 1100"));
        assert_eq!(
            rows(&conn, "SELECT id FROM people").await,
            vec![vec![json!(5000)]]
        );
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn continue_on_error_skips_bad_rows_and_caps_messages() {
        let conn = sqlite(PEOPLE).await;
        let mut csv = String::from("id,name\n");
        for i in 1..=600 {
            csv.push_str(&format!("{i},{}\n", if i % 2 == 0 { "" } else { "ok" }));
        }
        let mut bytes = csv.into_bytes();
        bytes.extend_from_slice(b"1,duplicate\n601,\"bad\xff\"\n");
        let path = temp_file("csv", &bytes);
        let mut r = request(options(ImportFormat::Csv), &ALL[..2], "append");
        r.continue_on_error = true;
        let summary = run(&conn, "people", &path, &r).await.unwrap();
        assert_eq!(summary.rows, 602);
        assert_eq!(summary.inserted, 300);
        assert_eq!(summary.failed, 302);
        assert_eq!(summary.errors.len(), MAX_ERRORS);
        assert_eq!(summary.more_errors, 102);
        assert_eq!(summary.errors[0].row, 2);
        assert!(summary.errors[0].message.contains("NOT NULL"));
        assert_eq!(
            rows(&conn, "SELECT COUNT(*), MIN(id), MAX(id) FROM people").await,
            vec![vec![json!(300), json!(1), json!(599)]]
        );
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn upsert_inserts_new_rows_and_updates_existing_ones() {
        let conn = sqlite(&format!("{PEOPLE}; INSERT INTO people VALUES (1, 'old', 'keep', 1, 1), (2, 'old', 'keep', 2, 1)")).await;
        // Key 3 appears twice: the later row wins, as if applied one by one.
        let path = temp_file("csv", b"id,name\n2,two\n3,three\n3,THREE\n4,four\n");
        let summary = run(
            &conn,
            "people",
            &path,
            &request(options(ImportFormat::Csv), &ALL[..2], "upsert"),
        )
        .await
        .unwrap();
        assert_eq!(
            (summary.inserted, summary.updated, summary.skipped),
            (2, 2, 0)
        );
        assert_eq!(
            rows(&conn, "SELECT id, name, note FROM people ORDER BY id").await,
            vec![
                vec![json!(1), json!("old"), json!("keep")],
                vec![json!(2), json!("two"), json!("keep")],
                vec![json!(3), json!("THREE"), Value::Null],
                vec![json!(4), json!("four"), Value::Null],
            ]
        );
        let no_key = request(options(ImportFormat::Csv), &[("name", "name")], "upsert");
        assert!(run(&conn, "people", &path, &no_key)
            .await
            .unwrap_err()
            .contains("primary key column (id)"));
        let keyless = sqlite("CREATE TABLE log (msg TEXT)").await;
        assert!(run(
            &keyless,
            "log",
            &path,
            &request(options(ImportFormat::Csv), &[("name", "msg")], "upsert")
        )
        .await
        .unwrap_err()
        .contains("has none"));
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn update_matches_by_primary_key_and_reports_missing_rows() {
        let conn = sqlite(&format!("{PEOPLE}; CREATE TABLE pairs (a TEXT, b INTEGER, v TEXT, PRIMARY KEY (a, b)); INSERT INTO people VALUES (1, 'a', 'n', 1, 1), (2, 'b', 'n', 2, 1); INSERT INTO pairs VALUES ('x', 1, 'old'), ('x', 2, 'old')")).await;
        let path = temp_file("csv", b"id,note\n2,changed\n9,missing\n1,\n");
        let summary = run(
            &conn,
            "people",
            &path,
            &request(
                options(ImportFormat::Csv),
                &[("id", "id"), ("note", "note")],
                "update",
            ),
        )
        .await
        .unwrap();
        assert_eq!(
            (summary.updated, summary.skipped, summary.inserted),
            (2, 1, 0)
        );
        assert_eq!(
            summary.errors,
            [RowIssue {
                row: 2,
                message: "No row with this primary key; skipped.".into()
            }]
        );
        assert_eq!(
            rows(&conn, "SELECT note, name FROM people ORDER BY id").await,
            vec![
                vec![Value::Null, json!("a")],
                vec![json!("changed"), json!("b")]
            ]
        );
        let only_key = request(options(ImportFormat::Csv), &[("id", "id")], "update");
        assert!(run(&conn, "people", &path, &only_key)
            .await
            .unwrap_err()
            .contains("besides the primary key"));
        let pairs = temp_file(
            "json",
            br#"[{"a": "x", "b": 2, "v": "new"}, {"a": "y", "b": 2, "v": "none"}]"#,
        );
        let summary = run(
            &conn,
            "pairs",
            &pairs,
            &request(
                options(ImportFormat::Json),
                &[("a", "a"), ("b", "b"), ("v", "v")],
                "update",
            ),
        )
        .await
        .unwrap();
        assert_eq!((summary.updated, summary.skipped), (1, 1));
        assert_eq!(
            rows(&conn, "SELECT v FROM pairs ORDER BY b").await,
            vec![vec![json!("old")], vec![json!("new")]]
        );
        for path in [path, pairs] {
            std::fs::remove_file(path).unwrap();
        }
    }
    #[tokio::test]
    async fn copy_replaces_every_row() {
        let conn = sqlite(&format!(
            "{PEOPLE}; INSERT INTO people (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c')"
        ))
        .await;
        let path = temp_file("csv", b"id,name\n7,new\n");
        let summary = run(
            &conn,
            "people",
            &path,
            &request(options(ImportFormat::Csv), &ALL[..2], "copy"),
        )
        .await
        .unwrap();
        assert_eq!((summary.deleted, summary.inserted), (3, 1));
        assert_eq!(
            rows(&conn, "SELECT id, name FROM people").await,
            vec![vec![json!(7), json!("new")]]
        );
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn cancellation_and_row_limits_roll_back() {
        let conn = sqlite(&format!(
            "{PEOPLE}; INSERT INTO people (id, name) VALUES (1, 'a')"
        ))
        .await;
        let path = temp_file("csv", b"id,name\n5,x\n6,y\n7,z\n");
        let copy = request(options(ImportFormat::Csv), &ALL[..2], "copy");
        assert_eq!(
            run_with(&conn, "people", &path, &copy, true, MAX_IMPORT_ROWS)
                .await
                .unwrap_err(),
            CANCELLED
        );
        assert_eq!(
            rows(&conn, "SELECT id FROM people").await,
            vec![vec![json!(1)]]
        );
        let error = run_with(&conn, "people", &path, &copy, false, 2)
            .await
            .unwrap_err();
        assert!(error.contains("more than 2 rows"), "{error}");
        assert_eq!(
            rows(&conn, "SELECT id FROM people").await,
            vec![vec![json!(1)]]
        );
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn targets_are_validated_against_the_table() {
        let conn = sqlite("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, born TEXT DEFAULT 'x', twice INTEGER GENERATED ALWAYS AS (id * 2)); CREATE VIEW v AS SELECT * FROM t").await;
        let info = target_info(&conn, &table("t")).await.unwrap();
        let summary: Vec<_> = info
            .columns
            .iter()
            .map(|c| (c.name.as_str(), c.nullable, c.has_default, c.generated))
            .collect();
        assert_eq!(
            summary,
            [
                ("id", true, true, false),
                ("name", false, false, false),
                ("born", true, true, false),
                ("twice", true, false, true)
            ]
        );
        assert_eq!(info.primary_keys, ["id"]);
        assert!(info.transactional);
        let path = temp_file("csv", b"id,name\n1,a\n");
        let unknown = request(options(ImportFormat::Csv), &[("name", "nope")], "append");
        assert!(run(&conn, "t", &path, &unknown)
            .await
            .unwrap_err()
            .contains("Unknown column nope"));
        let generated = request(options(ImportFormat::Csv), &[("id", "twice")], "append");
        assert!(run(&conn, "t", &path, &generated)
            .await
            .unwrap_err()
            .contains("generated column"));
        let missing = request(options(ImportFormat::Csv), &[("missing", "name")], "append");
        assert!(run(&conn, "t", &path, &missing)
            .await
            .unwrap_err()
            .contains("no column named missing"));
        let mut view = table("v");
        view.kind = "view".into();
        assert!(target_info(&conn, &view).await.is_err());
        assert_eq!(row_count(&conn, &table("t")).await.unwrap(), 0);
        let fine = request(
            options(ImportFormat::Csv),
            &[("id", "id"), ("name", "name")],
            "append",
        );
        run(&conn, "t", &path, &fine).await.unwrap();
        assert_eq!(
            rows(&conn, "SELECT id, name, born, twice FROM t").await,
            vec![vec![json!(1), json!("a"), json!("x"), json!(2)]]
        );
        assert_eq!(row_count(&conn, &table("t")).await.unwrap(), 1);
        std::fs::remove_file(path).unwrap();
    }
    #[tokio::test]
    async fn large_files_stream_in_batches() {
        let conn = sqlite("CREATE TABLE seq (n INTEGER PRIMARY KEY, label TEXT)").await;
        let mut csv = String::from("n,label\n");
        for i in 1..=20_000 {
            csv.push_str(&format!("{i},label {i}\n"));
        }
        let path = temp_file("csv", csv.as_bytes());
        let summary = run(
            &conn,
            "seq",
            &path,
            &request(
                options(ImportFormat::Csv),
                &[("n", "n"), ("label", "label")],
                "append",
            ),
        )
        .await
        .unwrap();
        assert_eq!(summary.inserted, 20_000);
        assert_eq!(
            rows(&conn, "SELECT COUNT(*), SUM(n) FROM seq").await,
            vec![vec![json!(20_000), json!(200_010_000)]]
        );
        std::fs::remove_file(path).unwrap();
    }

    fn live_file(rows: &str) -> PathBuf {
        temp_file("csv", rows.as_bytes())
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_PG_URL; creates only session-local temporary tables"]
    async fn postgres_imports_cast_text_to_column_types() {
        let url = std::env::var("DBDE_TEST_PG_URL").unwrap();
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let mut conn = sqlite("SELECT 1").await;
        conn.pool = Pool::Pg(pool);
        conn.config.driver = Driver::Postgres;
        raw_pool_query(&conn.pool, "CREATE TEMPORARY TABLE import_test (id bigint PRIMARY KEY, name text NOT NULL, amount numeric(12,2), at date, ok boolean, doc jsonb, tags text[], created timestamptz DEFAULT now())").await.unwrap();
        let schema = query(
            &conn.pool,
            "SELECT nspname::text FROM pg_namespace WHERE oid = pg_my_temp_schema()",
        )
        .await
        .unwrap()
        .rows[0][0]
            .as_str()
            .unwrap()
            .to_string();
        let t = TableInfo {
            name: "import_test".into(),
            schema,
            kind: "table".into(),
        };
        let info = target_info(&conn, &t).await.unwrap();
        assert_eq!(info.primary_keys, ["id"]);
        assert!(info
            .columns
            .iter()
            .any(|c| c.name == "created" && c.has_default));
        assert!(info
            .columns
            .iter()
            .any(|c| c.name == "name" && !c.nullable && !c.has_default));
        let flag = AtomicBool::new(false);
        let control = RunControl {
            cancel: &flag,
            progress: &|_| {},
            max_rows: MAX_IMPORT_ROWS,
        };
        let path = live_file("id,name,amount,at,ok,doc,tags\n9223372036854775807,\"Café, \"\"q\"\"\",12.5,2026-10-18,true,\"{\"\"k\"\": 1}\",\"{a,b}\"\n1,x,,,,,\n");
        let mapping = [
            ("id", "id"),
            ("name", "name"),
            ("amount", "amount"),
            ("at", "at"),
            ("ok", "ok"),
            ("doc", "doc"),
            ("tags", "tags"),
        ];
        let summary = run_import(
            &conn,
            &t,
            &path,
            &request(options(ImportFormat::Csv), &mapping, "append"),
            &control,
        )
        .await
        .unwrap();
        assert_eq!(summary.inserted, 2);
        let got = query(&conn.pool, "SELECT id::text, name, amount::text, at::text, ok::text, doc::text, tags::text FROM import_test ORDER BY id DESC").await.unwrap().rows;
        assert_eq!(
            got[0],
            vec![
                json!("9223372036854775807"),
                json!("Café, \"q\""),
                json!("12.50"),
                json!("2026-10-18"),
                json!("true"),
                json!("{\"k\": 1}"),
                json!("{a,b}")
            ]
        );
        let upsert = live_file("id,name,amount\n1,updated,3\n2,new,4\n2,newer,5\n");
        let summary = run_import(
            &conn,
            &t,
            &upsert,
            &request(options(ImportFormat::Csv), &mapping[..3], "upsert"),
            &control,
        )
        .await
        .unwrap();
        assert_eq!((summary.inserted, summary.updated), (1, 2));
        let update = live_file("id,amount\n2,7\n404,1\n");
        let summary = run_import(
            &conn,
            &t,
            &update,
            &request(
                options(ImportFormat::Csv),
                &[("id", "id"), ("amount", "amount")],
                "update",
            ),
            &control,
        )
        .await
        .unwrap();
        assert_eq!((summary.updated, summary.skipped), (1, 1));
        // A bad number rolls back everything; with Continue on error the good rows stay.
        let bad = live_file("id,name,amount\n10,a,1\n11,b,not-a-number\n12,c,3\n");
        let error = run_import(
            &conn,
            &t,
            &bad,
            &request(options(ImportFormat::Csv), &mapping[..3], "append"),
            &control,
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("Row 2: invalid input syntax"), "{error}");
        let mut r = request(options(ImportFormat::Csv), &mapping[..3], "append");
        r.continue_on_error = true;
        let summary = run_import(&conn, &t, &bad, &r, &control).await.unwrap();
        assert_eq!((summary.inserted, summary.failed), (2, 1));
        let copy = live_file("id,name\n50,only\n");
        let summary = run_import(
            &conn,
            &t,
            &copy,
            &request(options(ImportFormat::Csv), &mapping[..2], "copy"),
            &control,
        )
        .await
        .unwrap();
        assert_eq!((summary.deleted, summary.inserted), (5, 1));
        assert_eq!(row_count(&conn, &t).await.unwrap(), 1);
        raw_pool_query(&conn.pool, "DROP TABLE import_test")
            .await
            .unwrap();
        for p in [path, upsert, update, bad, copy] {
            std::fs::remove_file(p).unwrap();
        }
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_MYSQL_URL; creates only session-local temporary tables"]
    async fn mysql_imports_upsert_and_refuse_non_transactional_all_or_nothing() {
        let url = std::env::var("DBDE_TEST_MYSQL_URL").unwrap();
        let pool = sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let mut conn = sqlite("SELECT 1").await;
        conn.pool = Pool::My(pool);
        conn.config.driver = Driver::Mysql;
        let database = query(&conn.pool, "SELECT DATABASE()").await.unwrap().rows[0][0]
            .as_str()
            .unwrap()
            .to_string();
        conn.config.database = database.clone();
        raw_pool_query(&conn.pool, "CREATE TEMPORARY TABLE import_test (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL, amount DECIMAL(12,2), at DATETIME, created TIMESTAMP DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET utf8mb4; CREATE TEMPORARY TABLE import_myisam (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL) ENGINE=MyISAM").await.unwrap();
        let t = TableInfo {
            name: "import_test".into(),
            schema: database.clone(),
            kind: "table".into(),
        };
        let info = target_info(&conn, &t).await.unwrap();
        assert_eq!(info.primary_keys, ["id"]);
        assert!(info.transactional);
        assert!(info
            .columns
            .iter()
            .any(|c| c.name == "created" && c.has_default && !c.generated));
        let flag = AtomicBool::new(false);
        let control = RunControl {
            cancel: &flag,
            progress: &|_| {},
            max_rows: MAX_IMPORT_ROWS,
        };
        let mapping = [
            ("id", "id"),
            ("name", "name"),
            ("amount", "amount"),
            ("at", "at"),
        ];
        let path = live_file(
            "id,name,amount,at\n1,\"Café \\ \"\"q\"\"\",12.5,2026-10-18 09:30:00\n2,b,,\n",
        );
        let summary = run_import(
            &conn,
            &t,
            &path,
            &request(options(ImportFormat::Csv), &mapping, "append"),
            &control,
        )
        .await
        .unwrap();
        assert_eq!(summary.inserted, 2);
        let got = query(
            &conn.pool,
            "SELECT name, CAST(amount AS CHAR), CAST(at AS CHAR) FROM import_test ORDER BY id",
        )
        .await
        .unwrap()
        .rows;
        assert_eq!(
            got[0],
            vec![
                json!("Café \\ \"q\""),
                json!("12.50"),
                json!("2026-10-18 09:30:00")
            ]
        );
        let upsert = live_file("id,name\n2,two\n3,three\n");
        let summary = run_import(
            &conn,
            &t,
            &upsert,
            &request(options(ImportFormat::Csv), &mapping[..2], "upsert"),
            &control,
        )
        .await
        .unwrap();
        assert_eq!((summary.inserted, summary.updated), (1, 1));
        let update = live_file("id,name\n3,THREE\n9,none\n");
        let summary = run_import(
            &conn,
            &t,
            &update,
            &request(options(ImportFormat::Csv), &mapping[..2], "update"),
            &control,
        )
        .await
        .unwrap();
        assert_eq!((summary.updated, summary.skipped), (1, 1));
        let dup = live_file("id,name\n20,a\n1,dup\n");
        let error = run_import(
            &conn,
            &t,
            &dup,
            &request(options(ImportFormat::Csv), &mapping[..2], "append"),
            &control,
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("Row 2: Duplicate entry"), "{error}");
        assert_eq!(row_count(&conn, &t).await.unwrap(), 3);
        let m = TableInfo {
            name: "import_myisam".into(),
            schema: database,
            kind: "table".into(),
        };
        assert!(!target_info(&conn, &m).await.unwrap().transactional);
        let error = run_import(
            &conn,
            &m,
            &upsert,
            &request(options(ImportFormat::Csv), &mapping[..2], "append"),
            &control,
        )
        .await
        .unwrap_err();
        assert!(error.contains("cannot roll back"), "{error}");
        let mut r = request(options(ImportFormat::Csv), &mapping[..2], "append");
        r.continue_on_error = true;
        let summary = run_import(&conn, &m, &dup, &r, &control).await.unwrap();
        assert_eq!(summary.inserted, 2);
        let summary = run_import(&conn, &m, &dup, &r, &control).await.unwrap();
        assert_eq!((summary.inserted, summary.failed), (0, 2));
        raw_pool_query(
            &conn.pool,
            "DROP TEMPORARY TABLE import_test; DROP TEMPORARY TABLE import_myisam",
        )
        .await
        .unwrap();
        for p in [path, upsert, update, dup] {
            std::fs::remove_file(p).unwrap();
        }
    }
}
