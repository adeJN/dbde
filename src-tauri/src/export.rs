// Export wizard backend: streams rows from the database straight into a file the user
// picked in the native save dialog. Rows never pass through the webview (except the
// selected or fetched rows of a grid, which it already holds) and are never collected
// in memory, so tables of any size export at a steady footprint.
use super::*;
use rows::{qualified, quote, TableFilter, TableSort};
use rust_xlsxwriter::{Workbook, Worksheet};
use std::{
    borrow::Cow,
    fs::File,
    io::{BufWriter, Write},
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::ipc::Channel;
use tauri_plugin_dialog::DialogExt;

const MAX_COLUMNS: usize = 4096;
const PROGRESS_EVERY: u64 = 1000;
// How often a stream waiting for the next row checks for cancellation.
const POLL: Duration = Duration::from_millis(200);
// Exports get at least five minutes per row wait (a large sort can take a while to
// produce its first row); a longer per-connection query timeout is honoured.
const MIN_STALL_SECS: u64 = 300;
const XLSX_MAX_ROWS: u32 = 1_048_576;
const XLSX_MAX_COLUMNS: usize = 16_384;
const XLSX_MAX_TEXT: usize = 32_767;
const CANCELLED: &str = "Export cancelled.";

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ExportFormat {
    Csv,
    Tsv,
    Json,
    Xlsx,
    Sql,
}
impl ExportFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Csv => "csv",
            Self::Tsv => "tsv",
            Self::Json => "json",
            Self::Xlsx => "xlsx",
            Self::Sql => "sql",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Self::Csv => "CSV",
            Self::Tsv => "TSV",
            Self::Json => "JSON",
            Self::Xlsx => "Excel workbook",
            Self::Sql => "SQL",
        }
    }
}
fn yes() -> bool {
    true
}
fn default_delimiter() -> String {
    ",".into()
}
fn default_quote() -> String {
    "\"".into()
}
fn default_batch() -> u32 {
    100
}
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ExportOptions {
    format: ExportFormat,
    /// Columns to write, in order. Table exports require each to exist in the table.
    columns: Vec<String>,
    #[serde(default = "yes")]
    header: bool,
    #[serde(default = "default_delimiter")]
    delimiter: String,
    #[serde(default = "default_quote")]
    quote: String,
    /// Written for NULL in CSV, TSV and Excel; empty by default.
    #[serde(default)]
    null_text: String,
    #[serde(default = "yes")]
    protect_formulas: bool,
    /// UTF-8 byte order mark for CSV/TSV, so Excel detects the encoding.
    #[serde(default)]
    bom: bool,
    #[serde(default)]
    create_table: bool,
    #[serde(default = "default_batch")]
    batch_size: u32,
    /// INSERT target for query results that have no source table.
    #[serde(default)]
    table_name: Option<String>,
}
#[derive(Clone)]
struct Plan {
    format: ExportFormat,
    header: bool,
    delimiter: char,
    quote: char,
    null_text: String,
    protect: bool,
    bom: bool,
    batch_size: usize,
}
fn single_char(value: &str, what: &str) -> DbResult<char> {
    let mut chars = value.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if !matches!(c, '\r' | '\n' | '\0') => Ok(c),
        _ => Err(format!(
            "The {what} must be a single character other than a line break."
        )),
    }
}
impl ExportOptions {
    fn plan(&self) -> DbResult<Plan> {
        if self.columns.is_empty() {
            return Err("Choose at least one column to export.".into());
        }
        if self.columns.len() > MAX_COLUMNS {
            return Err(format!("Export at most {MAX_COLUMNS} columns."));
        }
        if self
            .columns
            .iter()
            .any(|c| c.is_empty() || c.len() > 1024 || c.contains('\0'))
        {
            return Err("Invalid column name".into());
        }
        if self.format == ExportFormat::Xlsx && self.columns.len() > XLSX_MAX_COLUMNS {
            return Err(format!(
                "Excel sheets hold at most {XLSX_MAX_COLUMNS} columns."
            ));
        }
        let delimiter = if self.format == ExportFormat::Tsv {
            '\t'
        } else {
            single_char(&self.delimiter, "delimiter")?
        };
        let quote = single_char(&self.quote, "quote character")?;
        if quote == delimiter {
            return Err("The quote character must differ from the delimiter.".into());
        }
        if self.null_text.chars().count() > 64 || self.null_text.contains(['\r', '\n', '\0']) {
            return Err("NULL text must be at most 64 characters on one line.".into());
        }
        if !(1..=1000).contains(&self.batch_size) {
            return Err("Rows per INSERT must be between 1 and 1,000.".into());
        }
        if self.create_table && self.format != ExportFormat::Sql {
            return Err("CREATE TABLE is only written by SQL exports.".into());
        }
        Ok(Plan {
            format: self.format,
            header: self.header,
            delimiter,
            quote,
            null_text: self.null_text.clone(),
            protect: self.protect_formulas,
            bom: self.bom,
            batch_size: self.batch_size as usize,
        })
    }
}

// Values arrive as the grid's JSON cells. Binary cells are {"hex": "..."}; only real hex
// counts, because rows exported from the grid come from the webview.
fn binary_hex(value: &Value) -> Option<&str> {
    match value {
        Value::Object(map) if map.len() == 1 => {
            map.get("hex").and_then(Value::as_str).filter(|hex| {
                hex.len().is_multiple_of(2) && hex.bytes().all(|b| b.is_ascii_hexdigit())
            })
        }
        _ => None,
    }
}
fn is_deferred(value: &Value) -> bool {
    matches!(value, Value::Object(map) if map.contains_key("deferred"))
}
/// The text written for a cell, or None for NULL. Dates and times are already the text
/// the database stored; binary becomes 0x-prefixed hex.
fn cell_text(value: &Value) -> Option<Cow<'_, str>> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(Cow::Borrowed(text)),
        Value::Bool(b) => Some(Cow::Borrowed(if *b { "true" } else { "false" })),
        Value::Number(n) => Some(Cow::Owned(n.to_string())),
        other => Some(Cow::Owned(match binary_hex(other) {
            Some(hex) => format!("0x{hex}"),
            None => other.to_string(),
        })),
    }
}
fn digits(bytes: &[u8], at: &mut usize) -> bool {
    let start = *at;
    while bytes.get(*at).is_some_and(u8::is_ascii_digit) {
        *at += 1;
    }
    *at > start
}
// ^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$, as in spreadsheetText (src/lib/sql.ts).
fn plain_number(text: &str) -> bool {
    let b = text.as_bytes();
    let mut i = 0;
    if matches!(b.first(), Some(b'+' | b'-')) {
        i += 1;
    }
    if !digits(b, &mut i) {
        return false;
    }
    if b.get(i) == Some(&b'.') {
        i += 1;
        if !digits(b, &mut i) {
            return false;
        }
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        if !digits(b, &mut i) {
            return false;
        }
    }
    i == b.len()
}
/// Same rule as the grid's clipboard and CSV: text a spreadsheet would evaluate as a
/// formula gets a leading apostrophe; plain numbers such as -12.50 stay intact.
pub(crate) fn spreadsheet_text(text: &str) -> Cow<'_, str> {
    if text.starts_with(['=', '+', '-', '@', '\t', '\r']) && !plain_number(text) {
        Cow::Owned(format!("'{text}"))
    } else {
        Cow::Borrowed(text)
    }
}
/// A SQL literal in the target dialect, matching sqlLiteral in src/lib/grid.ts.
fn sql_literal(value: &Value, driver: &Driver) -> String {
    match value {
        Value::Null => "NULL".into(),
        Value::Bool(b) => match (driver, b) {
            (Driver::Sqlite, true) => "1".into(),
            (Driver::Sqlite, false) => "0".into(),
            (_, true) => "TRUE".into(),
            (_, false) => "FALSE".into(),
        },
        Value::Number(n) => n.to_string(),
        other => {
            if let Some(hex) = binary_hex(other) {
                return if matches!(driver, Driver::Postgres) {
                    format!("'\\x{hex}'::bytea")
                } else {
                    format!("X'{hex}'")
                };
            }
            let text = cell_text(other).unwrap_or_default();
            // MySQL treats backslashes in strings as escapes by default; the others do not.
            let escaped = if matches!(driver, Driver::Mysql) {
                text.replace('\\', "\\\\")
                    .replace('\'', "''")
                    .replace('\0', "\\0")
            } else {
                text.replace('\'', "''")
            };
            format!("'{escaped}'")
        }
    }
}

struct SqlTarget {
    target: String,
    driver: Driver,
    ddl: Option<String>,
}
enum Body {
    Delimited,
    Json {
        first: bool,
    },
    Sql {
        target: String,
        names: String,
        driver: Driver,
        pending: Vec<String>,
    },
}
/// CSV, TSV, JSON and SQL writers over any byte sink.
struct TextExport<W: Write> {
    out: W,
    plan: Plan,
    columns: Vec<String>,
    body: Body,
}
impl<W: Write> TextExport<W> {
    fn start(mut out: W, plan: Plan, columns: &[String], sql: Option<SqlTarget>) -> DbResult<Self> {
        let body = match plan.format {
            ExportFormat::Csv | ExportFormat::Tsv => Body::Delimited,
            ExportFormat::Json => Body::Json { first: true },
            ExportFormat::Sql => {
                let sql = sql.ok_or("A target table name is required for SQL exports.")?;
                if let Some(ddl) = &sql.ddl {
                    write!(out, "{}\n\n", ddl.trim_end()).map_err(err)?;
                }
                Body::Sql {
                    names: columns
                        .iter()
                        .map(|c| quote(c, &sql.driver))
                        .collect::<Vec<_>>()
                        .join(", "),
                    target: sql.target,
                    driver: sql.driver,
                    pending: Vec::new(),
                }
            }
            ExportFormat::Xlsx => return Err("Excel exports use the workbook writer".into()),
        };
        let mut export = Self {
            out,
            plan,
            columns: columns.to_vec(),
            body,
        };
        match export.body {
            Body::Delimited => {
                if export.plan.bom {
                    export.out.write_all("\u{feff}".as_bytes()).map_err(err)?;
                }
                if export.plan.header {
                    let mut line = String::new();
                    for (i, name) in export.columns.iter().enumerate() {
                        if i > 0 {
                            line.push(export.plan.delimiter);
                        }
                        export.field(&export.protected(name), &mut line);
                    }
                    line.push_str("\r\n");
                    export.out.write_all(line.as_bytes()).map_err(err)?;
                }
            }
            Body::Json { .. } => export.out.write_all(b"[").map_err(err)?,
            Body::Sql { .. } => {}
        }
        Ok(export)
    }
    fn protected<'a>(&self, text: &'a str) -> Cow<'a, str> {
        if self.plan.protect {
            spreadsheet_text(text)
        } else {
            Cow::Borrowed(text)
        }
    }
    // Quotes only when needed; an empty string is quoted so it differs from NULL.
    fn field(&self, text: &str, line: &mut String) {
        let (d, q) = (self.plan.delimiter, self.plan.quote);
        if text.is_empty() || text.contains([d, q, '\r', '\n']) {
            line.push(q);
            for c in text.chars() {
                if c == q {
                    line.push(q);
                }
                line.push(c);
            }
            line.push(q);
        } else {
            line.push_str(text);
        }
    }
    fn row(&mut self, values: &[Value]) -> DbResult<()> {
        match &mut self.body {
            Body::Delimited => {
                let mut line = String::new();
                for (i, value) in values.iter().enumerate() {
                    if i > 0 {
                        line.push(self.plan.delimiter);
                    }
                    match cell_text(value) {
                        None if self.plan.null_text.is_empty() => {}
                        None => self.field(&self.plan.null_text, &mut line),
                        Some(text) => self.field(&self.protected(&text), &mut line),
                    }
                }
                line.push_str("\r\n");
                self.out.write_all(line.as_bytes()).map_err(err)
            }
            Body::Json { first } => {
                self.out
                    .write_all(if *first { b"\n{" } else { b",\n{" })
                    .map_err(err)?;
                *first = false;
                for (i, (name, value)) in self.columns.iter().zip(values).enumerate() {
                    if i > 0 {
                        self.out.write_all(b",").map_err(err)?;
                    }
                    serde_json::to_writer(&mut self.out, name).map_err(err)?;
                    self.out.write_all(b":").map_err(err)?;
                    let written = match binary_hex(value) {
                        Some(hex) => serde_json::to_writer(&mut self.out, &format!("0x{hex}")),
                        None => serde_json::to_writer(&mut self.out, value),
                    };
                    written.map_err(err)?;
                }
                self.out.write_all(b"}").map_err(err)
            }
            Body::Sql {
                driver, pending, ..
            } => {
                let literals: Vec<String> = values.iter().map(|v| sql_literal(v, driver)).collect();
                pending.push(format!("({})", literals.join(", ")));
                if pending.len() >= self.plan.batch_size {
                    self.flush_inserts()?;
                }
                Ok(())
            }
        }
    }
    fn flush_inserts(&mut self) -> DbResult<()> {
        let Body::Sql {
            target,
            names,
            pending,
            ..
        } = &mut self.body
        else {
            return Ok(());
        };
        if pending.is_empty() {
            return Ok(());
        }
        let statement = if pending.len() == 1 {
            format!("INSERT INTO {target} ({names}) VALUES {};\n", pending[0])
        } else {
            format!(
                "INSERT INTO {target} ({names}) VALUES\n  {};\n",
                pending.join(",\n  ")
            )
        };
        pending.clear();
        self.out.write_all(statement.as_bytes()).map_err(err)
    }
    fn finish(mut self) -> DbResult<W> {
        match &self.body {
            Body::Json { first } => {
                let end: &[u8] = if *first { b"]\n" } else { b"\n]\n" };
                self.out.write_all(end).map_err(err)?;
            }
            Body::Sql { .. } => self.flush_inserts()?,
            Body::Delimited => {}
        }
        self.out.flush().map_err(err)?;
        Ok(self.out)
    }
}

/// Excel writer in constant-memory mode: each finished row goes to a temp file.
struct XlsxExport {
    workbook: Workbook,
    plan: Plan,
    columns: Vec<String>,
    sheet: usize,
    row: u32,
    sheet_rows: u32,
    truncated: u64,
}
fn excel_text<'a>(text: &'a str, truncated: &mut u64) -> Cow<'a, str> {
    match text.char_indices().nth(XLSX_MAX_TEXT) {
        Some((end, _)) => {
            *truncated += 1;
            Cow::Borrowed(&text[..end])
        }
        None => Cow::Borrowed(text),
    }
}
impl XlsxExport {
    fn start(plan: Plan, columns: &[String], sheet_rows: u32) -> DbResult<Self> {
        let mut workbook = Workbook::new();
        workbook.add_worksheet_with_constant_memory();
        let mut export = Self {
            workbook,
            plan,
            columns: columns.to_vec(),
            sheet: 0,
            row: 0,
            sheet_rows,
            truncated: 0,
        };
        export.header()?;
        Ok(export)
    }
    fn worksheet(workbook: &mut Workbook, index: usize) -> DbResult<&mut Worksheet> {
        workbook.worksheet_from_index(index).map_err(err)
    }
    fn header(&mut self) -> DbResult<()> {
        self.row = 0;
        if !self.plan.header {
            return Ok(());
        }
        let sheet = Self::worksheet(&mut self.workbook, self.sheet)?;
        for (i, name) in self.columns.iter().enumerate() {
            sheet
                .write_string(0, i as u16, excel_text(name, &mut self.truncated))
                .map_err(err)?;
        }
        self.row = 1;
        Ok(())
    }
    fn row(&mut self, values: &[Value]) -> DbResult<()> {
        // A full sheet continues on the next one, with its own header row.
        if self.row >= self.sheet_rows {
            self.workbook.add_worksheet_with_constant_memory();
            self.sheet += 1;
            self.header()?;
        }
        let row = self.row;
        let sheet = Self::worksheet(&mut self.workbook, self.sheet)?;
        for (i, value) in values.iter().enumerate() {
            let col = i as u16;
            let written = match value {
                Value::Null if self.plan.null_text.is_empty() => continue,
                Value::Null => sheet.write_string(row, col, &self.plan.null_text),
                Value::Bool(b) => sheet.write_boolean(row, col, *b),
                Value::Number(n) => match n.as_f64() {
                    Some(number) if number.is_finite() => sheet.write_number(row, col, number),
                    _ => sheet.write_string(row, col, n.to_string()),
                },
                other => {
                    // Strings are written as text cells, which Excel never evaluates.
                    let text = cell_text(other).unwrap_or_default();
                    sheet.write_string(row, col, excel_text(&text, &mut self.truncated))
                }
            };
            written.map_err(err)?;
        }
        self.row += 1;
        Ok(())
    }
}
enum Output {
    Text(TextExport<BufWriter<File>>),
    Xlsx(Box<XlsxExport>),
}
impl Output {
    fn open(
        path: &Path,
        plan: &Plan,
        columns: &[String],
        sql: Option<SqlTarget>,
    ) -> DbResult<Self> {
        if plan.format == ExportFormat::Xlsx {
            return Ok(Self::Xlsx(Box::new(XlsxExport::start(
                plan.clone(),
                columns,
                XLSX_MAX_ROWS,
            )?)));
        }
        let file = File::create(path).map_err(err)?;
        Ok(Self::Text(TextExport::start(
            BufWriter::with_capacity(256 * 1024, file),
            plan.clone(),
            columns,
            sql,
        )?))
    }
    fn row(&mut self, values: &[Value]) -> DbResult<()> {
        match self {
            Self::Text(export) => export.row(values),
            Self::Xlsx(export) => export.row(values),
        }
    }
    /// Sheets used and Excel cells shortened to the cell limit.
    async fn finish(self, path: &Path) -> DbResult<(u32, u64)> {
        match self {
            Self::Text(export) => {
                export
                    .finish()?
                    .into_inner()
                    .map_err(err)?
                    .sync_all()
                    .map_err(err)?;
                Ok((1, 0))
            }
            Self::Xlsx(mut export) => {
                let path = path.to_path_buf();
                // Compressing a large workbook takes a while; keep it off the async workers.
                tokio::task::spawn_blocking(move || {
                    export.workbook.save(&path).map_err(err)?;
                    Ok::<_, String>((export.sheet as u32 + 1, export.truncated))
                })
                .await
                .map_err(err)?
            }
        }
    }
}

pub(crate) struct Control<'a> {
    pub cancel: &'a AtomicBool,
    pub progress: &'a (dyn Fn(u64) + Send + Sync),
    pub stall: Duration,
}
#[derive(Debug, Serialize)]
pub(crate) struct ExportSummary {
    path: String,
    rows: u64,
    sheets: u32,
    truncated_cells: u64,
}
enum Source<'a> {
    Table {
        conn: &'a Connection,
        table: &'a TableInfo,
        filters: &'a [TableFilter],
        sort: Option<&'a TableSort>,
    },
    Rows(&'a [Vec<Value>]),
}
async fn drain<R, S>(
    mut stream: S,
    cell: fn(&R, usize) -> DbResult<Value>,
    out: &mut Output,
    control: &Control<'_>,
) -> DbResult<u64>
where
    R: sqlx::Row,
    S: futures_util::Stream<Item = Result<R, sqlx::Error>> + Unpin,
{
    let mut count = 0u64;
    let mut waited = Duration::ZERO;
    loop {
        if control.cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        // Waiting in short slices keeps Cancel responsive while the server is still
        // working on the first row; a dropped try_next() loses no rows.
        let row = match tokio::time::timeout(POLL, stream.try_next()).await {
            Err(_) => {
                waited += POLL;
                if waited >= control.stall {
                    return Err(format!(
                        "No rows arrived for {} seconds, so the export was stopped.",
                        control.stall.as_secs()
                    ));
                }
                continue;
            }
            Ok(row) => row.map_err(err)?,
        };
        let Some(row) = row else { break };
        waited = Duration::ZERO;
        let values = (0..row.len())
            .map(|i| cell(&row, i))
            .collect::<DbResult<Vec<_>>>()?;
        out.row(&values)?;
        count += 1;
        if count.is_multiple_of(PROGRESS_EVERY) {
            (control.progress)(count);
        }
    }
    Ok(count)
}
async fn feed(
    source: &Source<'_>,
    columns: &[String],
    out: &mut Output,
    control: &Control<'_>,
) -> DbResult<u64> {
    let (conn, table, filters, sort) = match source {
        Source::Rows(rows) => {
            let mut count = 0u64;
            for chunk in rows.chunks(PROGRESS_EVERY as usize) {
                if control.cancel.load(Ordering::Relaxed) {
                    return Err(CANCELLED.into());
                }
                for row in chunk {
                    out.row(row)?;
                }
                count += chunk.len() as u64;
                (control.progress)(count);
            }
            return Ok(count);
        }
        Source::Table {
            conn,
            table,
            filters,
            sort,
        } => (*conn, *table, *filters, *sort),
    };
    let driver = &conn.config.driver;
    let target = qualified(table, driver);
    let all = rows::columns_of(conn, &target).await?;
    if sort.is_some_and(|item| !all.iter().any(|c| c == item.column())) {
        return Err("Unknown sort column".into());
    }
    // The same WHERE and ORDER BY as the grid, so the file matches what it shows.
    // PostgreSQL reads use the text protocol (as the grid does) so every type renders;
    // its filter values are hex-encoded literals that no input can break out of.
    let text_protocol = matches!(driver, Driver::Postgres);
    let (where_sql, values) = rows::filter_clause(filters, driver, &all, text_protocol)?;
    let keys = rows::primary_keys(conn, table).await.unwrap_or_default();
    let order = rows::order_clause(sort, &keys, driver);
    let projection = columns
        .iter()
        .map(|c| quote(c, driver))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!("SELECT {projection} FROM {target}{where_sql}{order}");
    match &conn.pool {
        Pool::Pg(p) => drain(sqlx::raw_sql(&sql).fetch(p), pg_cell, out, control).await,
        Pool::My(p) => {
            let mut statement = sqlx::query(&sql);
            for value in &values {
                statement = statement.bind(value);
            }
            drain(statement.fetch(p), my_cell, out, control).await
        }
        Pool::Lite(p) => {
            let mut statement = sqlx::query(&sql);
            for value in &values {
                statement = statement.bind(value);
            }
            drain(statement.fetch(p), lite_cell, out, control).await
        }
    }
}
// Written beside the destination and renamed into place when complete, so a cancelled
// or failed export leaves no partial file and never clobbers an existing one.
fn partial_path(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "export".into());
    let suffix = &uuid::Uuid::new_v4().simple().to_string()[..8];
    path.with_file_name(format!(".{name}.{suffix}.dbde-partial"))
}
async fn export_to(
    path: &Path,
    plan: &Plan,
    columns: &[String],
    sql: Option<SqlTarget>,
    source: Source<'_>,
    control: &Control<'_>,
) -> DbResult<ExportSummary> {
    let partial = partial_path(path);
    let result = async {
        let mut out = Output::open(&partial, plan, columns, sql)?;
        let rows = feed(&source, columns, &mut out, control).await?;
        if control.cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.to_string());
        }
        let (sheets, truncated_cells) = out.finish(&partial).await?;
        (control.progress)(rows);
        Ok((rows, sheets, truncated_cells))
    }
    .await;
    let result = result.and_then(|summary| {
        std::fs::rename(&partial, path).map_err(err)?;
        Ok(summary)
    });
    match result {
        Ok((rows, sheets, truncated_cells)) => Ok(ExportSummary {
            path: path.display().to_string(),
            rows,
            sheets,
            truncated_cells,
        }),
        Err(error) => {
            let _ = std::fs::remove_file(&partial);
            Err(error)
        }
    }
}
fn check_columns(requested: &[String], available: &[String]) -> DbResult<()> {
    let mut seen = std::collections::HashSet::new();
    for name in requested {
        if !available.contains(name) {
            return Err(format!("Unknown column {name}"));
        }
        if !seen.insert(name) {
            return Err(format!("Column {name} is listed twice"));
        }
    }
    Ok(())
}
fn check_rows(rows: &[Vec<Value>], width: usize) -> DbResult<()> {
    if rows.len() > MAX_ROWS {
        return Err(format!("Export at most {MAX_ROWS} fetched rows at once."));
    }
    if rows.iter().any(|row| row.len() != width) {
        return Err("Every row must have one value per exported column.".into());
    }
    if rows.iter().flatten().any(is_deferred) {
        return Err(
            "Some values were not loaded (Quick mode). Use Open Table to export complete data."
                .into(),
        );
    }
    Ok(())
}
fn sql_name(name: &str) -> DbResult<&str> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 128 || name.contains('\0') {
        return Err(
            "Enter a table name (at most 128 characters) for the INSERT statements.".into(),
        );
    }
    Ok(name)
}
/// A file name from the table name: no path separators or characters Windows rejects.
fn default_file_name(name: &str, format: ExportFormat) -> String {
    let stem: String = name
        .chars()
        .map(|c| {
            if c.is_control() || r#"/\:*?"<>|"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .take(120)
        .collect();
    let stem = stem.trim().trim_start_matches('.');
    let stem = if stem.is_empty() { "export" } else { stem };
    format!("{stem}.{}", format.extension())
}
fn stall_limit(conn: &Connection) -> Duration {
    Duration::from_secs(
        conn.config
            .options
            .query_timeout_secs
            .unwrap_or(DEADLINE.as_secs())
            .clamp(MIN_STALL_SECS, MAX_QUERY_TIMEOUT_SECS),
    )
}

/// Cancellation flags of running exports, keyed by an ID the webview chose.
#[derive(Default)]
pub(crate) struct Exports(std::sync::Mutex<HashMap<String, Arc<AtomicBool>>>);
struct Running<'a> {
    exports: &'a Exports,
    id: String,
    flag: Arc<AtomicBool>,
}
impl Exports {
    pub(crate) fn is_busy(&self) -> DbResult<bool> {
        Ok(!self.0.lock().map_err(err)?.is_empty())
    }

    fn register(&self, id: &str) -> DbResult<Running<'_>> {
        if id.is_empty()
            || id.len() > 64
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err("Invalid export ID".into());
        }
        let flag = Arc::new(AtomicBool::new(false));
        let mut running = self.0.lock().map_err(err)?;
        if running.contains_key(id) {
            return Err("This export is already running".into());
        }
        running.insert(id.into(), flag.clone());
        Ok(Running {
            exports: self,
            id: id.into(),
            flag,
        })
    }
}
impl Drop for Running<'_> {
    fn drop(&mut self) {
        if let Ok(mut running) = self.exports.0.lock() {
            running.remove(&self.id);
        }
    }
}
#[derive(Clone, Serialize)]
pub(crate) struct ExportProgress {
    rows: u64,
}
// The webview never chooses a path: Rust shows the native save dialog (as dbde_save_file).
async fn pick_path(
    app: tauri::AppHandle,
    name: String,
    format: ExportFormat,
) -> DbResult<Option<PathBuf>> {
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(&name)
            .add_filter(format.label(), &[format.extension()])
            .blocking_save_file()
    })
    .await
    .map_err(err)?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let mut path = path.into_path().map_err(err)?;
    if path.extension().is_none() {
        path.set_extension(format.extension());
    }
    Ok(Some(path))
}
// A cancelled export, like a cancelled save dialog, resolves to None.
fn summary_or_cancel(result: DbResult<ExportSummary>) -> DbResult<Option<ExportSummary>> {
    match result {
        Ok(summary) => Ok(Some(summary)),
        Err(error) if error == CANCELLED => Ok(None),
        Err(error) => Err(error),
    }
}
/// Exports a whole table, or the rows matching the grid's filters and sort.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Each argument is a named IPC field from the webview.
pub(crate) async fn dbde_export_table(
    app: tauri::AppHandle,
    connection_id: String,
    database: String,
    table: TableInfo,
    options: ExportOptions,
    filters: Option<Vec<TableFilter>>,
    sort: Option<TableSort>,
    export_id: String,
    on_progress: Channel<ExportProgress>,
    state: State<'_, AppState>,
    exports: State<'_, Exports>,
) -> DbResult<Option<ExportSummary>> {
    let plan = options.plan()?;
    let running = exports.register(&export_id)?;
    let filters = filters.unwrap_or_default();
    let conn = timed(database_connection(&state, &connection_id, Some(&database))).await?;
    let driver = conn.config.driver.clone();
    let target = qualified(&table, &driver);
    let available = timed(rows::columns_of(&conn, &target)).await?;
    check_columns(&options.columns, &available)?;
    let sql = if plan.format == ExportFormat::Sql {
        let ddl = if options.create_table {
            if table.kind == "view" {
                return Err("CREATE TABLE is not available when exporting a view.".into());
            }
            Some(timed(schema::table_ddl(&conn, &table, false)).await?)
        } else {
            None
        };
        Some(SqlTarget {
            target,
            driver,
            ddl,
        })
    } else {
        None
    };
    let Some(path) = pick_path(
        app,
        default_file_name(&table.name, plan.format),
        plan.format,
    )
    .await?
    else {
        return Ok(None);
    };
    let progress = move |rows| {
        let _ = on_progress.send(ExportProgress { rows });
    };
    let control = Control {
        cancel: &running.flag,
        progress: &progress,
        stall: stall_limit(&conn),
    };
    let source = Source::Table {
        conn: &conn,
        table: &table,
        filters: &filters,
        sort: sort.as_ref(),
    };
    summary_or_cancel(export_to(&path, &plan, &options.columns, sql, source, &control).await)
}
/// Exports rows the grid already holds: selected rows, or a query's fetched result.
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Each argument is a named IPC field from the webview.
pub(crate) async fn dbde_export_rows(
    app: tauri::AppHandle,
    connection_id: String,
    database: Option<String>,
    table: Option<TableInfo>,
    options: ExportOptions,
    rows: Vec<Vec<Value>>,
    export_id: String,
    on_progress: Channel<ExportProgress>,
    state: State<'_, AppState>,
    exports: State<'_, Exports>,
) -> DbResult<Option<ExportSummary>> {
    let plan = options.plan()?;
    check_rows(&rows, options.columns.len())?;
    let running = exports.register(&export_id)?;
    let sql = if plan.format == ExportFormat::Sql {
        let conn = timed(database_connection(
            &state,
            &connection_id,
            database.as_deref(),
        ))
        .await?;
        let driver = conn.config.driver.clone();
        let (target, ddl) = match &table {
            Some(table) => {
                let ddl = if options.create_table {
                    if table.kind == "view" {
                        return Err("CREATE TABLE is not available when exporting a view.".into());
                    }
                    Some(timed(schema::table_ddl(&conn, table, false)).await?)
                } else {
                    None
                };
                (qualified(table, &driver), ddl)
            }
            None if options.create_table => {
                return Err("CREATE TABLE needs a source table; query results have none.".into())
            }
            None => (
                quote(
                    sql_name(options.table_name.as_deref().unwrap_or_default())?,
                    &driver,
                ),
                None,
            ),
        };
        Some(SqlTarget {
            target,
            driver,
            ddl,
        })
    } else {
        None
    };
    let name = table
        .as_ref()
        .map(|t| t.name.as_str())
        .unwrap_or("dbde-results");
    let Some(path) = pick_path(app, default_file_name(name, plan.format), plan.format).await?
    else {
        return Ok(None);
    };
    let progress = move |rows| {
        let _ = on_progress.send(ExportProgress { rows });
    };
    let control = Control {
        cancel: &running.flag,
        progress: &progress,
        stall: Duration::from_secs(MIN_STALL_SECS),
    };
    summary_or_cancel(
        export_to(
            &path,
            &plan,
            &options.columns,
            sql,
            Source::Rows(&rows),
            &control,
        )
        .await,
    )
}
#[tauri::command]
pub(crate) fn dbde_cancel_export(export_id: String, exports: State<'_, Exports>) -> DbResult<()> {
    if let Some(flag) = exports.0.lock().map_err(err)?.get(&export_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn options(format: ExportFormat, columns: &[&str]) -> ExportOptions {
        serde_json::from_value(json!({ "format": format_name(format), "columns": columns }))
            .unwrap()
    }
    fn format_name(format: ExportFormat) -> &'static str {
        match format {
            ExportFormat::Csv => "csv",
            ExportFormat::Tsv => "tsv",
            ExportFormat::Json => "json",
            ExportFormat::Xlsx => "xlsx",
            ExportFormat::Sql => "sql",
        }
    }
    fn text_export(options: &ExportOptions, rows: &[Vec<Value>], sql: Option<SqlTarget>) -> String {
        let mut export =
            TextExport::start(Vec::new(), options.plan().unwrap(), &options.columns, sql).unwrap();
        for row in rows {
            export.row(row).unwrap();
        }
        String::from_utf8(export.finish().unwrap()).unwrap()
    }
    fn quiet() -> (AtomicBool, impl Fn(u64) + Send + Sync) {
        (AtomicBool::new(false), |_| {})
    }
    fn temp_file(ext: &str) -> PathBuf {
        std::env::temp_dir().join(format!("dbde-export-{}.{ext}", uuid::Uuid::new_v4()))
    }
    fn leftovers(path: &Path) -> Vec<String> {
        let prefix = format!(".{}", path.file_name().unwrap().to_string_lossy());
        std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.starts_with(&prefix))
            .collect()
    }

    #[test]
    fn formula_protection_matches_the_grid() {
        for (input, expected) in [
            ("=SUM(A1)", "'=SUM(A1)"),
            ("+62 812", "'+62 812"),
            ("-12.50", "-12.50"),
            ("+62", "+62"),
            ("-1e5", "-1e5"),
            ("-1.", "'-1."),
            ("@cmd", "'@cmd"),
            ("\tx", "'\tx"),
            ("\rx", "'\rx"),
            ("plain", "plain"),
            ("", ""),
        ] {
            assert_eq!(spreadsheet_text(input), expected, "{input:?}");
        }
    }
    #[test]
    fn options_are_validated() {
        let mut o = options(ExportFormat::Csv, &["id"]);
        assert!(o.plan().is_ok());
        o.delimiter = ";;".into();
        assert!(o.plan().is_err());
        o.delimiter = "\n".into();
        assert!(o.plan().is_err());
        o.delimiter = "\"".into();
        assert!(o.plan().is_err(), "quote equal to delimiter");
        o.delimiter = ";".into();
        o.batch_size = 0;
        assert!(o.plan().is_err());
        o.batch_size = 1001;
        assert!(o.plan().is_err());
        o.batch_size = 10;
        o.null_text = "a\nb".into();
        assert!(o.plan().is_err());
        o.null_text = "NULL".into();
        o.create_table = true;
        assert!(o.plan().is_err(), "CREATE TABLE only for SQL");
        o.create_table = false;
        o.columns.clear();
        assert!(o.plan().is_err());
        assert!(serde_json::from_value::<ExportOptions>(
            json!({"format": "pdf", "columns": ["id"]})
        )
        .is_err());
        assert!(serde_json::from_value::<ExportOptions>(
            json!({"format": "csv", "columns": ["id"], "path": "/tmp/x"})
        )
        .is_err());
        let tsv = options(ExportFormat::Tsv, &["id"]).plan().unwrap();
        assert_eq!(tsv.delimiter, '\t');
        assert!(check_columns(&["id".into(), "id".into()], &["id".into()]).is_err());
        assert!(check_columns(&["nope".into()], &["id".into()]).is_err());
        assert!(check_rows(&[vec![json!(1)]], 2).is_err());
        assert!(check_rows(&[vec![json!({"deferred": true})]], 1).is_err());
    }
    #[test]
    fn delimited_output_quotes_only_when_needed() {
        let rows = vec![
            vec![json!(1), json!("a,b"), json!("say \"hi\""), Value::Null],
            vec![
                json!(2),
                json!("line\nbreak"),
                json!(""),
                json!({"hex": "00ff"}),
            ],
        ];
        let mut o = options(ExportFormat::Csv, &["id", "a", "b", "c"]);
        assert_eq!(
            text_export(&o, &rows, None),
            "id,a,b,c\r\n1,\"a,b\",\"say \"\"hi\"\"\",\r\n2,\"line\nbreak\",\"\",0x00ff\r\n"
        );
        o.header = false;
        o.null_text = "NULL".into();
        o.delimiter = ";".into();
        o.quote = "'".into();
        o.bom = true;
        assert_eq!(
            text_export(&o, &rows[..1], None),
            "\u{feff}1;a,b;say \"hi\";NULL\r\n"
        );
        let tsv = options(ExportFormat::Tsv, &["a", "b"]);
        assert_eq!(
            text_export(&tsv, &[vec![json!("x\ty"), json!("=1+1")]], None),
            "a\tb\r\n\"x\ty\"\t'=1+1\r\n"
        );
        let mut raw = options(ExportFormat::Csv, &["a"]);
        raw.protect_formulas = false;
        assert_eq!(
            text_export(&raw, &[vec![json!("=1+1")]], None),
            "a\r\n=1+1\r\n"
        );
    }
    #[test]
    fn json_is_an_array_of_objects_in_column_order() {
        let o = options(ExportFormat::Json, &["z", "a", "bin"]);
        assert_eq!(text_export(&o, &[], None), "[]\n");
        let out = text_export(
            &o,
            &[
                vec![
                    json!("9223372036854775807"),
                    Value::Null,
                    json!({"hex": "0a"}),
                ],
                vec![json!(1.5), json!({"k": [1]}), json!("é\n\"")],
            ],
            None,
        );
        assert_eq!(
            out,
            "[\n{\"z\":\"9223372036854775807\",\"a\":null,\"bin\":\"0x0a\"},\n{\"z\":1.5,\"a\":{\"k\":[1]},\"bin\":\"é\\n\\\"\"}\n]\n"
        );
        let parsed: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(parsed[1]["bin"], "é\n\"");
    }
    #[test]
    fn sql_inserts_batch_rows_and_escape_per_dialect() {
        let mut o = options(ExportFormat::Sql, &["id", "note"]);
        o.batch_size = 2;
        let rows = vec![
            vec![json!(1), json!("it's \\ fine")],
            vec![json!(2), Value::Null],
            vec![json!(3), json!({"hex": "beef"})],
        ];
        let target = |driver: Driver| SqlTarget {
            target: quote("t`x", &driver),
            driver,
            ddl: Some("CREATE TABLE t (id int);".into()),
        };
        assert_eq!(
            text_export(&o, &rows, Some(target(Driver::Mysql))),
            "CREATE TABLE t (id int);\n\nINSERT INTO `t``x` (`id`, `note`) VALUES\n  (1, 'it''s \\\\ fine'),\n  (2, NULL);\nINSERT INTO `t``x` (`id`, `note`) VALUES (3, X'beef');\n"
        );
        o.batch_size = 1;
        let pg = text_export(&o, &rows, Some(target(Driver::Postgres)));
        assert!(
            pg.contains("INSERT INTO \"t`x\" (\"id\", \"note\") VALUES (1, 'it''s \\ fine');\n")
        );
        assert!(pg.contains("VALUES (3, '\\xbeef'::bytea);"));
        // Only real hex is treated as binary; anything else stays a quoted string.
        assert_eq!(
            sql_literal(&json!({"hex": "'); DROP TABLE t; --"}), &Driver::Sqlite),
            "'{\"hex\":\"''); DROP TABLE t; --\"}'"
        );
        assert_eq!(sql_literal(&json!(true), &Driver::Sqlite), "1");
        assert_eq!(sql_literal(&json!(false), &Driver::Postgres), "FALSE");
        assert_eq!(sql_literal(&json!("a\0b"), &Driver::Mysql), "'a\\0b'");
    }
    #[test]
    fn file_names_and_export_ids_are_sanitised() {
        assert_eq!(default_file_name("a/b:c", ExportFormat::Csv), "a_b_c.csv");
        assert_eq!(default_file_name("..", ExportFormat::Json), "export.json");
        assert_eq!(
            default_file_name("orders", ExportFormat::Xlsx),
            "orders.xlsx"
        );
        let exports = Exports::default();
        assert!(exports.register("../x").is_err());
        assert!(exports.register("").is_err());
        {
            let _a = exports.register("abc-1").unwrap();
            assert!(exports.register("abc-1").is_err());
        }
        assert!(exports.register("abc-1").is_ok());
        assert!(sql_name("  ").is_err());
        assert_eq!(sql_name(" results ").unwrap(), "results");
    }

    async fn sqlite() -> Connection {
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
        raw_pool_query(
            &conn.pool,
            "CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, note TEXT, big INTEGER, data BLOB, born TEXT);
             INSERT INTO people VALUES
               (1, 'Ana \"Quote\", Jr.', 'line1\nline2', 9223372036854775807, x'00ff10', '2026-10-18 09:30:00'),
               (2, 'Café ☕ 日本', NULL, -42, NULL, '2026-01-02'),
               (3, '=HYPERLINK(\"x\")', '', 0, x'', NULL),
               (4, '-12.50', 'it''s', 7, x'41', NULL);",
        )
        .await
        .unwrap();
        conn
    }
    fn people() -> TableInfo {
        TableInfo {
            name: "people".into(),
            schema: "".into(),
            kind: "table".into(),
        }
    }
    async fn export_people(
        conn: &Connection,
        o: &ExportOptions,
        filters: &[TableFilter],
        sort: Option<&TableSort>,
        sql: Option<SqlTarget>,
    ) -> (PathBuf, ExportSummary) {
        let path = temp_file(o.format.extension());
        let (cancel, progress) = quiet();
        let control = Control {
            cancel: &cancel,
            progress: &progress,
            stall: Duration::from_secs(5),
        };
        let table = people();
        let summary = export_to(
            &path,
            &o.plan().unwrap(),
            &o.columns,
            sql,
            Source::Table {
                conn,
                table: &table,
                filters,
                sort,
            },
            &control,
        )
        .await
        .unwrap();
        assert!(leftovers(&path).is_empty());
        (path, summary)
    }
    const ALL: [&str; 6] = ["id", "name", "note", "big", "data", "born"];

    #[tokio::test]
    async fn sqlite_table_exports_every_format() {
        let conn = sqlite().await;
        let mut csv = options(ExportFormat::Csv, &ALL);
        csv.bom = true;
        let (path, summary) = export_people(&conn, &csv, &[], None, None).await;
        assert_eq!(summary.rows, 4);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "\u{feff}id,name,note,big,data,born\r\n\
             1,\"Ana \"\"Quote\"\", Jr.\",\"line1\nline2\",9223372036854775807,0x00ff10,2026-10-18 09:30:00\r\n\
             2,Café ☕ 日本,,-42,,2026-01-02\r\n\
             3,\"'=HYPERLINK(\"\"x\"\")\",\"\",0,0x,\r\n\
             4,-12.50,it's,7,0x41,\r\n"
        );
        std::fs::remove_file(&path).unwrap();

        let mut tsv = options(ExportFormat::Tsv, &["name", "id"]);
        tsv.null_text = "\\N".into();
        let (path, _) = export_people(&conn, &tsv, &[], None, None).await;
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.starts_with("name\tid\r\n\"Ana \"\"Quote\"\", Jr.\"\t1\r\n"),
            "{text}"
        );
        std::fs::remove_file(&path).unwrap();

        let json = options(ExportFormat::Json, &ALL);
        let (path, _) = export_people(&conn, &json, &[], None, None).await;
        let parsed: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(parsed.as_array().unwrap().len(), 4);
        assert_eq!(parsed[0]["big"], "9223372036854775807");
        assert_eq!(parsed[0]["note"], "line1\nline2");
        assert_eq!(parsed[0]["data"], "0x00ff10");
        assert_eq!(parsed[1]["name"], "Café ☕ 日本");
        assert_eq!(parsed[1]["note"], Value::Null);
        // JSON is data, not a spreadsheet: values are never altered.
        assert_eq!(parsed[2]["name"], "=HYPERLINK(\"x\")");
        std::fs::remove_file(&path).unwrap();

        let mut sql = options(ExportFormat::Sql, &ALL);
        sql.batch_size = 3;
        let ddl = schema::table_ddl(&conn, &people(), false).await.unwrap();
        let target = SqlTarget {
            target: qualified(&people(), &Driver::Sqlite),
            driver: Driver::Sqlite,
            ddl: Some(ddl),
        };
        let (path, _) = export_people(&conn, &sql, &[], None, Some(target)).await;
        let script = std::fs::read_to_string(&path).unwrap();
        assert!(script.starts_with("CREATE TABLE people"), "{script}");
        assert_eq!(script.matches("INSERT INTO \"people\"").count(), 2);
        // Re-running the script into a fresh database reproduces the rows exactly.
        let copy = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let copy = Pool::Lite(copy);
        raw_pool_query(&copy, &script).await.unwrap();
        let original = query(&conn.pool, "SELECT * FROM people ORDER BY id")
            .await
            .unwrap();
        let restored = query(&copy, "SELECT * FROM people ORDER BY id")
            .await
            .unwrap();
        assert_eq!(original.rows, restored.rows);
        std::fs::remove_file(&path).unwrap();
    }
    #[tokio::test]
    async fn exports_apply_the_grid_filters_and_sort() {
        let conn = sqlite().await;
        let filters: Vec<TableFilter> = serde_json::from_value(json!([
            {"column": "born", "operator": "is_not_null"},
            {"join": "or", "column": "name", "operator": "contains", "value": "%_"}
        ]))
        .unwrap();
        let sort: TableSort =
            serde_json::from_value(json!({"column": "big", "direction": "desc"})).unwrap();
        let mut o = options(ExportFormat::Csv, &["id"]);
        o.header = false;
        let (path, summary) = export_people(&conn, &o, &filters, Some(&sort), None).await;
        assert_eq!(summary.rows, 2);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "1\r\n2\r\n");
        std::fs::remove_file(&path).unwrap();
        let bad: TableSort =
            serde_json::from_value(json!({"column": "nope", "direction": "asc"})).unwrap();
        let path = temp_file("csv");
        let (cancel, progress) = quiet();
        let control = Control {
            cancel: &cancel,
            progress: &progress,
            stall: Duration::from_secs(5),
        };
        let table = people();
        let failed = export_to(
            &path,
            &o.plan().unwrap(),
            &o.columns,
            None,
            Source::Table {
                conn: &conn,
                table: &table,
                filters: &[],
                sort: Some(&bad),
            },
            &control,
        )
        .await;
        assert!(failed.is_err());
        assert!(!path.exists() && leftovers(&path).is_empty());
    }
    #[tokio::test]
    async fn cancelled_exports_leave_no_file_and_keep_an_existing_one() {
        let conn = sqlite().await;
        let path = temp_file("csv");
        std::fs::write(&path, "previous").unwrap();
        let cancel = AtomicBool::new(true);
        let progress = |_: u64| {};
        let control = Control {
            cancel: &cancel,
            progress: &progress,
            stall: Duration::from_secs(5),
        };
        let o = options(ExportFormat::Csv, &["id"]);
        let table = people();
        let result = export_to(
            &path,
            &o.plan().unwrap(),
            &o.columns,
            None,
            Source::Table {
                conn: &conn,
                table: &table,
                filters: &[],
                sort: None,
            },
            &control,
        )
        .await;
        assert_eq!(result.unwrap_err(), CANCELLED);
        assert!(summary_or_cancel(Err(CANCELLED.into())).unwrap().is_none());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "previous");
        assert!(leftovers(&path).is_empty());
        std::fs::remove_file(&path).unwrap();
    }
    #[tokio::test]
    async fn large_tables_stream_with_progress() {
        let conn = sqlite().await;
        raw_pool_query(&conn.pool, "CREATE TABLE seq (n INTEGER PRIMARY KEY); WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 60000) INSERT INTO seq SELECT n FROM s").await.unwrap();
        let path = temp_file("csv");
        let cancel = AtomicBool::new(false);
        let seen = std::sync::Mutex::new(Vec::new());
        let progress = |rows: u64| seen.lock().unwrap().push(rows);
        let control = Control {
            cancel: &cancel,
            progress: &progress,
            stall: Duration::from_secs(5),
        };
        let o = options(ExportFormat::Csv, &["n"]);
        let table = TableInfo {
            name: "seq".into(),
            schema: "".into(),
            kind: "table".into(),
        };
        let summary = export_to(
            &path,
            &o.plan().unwrap(),
            &o.columns,
            None,
            Source::Table {
                conn: &conn,
                table: &table,
                filters: &[],
                sort: None,
            },
            &control,
        )
        .await
        .unwrap();
        assert_eq!(summary.rows, 60_000, "no 50,000-row cap");
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), 61);
        assert_eq!(*seen.last().unwrap(), 60_000);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.ends_with("59999\r\n60000\r\n"));
        std::fs::remove_file(&path).unwrap();
    }
    fn unzip(path: &Path, entry: &str) -> String {
        let mut archive = zip::ZipArchive::new(File::open(path).unwrap()).unwrap();
        let mut text = String::new();
        std::io::Read::read_to_string(&mut archive.by_name(entry).unwrap(), &mut text).unwrap();
        text
    }
    #[tokio::test]
    async fn sqlite_table_exports_to_excel() {
        let conn = sqlite().await;
        let mut o = options(ExportFormat::Xlsx, &ALL);
        o.null_text = "NULL".into();
        let (path, summary) = export_people(&conn, &o, &[], None, None).await;
        assert_eq!(
            (summary.rows, summary.sheets, summary.truncated_cells),
            (4, 1, 0)
        );
        let sheet = unzip(&path, "xl/worksheets/sheet1.xml");
        assert!(sheet.contains("<t>Café ☕ 日本</t>"), "{sheet}");
        assert!(
            sheet.contains("<t>9223372036854775807</t>"),
            "big ints stay exact text"
        );
        assert!(sheet.contains("<v>-42</v>"), "numbers are numeric cells");
        assert!(sheet.contains("<t>0x00ff10</t>"));
        assert!(sheet.contains("<t>NULL</t>"));
        assert!(
            sheet.contains("<t>=HYPERLINK(\"x\")</t>")
                || sheet.contains("<t>=HYPERLINK(&quot;x&quot;)</t>"),
            "text, never a formula"
        );
        assert!(!sheet.contains("<f>"));
        std::fs::remove_file(&path).unwrap();
    }
    #[tokio::test]
    async fn excel_continues_on_a_new_sheet_and_truncates_long_cells() {
        let path = temp_file("xlsx");
        let o = options(ExportFormat::Xlsx, &["n", "text"]);
        let mut export = XlsxExport::start(o.plan().unwrap(), &o.columns, 3).unwrap();
        let long = "x".repeat(XLSX_MAX_TEXT + 5);
        for n in 0..5 {
            export
                .row(&[json!(n), json!(if n == 4 { long.as_str() } else { "a" })])
                .unwrap();
        }
        let (sheets, truncated) = Output::Xlsx(Box::new(export)).finish(&path).await.unwrap();
        assert_eq!((sheets, truncated), (3, 1));
        let third = unzip(&path, "xl/worksheets/sheet3.xml");
        assert!(third.contains("<t>n</t>"), "each sheet repeats the header");
        assert!(third.contains(&"x".repeat(XLSX_MAX_TEXT)));
        assert!(!third.contains(&"x".repeat(XLSX_MAX_TEXT + 1)));
        std::fs::remove_file(&path).unwrap();
    }
    #[tokio::test]
    async fn fetched_rows_export_without_a_table() {
        let path = temp_file("sql");
        let (cancel, progress) = quiet();
        let control = Control {
            cancel: &cancel,
            progress: &progress,
            stall: Duration::from_secs(5),
        };
        let mut o = options(ExportFormat::Sql, &["total"]);
        o.table_name = Some("report".into());
        let rows = vec![vec![json!(1)], vec![json!("x")]];
        check_rows(&rows, 1).unwrap();
        let target = SqlTarget {
            target: quote(sql_name("report").unwrap(), &Driver::Mysql),
            driver: Driver::Mysql,
            ddl: None,
        };
        let summary = export_to(
            &path,
            &o.plan().unwrap(),
            &o.columns,
            Some(target),
            Source::Rows(&rows),
            &control,
        )
        .await
        .unwrap();
        assert_eq!(summary.rows, 2);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "INSERT INTO `report` (`total`) VALUES\n  (1),\n  ('x');\n"
        );
        std::fs::remove_file(&path).unwrap();
    }

    async fn live_export(
        conn: &Connection,
        table: &TableInfo,
        format: ExportFormat,
        columns: &[&str],
    ) -> String {
        let o = options(format, columns);
        let path = temp_file(format.extension());
        let (cancel, progress) = quiet();
        let control = Control {
            cancel: &cancel,
            progress: &progress,
            stall: Duration::from_secs(30),
        };
        let sql = (format == ExportFormat::Sql).then(|| SqlTarget {
            target: qualified(table, &conn.config.driver),
            driver: conn.config.driver.clone(),
            ddl: None,
        });
        export_to(
            &path,
            &o.plan().unwrap(),
            &o.columns,
            sql,
            Source::Table {
                conn,
                table,
                filters: &[],
                sort: None,
            },
            &control,
        )
        .await
        .unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        text
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_PG_URL; creates only session-local temporary tables"]
    async fn postgres_exports_stream_typed_values() {
        let url = std::env::var("DBDE_TEST_PG_URL").unwrap();
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let mut conn = sqlite().await;
        conn.pool = Pool::Pg(pool);
        conn.config.driver = Driver::Postgres;
        raw_pool_query(&conn.pool, "CREATE TEMPORARY TABLE export_test (id bigint PRIMARY KEY, name text, amount numeric(12,2), data bytea, at timestamptz, tags text[], doc jsonb); INSERT INTO export_test VALUES (9223372036854775807, 'Café \"q\", ''x''', 12.50, '\\x00ff', '2026-10-18 09:30:00+00', '{a,b}', '{\"k\": 1}'), (1, NULL, NULL, NULL, NULL, NULL, NULL)").await.unwrap();
        let schema = query(
            &conn.pool,
            "SELECT nspname FROM pg_namespace WHERE oid = pg_my_temp_schema()",
        )
        .await
        .unwrap()
        .rows[0][0]
            .as_str()
            .unwrap()
            .to_string();
        let table = TableInfo {
            name: "export_test".into(),
            schema,
            kind: "table".into(),
        };
        let all = ["id", "name", "amount", "data", "at", "tags", "doc"];
        let csv = live_export(&conn, &table, ExportFormat::Csv, &all).await;
        assert!(
            csv.starts_with("id,name,amount,data,at,tags,doc\r\n1,,,,,,\r\n"),
            "{csv}"
        );
        assert!(
            csv.contains("9223372036854775807,\"Café \"\"q\"\", 'x'\",12.50,0x00ff,"),
            "{csv}"
        );
        let json: Value =
            serde_json::from_str(&live_export(&conn, &table, ExportFormat::Json, &all).await)
                .unwrap();
        assert_eq!(json[1]["id"], "9223372036854775807");
        assert_eq!(json[1]["doc"], json!({"k": 1}));
        let sql = live_export(&conn, &table, ExportFormat::Sql, &all).await;
        raw_pool_query(
            &conn.pool,
            "CREATE TEMPORARY TABLE export_copy (LIKE export_test)",
        )
        .await
        .unwrap();
        raw_pool_query(
            &conn.pool,
            &sql.replace(&qualified(&table, &Driver::Postgres), "export_copy"),
        )
        .await
        .unwrap();
        let same = query(&conn.pool, "SELECT count(*)::int FROM (SELECT * FROM export_test EXCEPT SELECT * FROM export_copy) d").await.unwrap();
        assert_eq!(same.rows, vec![vec![json!(0)]]);
        raw_pool_query(&conn.pool, "DROP TABLE export_test; DROP TABLE export_copy")
            .await
            .unwrap();
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_MYSQL_URL; creates only session-local temporary tables"]
    async fn mysql_exports_stream_typed_values() {
        let url = std::env::var("DBDE_TEST_MYSQL_URL").unwrap();
        let pool = sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let mut conn = sqlite().await;
        conn.pool = Pool::My(pool);
        conn.config.driver = Driver::Mysql;
        let database = query(&conn.pool, "SELECT DATABASE()").await.unwrap().rows[0][0]
            .as_str()
            .unwrap()
            .to_string();
        conn.config.database = database.clone();
        raw_pool_query(&conn.pool, "CREATE TEMPORARY TABLE export_test (id BIGINT UNSIGNED PRIMARY KEY, name VARCHAR(50), amount DECIMAL(12,2), data VARBINARY(8), at DATETIME) DEFAULT CHARSET utf8mb4; INSERT INTO export_test VALUES (18446744073709551615, 'Café \\\\ \"q\", ''x''', 12.50, x'00ff', '2026-10-18 09:30:00'), (1, NULL, NULL, NULL, NULL)").await.unwrap();
        let table = TableInfo {
            name: "export_test".into(),
            schema: database,
            kind: "table".into(),
        };
        let all = ["id", "name", "amount", "data", "at"];
        let csv = live_export(&conn, &table, ExportFormat::Csv, &all).await;
        assert_eq!(
            csv,
            "id,name,amount,data,at\r\n1,,,,\r\n18446744073709551615,\"Café \\ \"\"q\"\", 'x'\",12.50,0x00ff,2026-10-18 09:30:00\r\n"
        );
        let sql = live_export(&conn, &table, ExportFormat::Sql, &all).await;
        raw_pool_query(
            &conn.pool,
            "CREATE TEMPORARY TABLE export_copy LIKE export_test",
        )
        .await
        .unwrap();
        raw_pool_query(
            &conn.pool,
            &sql.replace(&qualified(&table, &Driver::Mysql), "export_copy"),
        )
        .await
        .unwrap();
        let copied = query(
            &conn.pool,
            "SELECT CAST(id AS CHAR), name, HEX(data) FROM export_copy ORDER BY id DESC",
        )
        .await
        .unwrap();
        assert_eq!(
            copied.rows[0],
            vec![
                json!("18446744073709551615"),
                json!("Café \\ \"q\", 'x'"),
                json!("00FF")
            ]
        );
        raw_pool_query(
            &conn.pool,
            "DROP TEMPORARY TABLE export_test; DROP TEMPORARY TABLE export_copy",
        )
        .await
        .unwrap();
    }
}
