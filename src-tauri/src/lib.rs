use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{Column, Connection as SqlxConnection, Executor, Row, TypeInfo, ValueRef};
use std::{
    collections::HashMap,
    path::PathBuf,
    str::FromStr,
    sync::Arc,
    time::{Duration, Instant},
};
use tauri::{Manager, State};
use tokio::sync::Mutex;
mod column_meta;
mod connection_options;
mod database_actions;
mod explain;
mod export;
mod import;
mod maintain;
mod objects;
mod query_library;
mod rows;
mod schema;
mod ssh_tunnel;
mod table_actions;
mod table_alter;
mod table_designer;
mod table_rename;
mod updates;
mod windows;

const MAX_ROWS: usize = 50_000;
const DEADLINE: Duration = Duration::from_secs(30);
const MAX_QUERY_TIMEOUT_SECS: u64 = 3600;
const MAX_SESSIONS: usize = 16;
type DbResult<T> = Result<T, String>;
#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Driver {
    Postgres,
    Mysql,
    Sqlite,
}
#[derive(Clone, Serialize, Deserialize)]
struct ConnectionConfig {
    #[serde(default)]
    options: connection_options::ConnectionOptions,
    id: String,
    name: String,
    driver: Driver,
    host: String,
    port: u16,
    username: String,
    #[serde(default, skip_serializing)]
    password: Option<String>,
    database: String,
    #[serde(default)]
    database_only: bool,
    ssl_mode: String,
    file_path: String,
}
#[derive(Clone)]
enum Pool {
    Pg(sqlx::PgPool),
    My(sqlx::MySqlPool),
    Lite(sqlx::SqlitePool),
}
// A query tab's own server connection, so BEGIN/COMMIT, SET and temporary
// tables persist between executions instead of landing on a random pooled one.
enum SessionConn {
    Pg(sqlx::PgConnection),
    My(sqlx::MySqlConnection),
}
struct Session {
    conn: SessionConn,
    database: String,
}
struct SessionState {
    session: Mutex<Option<Session>>,
    // pg_backend_pid() or CONNECTION_ID(), read without waiting for a running query.
    server_id: std::sync::Mutex<Option<u64>>,
}
type SessionSlot = Arc<SessionState>;
#[derive(Clone)]
struct Connection {
    tunnel: Option<Arc<ssh_tunnel::Tunnel>>,
    pool: Pool,
    config: ConnectionConfig,
    databases: Arc<Mutex<HashMap<String, Pool>>>,
    sessions: Arc<Mutex<HashMap<String, SessionSlot>>>,
}
struct AppState {
    connections: Mutex<HashMap<String, Connection>>,
    profiles: Mutex<()>,
    profile_path: PathBuf,
}
#[derive(Clone, Serialize, Deserialize)]
struct TableInfo {
    name: String,
    schema: String,
    kind: String,
}
#[derive(Serialize)]
struct SchemaTree {
    database: String,
    tables: Vec<TableInfo>,
    table_metadata: Vec<TableMetadata>,
}
#[derive(Serialize)]
struct TableMetadata {
    name: String,
    schema: String,
    rows: Option<u64>,
    data_length: Option<u64>,
    engine: Option<String>,
    created_date: Option<String>,
    modified_date: Option<String>,
    collation: Option<String>,
    comment: Option<String>,
}
fn table_metadata(row: &[Value]) -> TableMetadata {
    let text = |index: usize| row.get(index).and_then(Value::as_str).map(str::to_owned);
    let number = |index: usize| row.get(index).and_then(Value::as_u64);
    TableMetadata {
        name: text(0).unwrap_or_default(),
        schema: text(1).unwrap_or_default(),
        rows: number(3),
        data_length: number(4),
        engine: text(5),
        created_date: text(6),
        modified_date: text(7),
        collation: text(8),
        comment: text(9),
    }
}
#[derive(Serialize)]
struct ColumnInfo {
    name: String,
    data_type: String,
    nullable: bool,
    /// Allowed values of a MySQL/MariaDB ENUM or a PostgreSQL enum type, in order.
    #[serde(skip_serializing_if = "Option::is_none")]
    enum_values: Option<Vec<String>>,
    /// Members of a MySQL/MariaDB SET column, in definition order.
    #[serde(skip_serializing_if = "Option::is_none")]
    set_values: Option<Vec<String>>,
    /// PostgreSQL boolean, MySQL BOOL (tinyint(1)) or SQLite BOOLEAN.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    is_boolean: bool,
}
#[derive(Serialize)]
struct QueryResult {
    #[serde(skip_serializing_if = "Option::is_none")]
    pagination: Option<rows::TablePagination>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<rows::TableSource>,
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    affected_rows: u64,
    execution_ms: f64,
    truncated: bool,
}
fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}
fn validate(config: &ConnectionConfig) -> DbResult<()> {
    uuid::Uuid::parse_str(&config.id).map_err(|_| "Invalid profile ID".to_string())?;
    if config.name.trim().is_empty() {
        return Err("Connection name is required".into());
    }
    match config.driver {
        Driver::Sqlite if config.file_path.trim().is_empty() => {
            return Err("SQLite path is required".into())
        }
        Driver::Postgres | Driver::Mysql
            if config.host.trim().is_empty()
                || config.username.trim().is_empty()
                || config.port == 0 =>
        {
            return Err("Host, port and username are required".into())
        }
        _ => (),
    }
    if config.database_only
        && !matches!(config.driver, Driver::Sqlite)
        && config.database.trim().is_empty()
    {
        return Err("A database name is required for a focused connection".into());
    }
    if !["disable", "require", "verify-full"].contains(&config.ssl_mode.as_str()) {
        return Err("Invalid SSL mode".into());
    }
    config.options.validate(config)?;
    Ok(())
}
fn safe_error(error: impl std::fmt::Display, password: &str) -> String {
    let message = error.to_string();
    if password.is_empty() {
        message
    } else {
        message.replace(password, "[redacted]")
    }
}
fn same_server(a: &ConnectionConfig, b: &ConnectionConfig) -> bool {
    a.driver == b.driver
        && a.host == b.host
        && a.port == b.port
        && a.username == b.username
        && a.options.socket_path == b.options.socket_path
        && a.options.ssh.same_endpoint(&b.options.ssh)
}
// The IPC payload comes from the webview. A stored secret is only released for the exact
// server it was saved with, so a compromised page cannot redirect it to another host.
async fn saved_profile_matches(state: &AppState, config: &ConnectionConfig) -> DbResult<bool> {
    let _guard = state.profiles.lock().await;
    Ok(read_profiles(state)
        .await?
        .iter()
        .any(|saved| saved.id == config.id && same_server(saved, config)))
}
async fn password(config: &ConnectionConfig, state: &AppState) -> DbResult<String> {
    if let Some(password) = &config.password {
        return Ok(password.clone());
    }
    if !saved_profile_matches(state, config).await? {
        return Err(
            "Enter the password. These connection details do not match a saved profile.".into(),
        );
    }
    let id = config.id.clone();
    tokio::task::spawn_blocking(move || {
        match keyring::Entry::new("com.dbde.desktop", &id)
            .map_err(err)?
            .get_password()
        {
            Ok(password) => Ok(password),
            Err(keyring::Error::NoEntry) => Ok(String::new()),
            Err(e) => Err(format!("Cannot read OS credential vault: {e}")),
        }
    })
    .await
    .map_err(err)?
}
async fn make_pool(
    config: &ConnectionConfig,
    state: &AppState,
) -> DbResult<(Pool, Option<Arc<ssh_tunnel::Tunnel>>)> {
    validate(config)?;
    let tunnel = ssh_tunnel::open(config, state).await?;
    let pool = make_pool_at(config, state, tunnel.as_deref()).await?;
    Ok((pool, tunnel))
}
async fn make_pool_at(
    config: &ConnectionConfig,
    state: &AppState,
    tunnel: Option<&ssh_tunnel::Tunnel>,
) -> DbResult<Pool> {
    if let Driver::Sqlite = config.driver {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&config.file_path)
            .create_if_missing(true)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));
        return connection_options::lite_pool(config)
            .connect_with(options)
            .await
            .map(Pool::Lite)
            .map_err(err);
    }
    let secret = password(config, state).await?;
    match config.driver {
        Driver::Postgres => {
            let ssl = match config.ssl_mode.as_str() {
                "disable" => sqlx::postgres::PgSslMode::Disable,
                "verify-full" => sqlx::postgres::PgSslMode::VerifyFull,
                _ => sqlx::postgres::PgSslMode::Require,
            };
            let options = sqlx::postgres::PgConnectOptions::new()
                .host(&config.host)
                .port(config.port)
                .username(&config.username)
                .password(&secret)
                .ssl_mode(ssl);
            let options = options.database(if config.database.is_empty() {
                "postgres"
            } else {
                &config.database
            });
            let mut options = options;
            if !config.options.ssl_ca.is_empty() {
                options = options.ssl_root_cert(&config.options.ssl_ca);
            }
            if !config.options.ssl_cert.is_empty() {
                options = options.ssl_client_cert(&config.options.ssl_cert);
            }
            if !config.options.ssl_key.is_empty() {
                options = options.ssl_client_key(&config.options.ssl_key);
            }
            let options = tunnel.map_or_else(|| options.clone(), |t| t.pg_options(options.clone()));
            connection_options::pg_pool(config)
                .connect_with(options)
                .await
                .map(Pool::Pg)
                .map_err(|e| safe_error(e, &secret))
        }
        Driver::Mysql => {
            let ssl = match config.ssl_mode.as_str() {
                "disable" => sqlx::mysql::MySqlSslMode::Disabled,
                "verify-full" => sqlx::mysql::MySqlSslMode::VerifyIdentity,
                _ => sqlx::mysql::MySqlSslMode::Required,
            };
            let options = sqlx::mysql::MySqlConnectOptions::new()
                .host(&config.host)
                .port(config.port)
                .username(&config.username)
                .ssl_mode(ssl);
            // None and Some("") differ in SQLx's MySQL handshake: Some("")
            // still sends a scrambled password. Omit the setter entirely for
            // passwordless accounts; never trim or alter a non-empty password.
            let options = mysql_password(options, &secret);
            let options = if config.database.is_empty() {
                options
            } else {
                options.database(&config.database)
            };
            let mut options = options;
            if !config.options.charset.is_empty() {
                options = options.charset(&config.options.charset);
            }
            if !config.options.socket_path.is_empty() {
                options = options.socket(&config.options.socket_path);
            }
            if !config.options.ssl_ca.is_empty() {
                options = options.ssl_ca(&config.options.ssl_ca);
            }
            if !config.options.ssl_cert.is_empty() {
                options = options.ssl_client_cert(&config.options.ssl_cert);
            }
            if !config.options.ssl_key.is_empty() {
                options = options.ssl_client_key(&config.options.ssl_key);
            }
            let options = tunnel.map_or_else(|| options.clone(), |t| t.my_options(options.clone()));
            connection_options::my_pool(config)
                .connect_with(options)
                .await
                .map(Pool::My)
                .map_err(|e| safe_error(e, &secret))
        }
        Driver::Sqlite => unreachable!(),
    }
}
fn mysql_password(
    options: sqlx::mysql::MySqlConnectOptions,
    secret: &str,
) -> sqlx::mysql::MySqlConnectOptions {
    if secret.is_empty() {
        options
    } else {
        options.password(secret)
    }
}
async fn close(pool: Pool) {
    match pool {
        Pool::Pg(p) => p.close().await,
        Pool::My(p) => p.close().await,
        Pool::Lite(p) => p.close().await,
    }
}
async fn connection(state: &AppState, id: &str) -> DbResult<Connection> {
    state
        .connections
        .lock()
        .await
        .get(id)
        .cloned()
        .ok_or_else(|| "Connection is closed. Reconnect to continue.".into())
}
// Each database gets its own pool. Switching a query tab must never change another tab's context.
async fn database_connection(
    state: &AppState,
    id: &str,
    database: Option<&str>,
) -> DbResult<Connection> {
    let mut conn = connection(state, id).await?;
    let Some(database) = database.filter(|name| !name.is_empty()) else {
        return Ok(conn);
    };
    if matches!(conn.pool, Pool::Lite(_)) || conn.config.database == database {
        return Ok(conn);
    }
    let existing = conn.databases.lock().await.get(database).cloned();
    let pool = match existing {
        Some(pool) => pool,
        None => {
            // Connect without holding the map lock so other tabs are not blocked meanwhile.
            let pool = match &conn.pool {
                Pool::Pg(p) => {
                    let options = p.connect_options().as_ref().clone().database(database);
                    connection_options::pg_pool(&conn.config)
                        .connect_with(options)
                        .await
                        .map(Pool::Pg)
                        .map_err(err)?
                }
                Pool::My(p) => {
                    let options = p.connect_options().as_ref().clone().database(database);
                    connection_options::my_pool(&conn.config)
                        .connect_with(options)
                        .await
                        .map(Pool::My)
                        .map_err(err)?
                }
                Pool::Lite(p) => Pool::Lite(p.clone()),
            };
            let mut pools = conn.databases.lock().await;
            if let Some(winner) = pools.get(database) {
                let winner = winner.clone();
                drop(pools);
                close(pool).await;
                winner
            } else {
                pools.insert(database.into(), pool.clone());
                pool
            }
        }
    };
    conn.pool = pool;
    conn.config.database = database.into();
    Ok(conn)
}
// MySQL-compatible servers expose every accessible database in information_schema.
// Listing another database must not open a new pool or change the shared session's
// default database; PostgreSQL catalogs still require a database-specific pool.
async fn schema_connection(
    state: &AppState,
    id: &str,
    database: Option<&str>,
) -> DbResult<Connection> {
    let mut conn = connection(state, id).await?;
    if matches!(conn.pool, Pool::My(_)) {
        if let Some(database) = database.filter(|name| !name.is_empty()) {
            conn.config.database = database.into();
        }
        Ok(conn)
    } else {
        database_connection(state, id, database).await
    }
}
async fn timed<T>(future: impl std::future::Future<Output = DbResult<T>>) -> DbResult<T> {
    tokio::time::timeout(DEADLINE, future).await.map_err(|_| "Operation timed out after 30 seconds. A write may have committed; verify database state before retrying.".to_string())?
}
#[tauri::command]
async fn dbde_test_connection(
    config: ConnectionConfig,
    state: State<'_, AppState>,
) -> DbResult<bool> {
    test_connection(config, &state).await
}
async fn test_connection(config: ConnectionConfig, state: &AppState) -> DbResult<bool> {
    timed(async {
        let (pool, _tunnel) = make_pool(&config, state).await?;
        close(pool).await;
        Ok(true)
    })
    .await
}
#[tauri::command]
async fn dbde_connect(config: ConnectionConfig, state: State<'_, AppState>) -> DbResult<String> {
    let (pool, tunnel) = timed(make_pool(&config, &state)).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut config = config;
    config.password = None;
    config.options.ssh.password = None;
    if matches!(config.driver, Driver::Postgres) && config.database.is_empty() {
        // make_pool connects to "postgres" when blank; record it so selecting that
        // database reuses this pool instead of opening a duplicate.
        config.database = "postgres".into();
    }
    state.connections.lock().await.insert(
        id.clone(),
        Connection {
            tunnel,
            pool,
            config,
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        },
    );
    Ok(id)
}
async fn close_session(session: Session) {
    match session.conn {
        SessionConn::Pg(c) => {
            let _ = c.close().await;
        }
        SessionConn::My(c) => {
            let _ = c.close().await;
        }
    }
}
// Waits for a running query in the background; closing the socket rolls back any open transaction.
fn close_slot(slot: SessionSlot) {
    tauri::async_runtime::spawn(async move {
        if let Some(session) = slot.session.lock().await.take() {
            close_session(session).await;
        }
    });
}
// Cancels whatever the tab's server connection is running. Idle sessions ignore it.
async fn cancel_server_query(conn: &Connection, server_id: u64) -> DbResult<()> {
    match &conn.pool {
        Pool::Pg(p) => {
            let pid = i32::try_from(server_id).map_err(err)?;
            sqlx::query("SELECT pg_cancel_backend($1)")
                .bind(pid)
                .execute(p)
                .await
                .map(|_| ())
                .map_err(err)
        }
        Pool::My(p) => match sqlx::raw_sql(&format!("KILL QUERY {server_id}"))
            .execute(p)
            .await
        {
            // The thread may already be gone after a dropped session.
            Ok(_) | Err(sqlx::Error::Database(_)) => Ok(()),
            Err(e) => Err(err(e)),
        },
        Pool::Lite(_) => Err("SQLite queries cannot be cancelled".into()),
    }
}
async fn session_slot(conn: &Connection, session_id: &str) -> Option<SessionSlot> {
    conn.sessions.lock().await.get(session_id).cloned()
}
#[tauri::command]
async fn dbde_cancel_query(
    connection_id: String,
    session_id: String,
    state: State<'_, AppState>,
) -> DbResult<bool> {
    let conn = connection(&state, &connection_id).await?;
    let Some(slot) = session_slot(&conn, &session_id).await else {
        return Ok(false);
    };
    let Some(server_id) = *slot.server_id.lock().map_err(err)? else {
        return Ok(false);
    };
    timed(cancel_server_query(&conn, server_id)).await?;
    Ok(true)
}
async fn session_in_transaction(session: &mut Session) -> bool {
    match &mut session.conn {
        // Inside a transaction block the transaction started before this statement.
        // An aborted transaction rejects the query, which also means one is open.
        // A bare string has no arguments, so it uses the simple protocol; the extended one sends Parse and Execute
        // separately, which moves statement_timestamp() even outside a transaction.
        SessionConn::Pg(c) => (&mut *c)
            .fetch_one("SELECT transaction_timestamp() <> statement_timestamp()")
            .await
            .and_then(|row| row.try_get::<bool, _>(0))
            .unwrap_or(true),
        // MariaDB exposes @@in_transaction; MySQL needs InnoDB's view, which may require
        // the PROCESS privilege. Unknown states are reported as no open transaction.
        SessionConn::My(c) => {
            if let Ok(v) = sqlx::query_scalar::<_, i64>("SELECT CAST(@@in_transaction AS SIGNED)")
                .fetch_one(&mut *c)
                .await
            {
                return v != 0;
            }
            sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM information_schema.innodb_trx WHERE trx_mysql_thread_id = CONNECTION_ID()")
                .fetch_one(&mut *c)
                .await
                .map(|n| n > 0)
                .unwrap_or(false)
        }
    }
}
#[tauri::command]
async fn dbde_session_in_transaction(
    connection_id: String,
    session_id: String,
    state: State<'_, AppState>,
) -> DbResult<bool> {
    let Ok(conn) = connection(&state, &connection_id).await else {
        return Ok(false);
    };
    let Some(slot) = session_slot(&conn, &session_id).await else {
        return Ok(false);
    };
    let check = async {
        match slot.session.lock().await.as_mut() {
            Some(session) => session_in_transaction(session).await,
            None => false,
        }
    };
    // A busy session cannot be inspected quickly; assume work may be pending.
    Ok(tokio::time::timeout(Duration::from_secs(5), check)
        .await
        .unwrap_or(true))
}
#[tauri::command]
async fn dbde_close_session(
    connection_id: String,
    session_id: String,
    state: State<'_, AppState>,
) -> DbResult<()> {
    let Ok(conn) = connection(&state, &connection_id).await else {
        return Ok(());
    };
    if let Some(slot) = conn.sessions.lock().await.remove(&session_id) {
        close_slot(slot);
    }
    Ok(())
}
#[tauri::command]
async fn dbde_disconnect(connection_id: String, state: State<'_, AppState>) -> DbResult<()> {
    let conn = state.connections.lock().await.remove(&connection_id);
    if let Some(conn) = conn {
        for (_, slot) in conn.sessions.lock().await.drain() {
            close_slot(slot);
        }
        let pools: Vec<Pool> = conn
            .databases
            .lock()
            .await
            .drain()
            .map(|(_, p)| p)
            .collect();
        for pool in pools {
            close(pool).await;
        }
        close(conn.pool).await;
    }
    Ok(())
}

// Decode typed rows rather than SQLx Any so native dates, decimals and JSON retain meaning.
macro_rules! common_cell {
    ($row:expr, $i:expr) => {{
        let row = $row; let i = $i;
        if row.try_get_raw(i).map_err(err)?.is_null() { return Ok(Value::Null); }
        if matches!(row.columns()[i].type_info().name(), "BOOL" | "BOOLEAN") { if let Ok(v) = row.try_get::<bool, _>(i) { return Ok(json!(v)); } }
        if let Ok(v) = row.try_get::<i64, _>(i) { return Ok(if v.unsigned_abs() > 9_007_199_254_740_991 { json!(v.to_string()) } else { json!(v) }); }
        if let Ok(v) = row.try_get::<i32, _>(i) { return Ok(json!(v)); }
        if let Ok(v) = row.try_get::<i16, _>(i) { return Ok(json!(v)); }
        if let Ok(v) = row.try_get::<f64, _>(i) { return Ok(json!(v)); }
        if let Ok(v) = row.try_get::<f32, _>(i) { return Ok(json!(v)); }
        if let Ok(v) = row.try_get::<String, _>(i) { return Ok(json!(v)); }
        if let Ok(v) = row.try_get::<chrono::NaiveDateTime, _>(i) { return Ok(json!(v.to_string())); }
        if let Ok(v) = row.try_get::<chrono::NaiveDate, _>(i) { return Ok(json!(v.to_string())); }
        if let Ok(v) = row.try_get::<chrono::NaiveTime, _>(i) { return Ok(json!(v.to_string())); }
        if let Ok(v) = row.try_get::<Vec<u8>, _>(i) { return Ok(json!({"hex": v.iter().map(|b| format!("{b:02x}")).collect::<String>()})); }
    }};
}
fn pg_cell(row: &sqlx::postgres::PgRow, i: usize) -> DbResult<Value> {
    common_cell!(row, i);
    if let Ok(v) = row.try_get::<chrono::DateTime<chrono::Utc>, _>(i) {
        return Ok(json!(v.to_rfc3339()));
    }
    if let Ok(v) = row.try_get::<rust_decimal::Decimal, _>(i) {
        return Ok(json!(v.to_string()));
    }
    if let Ok(v) = row.try_get::<uuid::Uuid, _>(i) {
        return Ok(json!(v.to_string()));
    }
    if let Ok(v) = row.try_get::<Value, _>(i) {
        return Ok(v);
    }
    // Text-protocol values (editor and table view) are PostgreSQL's own rendering, which
    // covers enums, arrays, intervals, network types and anything from an extension.
    let raw = row.try_get_raw(i).map_err(err)?;
    if raw.format() == sqlx::postgres::PgValueFormat::Text {
        if let Ok(text) = raw.as_str() {
            return Ok(json!(text));
        }
    }
    unknown_bytes(row.try_get_unchecked::<Vec<u8>, _>(i).map_err(err)?)
}
// Last resort for a type DBde cannot decode: show bytes rather than failing the result.
fn unknown_bytes(bytes: Vec<u8>) -> DbResult<Value> {
    Ok(json!({ "hex": bytes.iter().map(|b| format!("{b:02x}")).collect::<String>() }))
}
fn my_cell(row: &sqlx::mysql::MySqlRow, i: usize) -> DbResult<Value> {
    common_cell!(row, i);
    if row.columns()[i].type_info().name() == "TIMESTAMP" {
        // SQLx maps TIMESTAMP to DateTime<Utc>, not NaiveDateTime. Its decoder
        // preserves the session's date/time fields; display those fields without
        // adding a misleading UTC suffix or converting the session time zone.
        return row
            .try_get::<chrono::DateTime<chrono::Utc>, _>(i)
            .map(mysql_timestamp_value)
            .map_err(|e| {
                format!(
                    "Cannot decode MySQL TIMESTAMP in column {}: {e}",
                    row.columns()[i].name()
                )
            });
    }
    if let Ok(v) = row.try_get::<u64, _>(i) {
        return Ok(if v > 9_007_199_254_740_991 {
            json!(v.to_string())
        } else {
            json!(v)
        });
    }
    if let Ok(v) = row.try_get::<rust_decimal::Decimal, _>(i) {
        return Ok(json!(v.to_string()));
    }
    if let Ok(v) = row.try_get::<Value, _>(i) {
        return Ok(v);
    }
    // BIT, GEOMETRY and similar: readable text when the bytes are text, hex otherwise.
    let bytes = row.try_get_unchecked::<Vec<u8>, _>(i).map_err(err)?;
    match String::from_utf8(bytes) {
        Ok(text) if !text.chars().any(|c| c.is_control()) => Ok(json!(text)),
        Ok(text) => unknown_bytes(text.into_bytes()),
        Err(e) => unknown_bytes(e.into_bytes()),
    }
}
fn mysql_timestamp_value(value: chrono::DateTime<chrono::Utc>) -> Value {
    json!(value.naive_utc().to_string())
}
fn lite_cell(row: &sqlx::sqlite::SqliteRow, i: usize) -> DbResult<Value> {
    // SQLite's dynamic typing needs raw storage type to avoid coercing every integer to bool.
    let raw = row.try_get_raw(i).map_err(err)?;
    if raw.is_null() {
        return Ok(Value::Null);
    }
    match raw.type_info().name() {
        "INTEGER" => {
            let v: i64 = row.try_get(i).map_err(err)?;
            Ok(if v.unsigned_abs() > 9_007_199_254_740_991 {
                json!(v.to_string())
            } else {
                json!(v)
            })
        }
        "REAL" => Ok(json!(row.try_get::<f64, _>(i).map_err(err)?)),
        "BLOB" => {
            let v: Vec<u8> = row.try_get(i).map_err(err)?;
            Ok(json!({ "hex": v.iter().map(|b| format!("{b:02x}")).collect::<String>() }))
        }
        _ => Ok(json!(row.try_get::<String, _>(i).map_err(err)?)),
    }
}
macro_rules! query_pool {
    ($pool:expr, $query:expr, $cell:ident, $params:expr) => {{
        let pool = $pool;
        let query = $query;
        let start = Instant::now();
        let description = pool.describe(query).await.map_err(err)?;
        let columns: Vec<String> = description
            .columns()
            .iter()
            .map(|c| c.name().to_string())
            .collect();
        let mut result = QueryResult {
            pagination: None,
            source: None,
            columns,
            rows: Vec::new(),
            affected_rows: 0,
            execution_ms: 0.0,
            truncated: false,
        };
        let mut statement = sqlx::query(query);
        for value in $params {
            statement = statement.bind(value);
        }
        #[allow(deprecated)]
        let mut stream = statement.fetch_many(pool);
        while let Some(item) = stream.try_next().await.map_err(err)? {
            match item {
                sqlx::Either::Left(done) => result.affected_rows += done.rows_affected(),
                sqlx::Either::Right(row) => {
                    if result.rows.len() >= MAX_ROWS {
                        result.truncated = true;
                        break;
                    }
                    let values = (0..row.len())
                        .map(|i| $cell(&row, i))
                        .collect::<DbResult<Vec<_>>>()?;
                    result.rows.push(values);
                }
            }
        }
        result.execution_ms = start.elapsed().as_secs_f64() * 1000.0;
        Ok(result)
    }};
}
async fn query(pool: &Pool, query: &str) -> DbResult<QueryResult> {
    query_with_params(pool, query, &[]).await
}
async fn query_with_params(pool: &Pool, query: &str, params: &[String]) -> DbResult<QueryResult> {
    match pool {
        Pool::Pg(p) => query_pool!(p, query, pg_cell, params),
        Pool::My(p) => query_pool!(p, query, my_cell, params),
        Pool::Lite(p) => query_pool!(p, query, lite_cell, params),
    }
}
// Editor text runs over the simple/text protocol: multi-statement scripts work on every
// driver and nothing is prepared twice. The last result set wins, matching the demo.
/// Whether `query` is one statement that returns rows, so describing it for column
/// headers is safe and useful. Leading comments are skipped; a statement terminator
/// anywhere but the end means a script, which is never described.
fn describes_rows(query: &str) -> bool {
    let mut rest = query.trim_start();
    loop {
        if let Some(line) = rest.strip_prefix("--") {
            rest = line
                .split_once('\n')
                .map_or("", |(_, tail)| tail)
                .trim_start();
        } else if let Some(block) = rest.strip_prefix("/*") {
            rest = block
                .split_once("*/")
                .map_or("", |(_, tail)| tail)
                .trim_start();
        } else {
            break;
        }
    }
    let body = rest.trim_end().trim_end_matches(';');
    if body.contains(';') {
        return false;
    }
    let keyword: String = body
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_uppercase();
    matches!(
        keyword.as_str(),
        "SELECT"
            | "WITH"
            | "VALUES"
            | "TABLE"
            | "SHOW"
            | "EXPLAIN"
            | "PRAGMA"
            | "DESCRIBE"
            | "DESC"
    )
}
macro_rules! raw_query {
    ($exec:expr, $query:expr, $cell:ident) => {{
        let query = $query;
        let start = Instant::now();
        let mut result = QueryResult {
            pagination: None,
            source: None,
            columns: Vec::new(),
            rows: Vec::new(),
            affected_rows: 0,
            execution_ms: 0.0,
            truncated: false,
        };
        let mut statement_done = false;
        {
            let mut stream = sqlx::raw_sql(query).fetch_many($exec);
            while let Some(item) = stream.try_next().await.map_err(err)? {
                match item {
                    sqlx::Either::Left(done) => {
                        result.affected_rows += done.rows_affected();
                        statement_done = true;
                    }
                    sqlx::Either::Right(row) => {
                        if statement_done || result.columns.is_empty() {
                            statement_done = false;
                            result.truncated = false;
                            result.rows.clear();
                            result.columns =
                                row.columns().iter().map(|c| c.name().to_string()).collect();
                        }
                        if result.rows.len() >= MAX_ROWS {
                            result.truncated = true;
                            break;
                        }
                        let values = (0..row.len())
                            .map(|i| $cell(&row, i))
                            .collect::<DbResult<Vec<_>>>()?;
                        result.rows.push(values);
                    }
                }
            }
        }
        if result.columns.is_empty() && describes_rows(query) {
            // Rows carry column names, so an empty SELECT needs a describe to keep its headers.
            // Only single row-returning statements are described: in PostgreSQL a failed
            // describe (a script, or DDL whose table no longer exists) aborts an open
            // transaction on the tab's session.
            if let Ok(description) = ($exec).describe(query).await {
                result.columns = description
                    .columns()
                    .iter()
                    .map(|c| c.name().to_string())
                    .collect();
            }
        }
        result.execution_ms = start.elapsed().as_secs_f64() * 1000.0;
        Ok::<QueryResult, String>(result)
    }};
}
async fn raw_pool_query(pool: &Pool, query: &str) -> DbResult<QueryResult> {
    match pool {
        Pool::Pg(p) => raw_query!(p, query, pg_cell),
        Pool::My(p) => raw_query!(p, query, my_cell),
        Pool::Lite(p) => raw_query!(p, query, lite_cell),
    }
}
async fn open_session(conn: &Connection) -> DbResult<(SessionConn, u64)> {
    match &conn.pool {
        Pool::Pg(p) => {
            let mut c = tokio::time::timeout(
                conn.config.options.timeout(),
                sqlx::PgConnection::connect_with(p.connect_options().as_ref()),
            )
            .await
            .map_err(|_| "Connection timeout while opening the query session.".to_string())?
            .map_err(err)?;
            if !conn.config.options.initial_queries.trim().is_empty() {
                (&mut c)
                    .execute(conn.config.options.initial_queries.as_str())
                    .await
                    .map_err(err)?;
            }
            let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()")
                .fetch_one(&mut c)
                .await
                .map_err(err)?;
            Ok((SessionConn::Pg(c), u64::try_from(pid).map_err(err)?))
        }
        Pool::My(p) => {
            let mut c = tokio::time::timeout(
                conn.config.options.timeout(),
                sqlx::MySqlConnection::connect_with(p.connect_options().as_ref()),
            )
            .await
            .map_err(|_| "Connection timeout while opening the query session.".to_string())?
            .map_err(err)?;
            if !conn.config.options.initial_queries.trim().is_empty() {
                (&mut c)
                    .execute(conn.config.options.initial_queries.as_str())
                    .await
                    .map_err(err)?;
            }
            let id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()")
                .fetch_one(&mut c)
                .await
                .map_err(err)?;
            Ok((SessionConn::My(c), id))
        }
        Pool::Lite(_) => Err("SQLite queries share the connection pool".into()),
    }
}
async fn session_alive(session: &mut Session) -> bool {
    let ping = async {
        match &mut session.conn {
            SessionConn::Pg(c) => c.ping().await.is_ok(),
            SessionConn::My(c) => c.ping().await.is_ok(),
        }
    };
    tokio::time::timeout(Duration::from_secs(5), ping)
        .await
        .unwrap_or(false)
}
async fn session_query(conn: &Connection, session_id: &str, query: &str) -> DbResult<QueryResult> {
    if session_id.is_empty() || session_id.len() > 64 {
        return Err("Invalid query session".into());
    }
    let slot = {
        let mut sessions = conn.sessions.lock().await;
        let limit = conn.config.options.session_limit.unwrap_or(MAX_SESSIONS);
        if !sessions.contains_key(session_id) && sessions.len() >= limit {
            return Err(format!(
                "At most {limit} query tabs can run on one connection. Close a tab and try again."
            ));
        }
        sessions
            .entry(session_id.into())
            .or_insert_with(|| {
                Arc::new(SessionState {
                    session: Mutex::new(None),
                    server_id: std::sync::Mutex::new(None),
                })
            })
            .clone()
    };
    // Holding the slot serialises a tab's queries. If the deadline drops this future,
    // the taken connection is dropped with it and the server rolls back its transaction.
    let mut guard = slot.session.lock().await;
    let mut session = match guard.take() {
        Some(session) if session.database == conn.config.database => session,
        previous => {
            if let Some(previous) = previous {
                close_session(previous).await;
            }
            let (session_conn, server_id) = open_session(conn).await?;
            *slot.server_id.lock().map_err(err)? = Some(server_id);
            Session {
                conn: session_conn,
                database: conn.config.database.clone(),
            }
        }
    };
    // A failed statement must keep the session: MySQL transactions survive errors.
    let result = async {
        match &mut session.conn {
            SessionConn::Pg(c) => raw_query!(&mut *c, query, pg_cell),
            SessionConn::My(c) => raw_query!(&mut *c, query, my_cell),
        }
    }
    .await;
    if result.is_ok() || session_alive(&mut session).await {
        *guard = Some(session);
    } else {
        if let Ok(mut id) = slot.server_id.lock() {
            *id = None;
        }
        close_session(session).await;
    }
    result
}
#[tauri::command]
async fn dbde_execute_query(
    connection_id: String,
    query: String,
    database: Option<String>,
    session_id: Option<String>,
    timeout_secs: Option<u64>,
    state: State<'_, AppState>,
) -> DbResult<QueryResult> {
    if query.trim().is_empty() {
        return Err("Query is empty".into());
    }
    if query.len() > 1_000_000 {
        return Err("Query exceeds the 1 MB limit".into());
    }
    let conn = timed(database_connection(
        &state,
        &connection_id,
        database.as_deref(),
    ))
    .await?;
    let seconds = timeout_secs
        .or(conn.config.options.query_timeout_secs)
        .unwrap_or(DEADLINE.as_secs())
        .clamp(1, MAX_QUERY_TIMEOUT_SECS);
    let session_id = session_id.filter(|_| !matches!(conn.pool, Pool::Lite(_)));
    let run = async {
        match &session_id {
            // SQLite pools hold one connection, so every tab already shares one session.
            None => raw_pool_query(&conn.pool, &query).await,
            Some(session_id) => session_query(&conn, session_id, &query).await,
        }
    };
    match tokio::time::timeout(Duration::from_secs(seconds), run).await {
        Ok(result) => result,
        Err(_) => {
            let Some(session_id) = session_id else {
                return Err(format!("Query timed out after {seconds} seconds. A write may have committed; verify database state before retrying."));
            };
            // Dropping the client side does not stop the server, so cancel it there too.
            if let Some(slot) = session_slot(&conn, &session_id).await {
                let server_id = slot.server_id.lock().ok().and_then(|mut id| id.take());
                if let Some(server_id) = server_id {
                    let _ = timed(cancel_server_query(&conn, server_id)).await;
                }
            }
            Err(format!("Query timed out after {seconds} seconds and was cancelled on the server. This tab's session was reset, so any open transaction was rolled back."))
        }
    }
}
async fn database_names(conn: &Connection) -> DbResult<Vec<String>> {
    match &conn.pool {
        Pool::Pg(p) => sqlx::query_scalar::<_, String>("SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate AND has_database_privilege(current_user, oid, 'CONNECT') ORDER BY datname").fetch_all(p).await.map_err(err),
        Pool::My(p) => sqlx::query_scalar::<_, String>("SHOW DATABASES").fetch_all(p).await.map_err(err),
        Pool::Lite(_) => Ok(vec![PathBuf::from(&conn.config.file_path).file_name().unwrap_or_default().to_string_lossy().into()]),
    }
}
#[tauri::command]
async fn dbde_list_databases(
    connection_id: String,
    state: State<'_, AppState>,
) -> DbResult<Vec<String>> {
    let conn = connection(&state, &connection_id).await?;
    if conn.config.options.custom_database_list {
        return Ok(conn
            .config
            .options
            .database_list
            .iter()
            .map(|entry| entry.name.clone())
            .collect());
    }
    if conn.config.database_only && !matches!(conn.config.driver, Driver::Sqlite) {
        return Ok(vec![conn.config.database.clone()]);
    }
    timed(database_names(&conn)).await
}
// Discover using the unsaved settings, without registering a workspace connection.
// Display preferences do not restrict this temporary catalog lookup.
#[tauri::command]
async fn dbde_discover_databases(
    config: ConnectionConfig,
    state: State<'_, AppState>,
) -> DbResult<Vec<String>> {
    discover_databases(config, &state).await
}
async fn discover_databases(
    mut config: ConnectionConfig,
    state: &AppState,
) -> DbResult<Vec<String>> {
    config.database_only = false;
    config.options.custom_database_list = false;
    let (pool, tunnel) = timed(make_pool(&config, state)).await?;
    let conn = Connection {
        pool,
        tunnel,
        config,
        databases: Arc::new(Mutex::new(HashMap::new())),
        sessions: Arc::new(Mutex::new(HashMap::new())),
    };
    let result = timed(database_names(&conn)).await;
    close(conn.pool).await;
    result
}
#[tauri::command]
async fn dbde_get_schema_tree(
    connection_id: String,
    database: Option<String>,
    state: State<'_, AppState>,
) -> DbResult<SchemaTree> {
    load_schema_tree(&state, &connection_id, database.as_deref()).await
}
async fn load_schema_tree(
    state: &AppState,
    connection_id: &str,
    database: Option<&str>,
) -> DbResult<SchemaTree> {
    let conn = timed(schema_connection(state, connection_id, database)).await?;
    let sql = match conn.config.driver {
        Driver::Postgres => "SELECT t.table_name, t.table_schema, t.table_type, CASE WHEN c.relkind IN ('r','p') AND c.reltuples >= 0 THEN c.reltuples::bigint END AS table_rows, CASE WHEN c.relkind IN ('r','p') THEN pg_catalog.pg_relation_size(c.oid) END AS data_length, NULL::text AS engine, NULL::text AS created_date, NULL::text AS modified_date, NULL::text AS collation, pg_catalog.obj_description(c.oid, 'pg_class') AS comment FROM information_schema.tables t JOIN pg_catalog.pg_namespace n ON n.nspname = t.table_schema JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = t.table_name WHERE t.table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY t.table_schema, t.table_name",
        Driver::Mysql => "SELECT table_name, table_schema, table_type, table_rows, data_length, engine, CAST(create_time AS CHAR) AS created_date, CAST(update_time AS CHAR) AS modified_date, table_collation, table_comment FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name",
        Driver::Sqlite => "SELECT name, '' AS schema_name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    };
    let params = if matches!(conn.pool, Pool::My(_)) {
        vec![conn.config.database.clone()]
    } else {
        Vec::new()
    };
    let result = timed(query_with_params(&conn.pool, sql, &params)).await?;
    let tables = result
        .rows
        .iter()
        .map(|r| TableInfo {
            name: r[0].as_str().unwrap_or_default().into(),
            schema: r[1].as_str().unwrap_or_default().into(),
            kind: if r[2]
                .as_str()
                .unwrap_or_default()
                .to_lowercase()
                .contains("view")
            {
                "view"
            } else {
                "table"
            }
            .into(),
        })
        .collect();
    Ok(SchemaTree {
        database: if matches!(conn.config.driver, Driver::Sqlite) {
            PathBuf::from(&conn.config.file_path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into()
        } else {
            conn.config.database
        },
        tables,
        table_metadata: result.rows.iter().map(|row| table_metadata(row)).collect(),
    })
}
#[tauri::command]
async fn dbde_get_columns(
    connection_id: String,
    table: TableInfo,
    database: Option<String>,
    state: State<'_, AppState>,
) -> DbResult<Vec<ColumnInfo>> {
    let conn = timed(database_connection(
        &state,
        &connection_id,
        database.as_deref(),
    ))
    .await?;
    timed(column_meta::table_columns(&conn.pool, &table)).await
}
async fn read_profiles(state: &AppState) -> DbResult<Vec<ConnectionConfig>> {
    match tokio::fs::read(&state.profile_path).await {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(err),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(err(e)),
    }
}
async fn write_profiles(state: &AppState, profiles: &[ConnectionConfig]) -> DbResult<()> {
    let temp = state.profile_path.with_extension("tmp");
    tokio::fs::write(&temp, serde_json::to_vec_pretty(profiles).map_err(err)?)
        .await
        .map_err(err)?;
    tokio::fs::rename(&temp, &state.profile_path)
        .await
        .map_err(err)
}
#[tauri::command]
async fn dbde_list_profiles(state: State<'_, AppState>) -> DbResult<Vec<ConnectionConfig>> {
    let _guard = state.profiles.lock().await;
    read_profiles(&state).await
}
#[tauri::command]
async fn dbde_save_profile(
    mut config: ConnectionConfig,
    state: State<'_, AppState>,
) -> DbResult<()> {
    validate(&config)?;
    let _guard = state.profiles.lock().await;
    let mut profiles = read_profiles(&state).await?;
    // Keeping the stored password is only allowed while the server stays the same.
    if config.password.is_none()
        && !matches!(config.driver, Driver::Sqlite)
        && profiles
            .iter()
            .any(|saved| saved.id == config.id && !same_server(saved, &config))
    {
        return Err("Enter the password again when changing the host, port or user".into());
    }
    if config.options.ssh.enabled
        && config.options.ssh.password.is_none()
        && profiles
            .iter()
            .any(|saved| saved.id == config.id && !same_server(saved, &config))
    {
        return Err(
            "Enter the SSH password or key passphrase again when changing the server or SSH route."
                .into(),
        );
    }
    if let Some(secret) = config.options.ssh.password.take() {
        let id = config.id.clone();
        tokio::task::spawn_blocking(move || {
            keyring::Entry::new("com.dbde.desktop.ssh", &id)
                .map_err(err)?
                .set_password(&secret)
                .map_err(err)
        })
        .await
        .map_err(err)??;
    }
    if let Some(secret) = config.password.take() {
        if !matches!(config.driver, Driver::Sqlite) {
            let id = config.id.clone();
            tokio::task::spawn_blocking(move || {
                keyring::Entry::new("com.dbde.desktop", &id)
                    .map_err(err)?
                    .set_password(&secret)
                    .map_err(err)
            })
            .await
            .map_err(err)??;
        }
    }
    profiles.retain(|p| p.id != config.id);
    profiles.push(config);
    write_profiles(&state, &profiles).await
}
#[tauri::command]
async fn dbde_delete_profile(id: String, state: State<'_, AppState>) -> DbResult<()> {
    uuid::Uuid::from_str(&id).map_err(err)?;
    let _guard = state.profiles.lock().await;
    let mut profiles = read_profiles(&state).await?;
    if profiles
        .iter()
        .any(|p| p.id == id && !matches!(p.driver, Driver::Sqlite))
    {
        tokio::task::spawn_blocking({
            let id = id.clone();
            move || {
                for service in ["com.dbde.desktop", "com.dbde.desktop.ssh"] {
                    match keyring::Entry::new(service, &id)
                        .map_err(err)?
                        .delete_credential()
                    {
                        Ok(()) | Err(keyring::Error::NoEntry) => {}
                        Err(e) => return Err(err(e)),
                    }
                }
                Ok(())
            }
        })
        .await
        .map_err(err)??;
    }
    profiles.retain(|p| p.id != id);
    write_profiles(&state, &profiles).await
}
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            app.manage(windows::DetachedWindows::default());
            app.manage(updates::Updates::default());
            app.manage(export::Exports::default());
            app.manage(import::Imports::default());
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            app.manage(query_library::QueryLibrary::new(directory.clone()));
            app.manage(AppState {
                connections: Mutex::new(HashMap::new()),
                profiles: Mutex::new(()),
                profile_path: directory.join("connections.json"),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            updates::dbde_update_status,
            updates::dbde_check_update,
            updates::dbde_install_update,
            windows::dbde_move_tab_to_window,
            windows::dbde_get_detached_workspace,
            windows::dbde_close_detached_window,
            dbde_test_connection,
            dbde_connect,
            dbde_disconnect,
            dbde_close_session,
            dbde_cancel_query,
            dbde_session_in_transaction,
            dbde_get_schema_tree,
            dbde_list_databases,
            dbde_discover_databases,
            dbde_get_columns,
            column_meta::dbde_get_foreign_keys,
            dbde_execute_query,
            explain::dbde_explain_query,
            maintain::dbde_maintain_tables,
            dbde_list_profiles,
            dbde_save_profile,
            dbde_delete_profile,
            rows::dbde_view_table,
            rows::dbde_load_record,
            rows::dbde_delete_rows,
            rows::dbde_update_cell,
            rows::dbde_raw_cell,
            rows::dbde_insert_record,
            rows::dbde_insert_records,
            rows::dbde_apply_changes,
            table_designer::dbde_create_table,
            table_rename::dbde_rename_table_fields,
            table_alter::dbde_alter_table_fields,
            schema::dbde_list_indexes,
            objects::dbde_list_objects,
            objects::dbde_object_definition,
            objects::dbde_object_action,
            schema::dbde_table_ddl,
            table_actions::dbde_copy_table,
            table_actions::dbde_clear_table,
            table_actions::dbde_drop_table,
            table_actions::dbde_rename_table,
            table_actions::dbde_export_columns,
            database_actions::dbde_close_database,
            database_actions::dbde_manage_database,
            database_actions::dbde_open_sql_file,
            schema::dbde_save_file,
            export::dbde_export_table,
            export::dbde_export_rows,
            export::dbde_cancel_export,
            import::dbde_import_open,
            import::dbde_import_preview,
            import::dbde_import_close,
            import::dbde_import_target,
            import::dbde_import_count,
            import::dbde_import_run,
            import::dbde_cancel_import,
            query_library::dbde_history_list,
            query_library::dbde_history_append,
            query_library::dbde_history_delete,
            query_library::dbde_history_clear,
            query_library::dbde_library_list,
            query_library::dbde_library_save,
            query_library::dbde_library_delete
        ])
        .run(tauri::generate_context!())
        .expect("Failed to start DBde");
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn table_metadata_preserves_zero_counts_dates_and_missing_values() {
        let row = serde_json::json!([
            "orders",
            "shop",
            "BASE TABLE",
            0,
            16384,
            "InnoDB",
            "2026-10-16 10:20:30",
            null,
            "utf8mb4_unicode_ci",
            "Order records"
        ]);
        let metadata = table_metadata(row.as_array().unwrap());
        assert_eq!(metadata.rows, Some(0));
        assert_eq!(metadata.data_length, Some(16384));
        assert_eq!(
            metadata.created_date.as_deref(),
            Some("2026-10-16 10:20:30")
        );
        assert_eq!(metadata.modified_date, None);
        assert_eq!(metadata.comment.as_deref(), Some("Order records"));
        let sqlite =
            table_metadata(&[Value::from("orders"), Value::from(""), Value::from("table")]);
        assert_eq!(sqlite.rows, None);
        assert_eq!(sqlite.data_length, None);
        assert_eq!(sqlite.engine, None);
    }
    #[test]
    fn mysql_empty_password_is_omitted_without_trimming_nonempty_passwords() {
        // The options Debug representation exposes the underlying Option;
        // use only synthetic values here, never user credentials.
        let empty = mysql_password(sqlx::mysql::MySqlConnectOptions::new(), "");
        assert!(format!("{empty:?}").contains("password: None"));
        let spaces = mysql_password(sqlx::mysql::MySqlConnectOptions::new(), "  ");
        assert!(format!("{spaces:?}").contains("password: Some(\"  \")"));
    }
    #[tokio::test]
    async fn explicit_empty_password_does_not_read_the_credential_vault() {
        let mut config = config(Driver::Mysql);
        config.password = Some(String::new());
        assert_eq!(password(&config, &test_state()).await.unwrap(), "");
    }
    #[tokio::test]
    #[ignore = "Read-only integration test for local MySQL root without a password at 127.0.0.1:3306"]
    async fn mysql_local_empty_password_connects() {
        let mut config = config(Driver::Mysql);
        config.host = "127.0.0.1".into();
        config.port = 3306;
        config.username = "root".into();
        config.ssl_mode = "disable".into();
        config.password = Some(String::new());
        let state = test_state();
        assert!(test_connection(config.clone(), &state).await.unwrap());
        let (pool, _tunnel) = make_pool(&config, &state).await.unwrap();
        let result = query(&pool, "SELECT 1 AS connected").await.unwrap();
        assert_eq!(result.rows, vec![vec![json!(1)]]);
        close(pool).await;
    }
    #[test]
    fn mysql_timestamp_mapping_preserves_session_clock_and_fractional_seconds() {
        use sqlx::Type;
        let timestamp_type = <chrono::DateTime<chrono::Utc> as Type<sqlx::MySql>>::type_info();
        assert_eq!(timestamp_type.name(), "TIMESTAMP");
        assert!(<chrono::DateTime<chrono::Utc> as Type<sqlx::MySql>>::compatible(&timestamp_type));
        assert!(!<chrono::NaiveDateTime as Type<sqlx::MySql>>::compatible(
            &timestamp_type
        ));
        let clock = chrono::NaiveDate::from_ymd_opt(2026, 10, 13)
            .unwrap()
            .and_hms_micro_opt(15, 42, 11, 123456)
            .unwrap();
        assert_eq!(
            mysql_timestamp_value(clock.and_utc()),
            json!("2026-10-13 15:42:11.123456")
        );
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_MYSQL_URL pointing to a test database; creates only a session-local temporary table"]
    async fn mysql_timestamp_rows_decode_without_query_casts() {
        let url = std::env::var("DBDE_TEST_MYSQL_URL")
            .expect("Set DBDE_TEST_MYSQL_URL to a test database URL");
        let pool = sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        sqlx::query("SET time_zone = '+07:00'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("CREATE TEMPORARY TABLE dbde_timestamp_test (data_dibuat TIMESTAMP(6) NULL, local_clock DATETIME(6) NULL)").execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO dbde_timestamp_test VALUES ('2026-10-13 15:42:11.123456', '2026-10-13 15:42:11.123456'), (NULL, NULL)").execute(&pool).await.unwrap();
        let result = query(
            &Pool::My(pool.clone()),
            "SELECT data_dibuat, local_clock FROM dbde_timestamp_test ORDER BY data_dibuat IS NULL",
        )
        .await
        .unwrap();
        assert_eq!(
            result.rows,
            vec![
                vec![
                    json!("2026-10-13 15:42:11.123456"),
                    json!("2026-10-13 15:42:11.123456")
                ],
                vec![Value::Null, Value::Null]
            ]
        );
        sqlx::query("DROP TEMPORARY TABLE dbde_timestamp_test")
            .execute(&pool)
            .await
            .unwrap();
        pool.close().await;
    }
    // Uses session-local temporary tables only; nothing persists in the test database.
    pub(super) async fn server_connection(var: &str, driver: Driver) -> Connection {
        let url = std::env::var(var).unwrap_or_else(|_| panic!("Set {var} to a test database URL"));
        let pool = match driver {
            Driver::Postgres => Pool::Pg(
                sqlx::postgres::PgPoolOptions::new()
                    .max_connections(1)
                    .connect(&url)
                    .await
                    .unwrap(),
            ),
            _ => Pool::My(
                sqlx::mysql::MySqlPoolOptions::new()
                    .max_connections(1)
                    .connect(&url)
                    .await
                    .unwrap(),
            ),
        };
        Connection {
            tunnel: None,
            pool,
            config: config(driver),
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    async fn query_tabs_keep_their_own_session(conn: Connection, temp: &str) {
        let setup = format!("CREATE {temp} TABLE dbde_session (x INT); INSERT INTO dbde_session VALUES (1), (2); SELECT COUNT(*) AS n FROM dbde_session");
        let script = session_query(&conn, "tab-a", &setup).await.unwrap();
        assert_eq!(script.columns, vec!["n"]);
        assert_eq!(script.rows, vec![vec![json!(2)]]);
        // PostgreSQL also counts the SELECT row; both drivers report the two inserts.
        assert!(script.affected_rows >= 2);
        session_query(&conn, "tab-a", "BEGIN").await.unwrap();
        session_query(&conn, "tab-a", "INSERT INTO dbde_session VALUES (3)")
            .await
            .unwrap();
        assert!(session_query(&conn, "tab-a", "SELEC 1").await.is_err());
        let count = "SELECT COUNT(*) FROM dbde_session";
        if matches!(conn.config.driver, Driver::Mysql) {
            // MySQL keeps the transaction open after a failed statement.
            assert_eq!(
                session_query(&conn, "tab-a", count).await.unwrap().rows,
                vec![vec![json!(3)]]
            );
        }
        assert!(session_query(&conn, "tab-b", count).await.is_err());
        session_query(&conn, "tab-a", "ROLLBACK").await.unwrap();
        assert_eq!(
            session_query(&conn, "tab-a", count).await.unwrap().rows,
            vec![vec![json!(2)]]
        );
        let empty = session_query(
            &conn,
            "tab-a",
            "SELECT x AS only_header FROM dbde_session WHERE x < 0",
        )
        .await
        .unwrap();
        assert_eq!(empty.columns, vec!["only_header"]);
        assert!(empty.rows.is_empty());
        assert_eq!(conn.sessions.lock().await.len(), 2);
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_PG_URL; creates only session-local temporary tables"]
    async fn postgres_scripts_without_rows_do_not_abort_an_open_transaction() {
        let conn = server_connection("DBDE_TEST_PG_URL", Driver::Postgres).await;
        session_query(&conn, "tab-tx", "BEGIN").await.unwrap();
        // A script and a statement that cannot be described after running (the table
        // they created is gone, or there are several statements) must leave the
        // transaction usable.
        session_query(
            &conn,
            "tab-tx",
            "CREATE TEMPORARY TABLE dbde_tx (x int); INSERT INTO dbde_tx VALUES (1)",
        )
        .await
        .unwrap();
        session_query(&conn, "tab-tx", "CREATE TEMPORARY TABLE dbde_gone (x int)")
            .await
            .unwrap();
        session_query(&conn, "tab-tx", "DROP TABLE dbde_gone")
            .await
            .unwrap();
        let count = session_query(&conn, "tab-tx", "SELECT COUNT(*) AS n FROM dbde_tx")
            .await
            .unwrap();
        assert_eq!(count.rows, vec![vec![json!(1)]]);
        // An empty SELECT still reports its column headers.
        let empty = session_query(
            &conn,
            "tab-tx",
            "SELECT x AS header FROM dbde_tx WHERE false",
        )
        .await
        .unwrap();
        assert_eq!(empty.columns, vec!["header"]);
        session_query(&conn, "tab-tx", "ROLLBACK").await.unwrap();
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_PG_URL; creates only session-local temporary tables"]
    async fn postgres_query_tabs_keep_their_own_session() {
        let conn = server_connection("DBDE_TEST_PG_URL", Driver::Postgres).await;
        query_tabs_keep_their_own_session(conn, "TEMPORARY").await;
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_MYSQL_URL; creates only session-local temporary tables"]
    async fn mysql_query_tabs_keep_their_own_session() {
        let conn = server_connection("DBDE_TEST_MYSQL_URL", Driver::Mysql).await;
        query_tabs_keep_their_own_session(conn, "TEMPORARY").await;
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_PG_URL; creates only session-local temporary tables"]
    async fn postgres_row_writes_use_typed_key_lookups() {
        let conn = server_connection("DBDE_TEST_PG_URL", Driver::Postgres).await;
        query(&conn.pool, "CREATE TEMPORARY TABLE dbde_keys (tenant TEXT, id INT, at TIMESTAMPTZ, note TEXT, PRIMARY KEY (tenant, id, at))").await.unwrap();
        query(&conn.pool, "INSERT INTO dbde_keys VALUES ('a', 1, '2026-10-13T15:42:11.5Z', NULL), ('a', 2, '2026-10-13T15:42:11.5Z', NULL)").await.unwrap();
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
            name: "dbde_keys".into(),
            schema,
            kind: "table".into(),
        };
        let rows = rows::tests_support::view(&conn, table.clone()).await;
        let key = |row: &Vec<Value>| {
            HashMap::from([
                ("tenant".to_string(), row[0].clone()),
                ("id".to_string(), row[1].clone()),
                ("at".to_string(), row[2].clone()),
            ])
        };
        rows::tests_support::update(&conn, &table, &key(&rows[0]), "note", Some("seen".into()))
            .await
            .unwrap();
        assert_eq!(
            rows::tests_support::delete(&conn, &table, &[key(&rows[1])])
                .await
                .unwrap(),
            1
        );
        let left = query(&conn.pool, "SELECT id, note FROM dbde_keys")
            .await
            .unwrap();
        assert_eq!(left.rows, vec![vec![json!(1), json!("seen")]]);
    }
    async fn cancel_stops_the_running_statement(conn: Connection, sleep: &str) {
        session_query(&conn, "tab-c", "SELECT 1").await.unwrap();
        let slot = session_slot(&conn, "tab-c").await.unwrap();
        let server_id = slot.server_id.lock().unwrap().unwrap();
        let started = Instant::now();
        let (result, _) = tokio::join!(session_query(&conn, "tab-c", sleep), async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            cancel_server_query(&conn, server_id).await.unwrap();
        });
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "query was not cancelled"
        );
        // PostgreSQL reports an error; MySQL may return the interrupted SLEEP's value.
        let _ = result;
        // The session survives a cancel and keeps working.
        let after = session_query(&conn, "tab-c", "SELECT 2 AS two")
            .await
            .unwrap();
        assert_eq!(after.rows, vec![vec![json!(2)]]);
        let mut guard = slot.session.lock().await;
        let session = guard.as_mut().unwrap();
        assert!(!session_in_transaction(session).await);
        drop(guard);
        session_query(&conn, "tab-c", "BEGIN").await.unwrap();
        let mut guard = slot.session.lock().await;
        assert!(session_in_transaction(guard.as_mut().unwrap()).await);
        drop(guard);
        session_query(&conn, "tab-c", "ROLLBACK").await.unwrap();
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_PG_URL"]
    async fn postgres_cancel_and_transaction_state() {
        let conn = server_connection("DBDE_TEST_PG_URL", Driver::Postgres).await;
        cancel_stops_the_running_statement(conn, "SELECT pg_sleep(20)").await;
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_MYSQL_URL"]
    async fn mysql_cancel_and_transaction_state() {
        let conn = server_connection("DBDE_TEST_MYSQL_URL", Driver::Mysql).await;
        cancel_stops_the_running_statement(conn, "SELECT SLEEP(20)").await;
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_PG_URL; creates only session-local temporary objects"]
    async fn postgres_uncommon_types_render_instead_of_failing() {
        let conn = server_connection("DBDE_TEST_PG_URL", Driver::Postgres).await;
        let sql = "SELECT ARRAY['a','b']::text[] AS tags, interval '1 day 2 hours' AS span, inet '10.0.0.1' AS ip, 12.50::numeric AS price, '2026-10-13 15:42:11+00'::timestamptz AS at, '\\x0aff'::bytea AS raw, '{\"k\": 1}'::jsonb AS doc, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid AS id, true AS ok";
        let r = session_query(&conn, "tab-t", sql).await.unwrap();
        assert_eq!(r.rows[0][0], json!("{a,b}"));
        assert_eq!(r.rows[0][1], json!("1 day 02:00:00"));
        assert_eq!(r.rows[0][2], json!("10.0.0.1"));
        assert_eq!(r.rows[0][3], json!("12.50"));
        assert_eq!(r.rows[0][4], json!("2026-10-13T15:42:11+00:00"));
        assert_eq!(r.rows[0][5], json!({"hex": "0aff"}));
        assert_eq!(r.rows[0][6], json!({"k": 1}));
        assert_eq!(r.rows[0][7], json!("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"));
        assert_eq!(r.rows[0][8], json!(true));
        // Table view goes through the pool; its single connection sees the temp objects.
        raw_pool_query(&conn.pool, "CREATE TYPE pg_temp.dbde_mood AS ENUM ('calm', 'busy'); CREATE TEMPORARY TABLE dbde_types (id int PRIMARY KEY, mood pg_temp.dbde_mood, tags text[], span interval); INSERT INTO dbde_types VALUES (1, 'busy', '{x,y}', '3 hours')").await.unwrap();
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
            name: "dbde_types".into(),
            schema,
            kind: "table".into(),
        };
        let view = rows::tests_support::view(&conn, table.clone()).await;
        assert_eq!(
            view,
            vec![vec![
                json!(1),
                json!("busy"),
                json!("{x,y}"),
                json!("03:00:00")
            ]]
        );
        let filtered =
            rows::tests_support::filtered(&conn, table, "mood", "us'; DROP TABLE x; --").await;
        assert!(filtered.is_empty());
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_PG_URL as a superuser; changes only a temporary table's statistics"]
    async fn postgres_large_tables_use_the_planner_estimate() {
        let conn = server_connection("DBDE_TEST_PG_URL", Driver::Postgres).await;
        raw_pool_query(&conn.pool, "CREATE TEMPORARY TABLE dbde_big (id int PRIMARY KEY); INSERT INTO dbde_big SELECT generate_series(1, 30); UPDATE pg_class SET reltuples = 2500000 WHERE oid = 'dbde_big'::regclass").await.unwrap();
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
            name: "dbde_big".into(),
            schema,
            kind: "table".into(),
        };
        let page = rows::tests_support::page_json(&conn, table.clone(), &[]).await;
        assert_eq!(page["total_rows"], json!(2_500_000));
        assert_eq!(page["estimated"], json!(true));
        // Filters always count exactly.
        let filtered = rows::tests_support::page_json(&conn, table, &["id", "1"]).await;
        assert_eq!(filtered["total_rows"], json!(12));
        assert!(filtered.get("estimated").is_none());
    }
    #[tokio::test]
    async fn sqlite_untyped_numeric_keys_still_match() {
        let pool = Pool::Lite(
            sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap(),
        );
        query(&pool, "CREATE TABLE loose (id PRIMARY KEY, note)")
            .await
            .unwrap();
        query(
            &pool,
            "INSERT INTO loose VALUES (7, 'seven'), ('7', 'text seven')",
        )
        .await
        .unwrap();
        let conn = Connection {
            tunnel: None,
            pool,
            config: config(Driver::Sqlite),
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        };
        let table = TableInfo {
            name: "loose".into(),
            schema: "".into(),
            kind: "table".into(),
        };
        let key = HashMap::from([("id".to_string(), json!(7))]);
        rows::tests_support::update(&conn, &table, &key, "note", Some("number".into()))
            .await
            .unwrap();
        let text_key = HashMap::from([("id".to_string(), json!("7"))]);
        assert_eq!(
            rows::tests_support::delete(&conn, &table, &[text_key])
                .await
                .unwrap(),
            1
        );
        let left = query(&conn.pool, "SELECT id, note FROM loose")
            .await
            .unwrap();
        assert_eq!(left.rows, vec![vec![json!(7), json!("number")]]);
    }
    fn test_state() -> AppState {
        AppState {
            connections: Mutex::new(HashMap::new()),
            profiles: Mutex::new(()),
            profile_path: std::env::temp_dir()
                .join(format!("dbde-test-{}.json", uuid::Uuid::new_v4())),
        }
    }
    #[tokio::test]
    async fn stored_passwords_only_reach_the_saved_server() {
        let state = test_state();
        let mut saved = config(Driver::Postgres);
        saved.password = None;
        write_profiles(&state, std::slice::from_ref(&saved))
            .await
            .unwrap();
        assert!(saved_profile_matches(&state, &saved).await.unwrap());
        let mut redirected = saved.clone();
        redirected.host = "attacker.example".into();
        assert!(password(&redirected, &state).await.is_err());
        let mut unknown = saved.clone();
        unknown.id = uuid::Uuid::new_v4().to_string();
        assert!(password(&unknown, &state).await.is_err());
        let _ = std::fs::remove_file(&state.profile_path);
    }
    #[test]
    fn only_single_row_returning_statements_are_described() {
        for yes in [
            "SELECT 1",
            "  -- note\n select * from t;",
            "/* c */ WITH x AS (SELECT 1) SELECT * FROM x",
            "values (1)",
            "SHOW TABLES",
            "PRAGMA table_info(t)",
        ] {
            assert!(describes_rows(yes), "{yes}");
        }
        for no in [
            "BEGIN",
            "DROP TABLE t",
            "INSERT INTO t VALUES (1)",
            "CREATE TABLE t (x int); INSERT INTO t VALUES (1)",
            "SELECT 1; SELECT 2",
            "",
        ] {
            assert!(!describes_rows(no), "{no}");
        }
    }
    pub(super) fn config(driver: Driver) -> ConnectionConfig {
        ConnectionConfig {
            options: Default::default(),
            id: uuid::Uuid::new_v4().to_string(),
            name: "Server".into(),
            driver,
            host: "localhost".into(),
            port: 5432,
            username: "user".into(),
            password: Some("".into()),
            database: "".into(),
            database_only: false,
            ssl_mode: "require".into(),
            file_path: ":memory:".into(),
        }
    }
    #[test]
    fn server_connections_allow_an_empty_initial_database() {
        assert!(validate(&config(Driver::Postgres)).is_ok());
        assert!(validate(&config(Driver::Mysql)).is_ok());
        let mut invalid = config(Driver::Mysql);
        invalid.host.clear();
        assert!(validate(&invalid).is_err());
        let mut invalid = config(Driver::Sqlite);
        invalid.file_path.clear();
        assert!(validate(&invalid).is_err());
    }
    #[test]
    fn focused_profiles_require_a_database_and_round_trip() {
        let mut c = config(Driver::Mysql);
        c.database_only = true;
        assert!(validate(&c).is_err());
        c.database = "app_db".into();
        assert!(validate(&c).is_ok());
        let saved = serde_json::to_value(&c).unwrap();
        assert_eq!(saved["database_only"], true);
        let loaded: ConnectionConfig = serde_json::from_value(saved.clone()).unwrap();
        assert!(loaded.database_only);
        let mut legacy = saved;
        legacy.as_object_mut().unwrap().remove("database_only");
        let loaded: ConnectionConfig = serde_json::from_value(legacy).unwrap();
        assert!(!loaded.database_only);
    }
    #[tokio::test]
    async fn catalog_preview_ignores_display_filters_and_does_not_register_connections() {
        let mut config = config(Driver::Sqlite);
        config.options.custom_database_list = true;
        config.database_only = true;
        let state = test_state();
        assert_eq!(
            discover_databases(config, &state).await.unwrap(),
            vec![":memory:"]
        );
        assert!(state.connections.lock().await.is_empty());
    }
    #[tokio::test]
    async fn mysql_schema_navigation_reuses_the_server_pool_without_connecting() {
        // A lazy pool cannot reach a database. Metadata routing must still work
        // without opening additional pools or altering connection options.
        let mut config = config(Driver::Mysql);
        config.database = "original".into();
        let pool = sqlx::mysql::MySqlPoolOptions::new()
            .connect_lazy_with(sqlx::mysql::MySqlConnectOptions::new().database("original"));
        let conn = Connection {
            tunnel: None,
            pool: Pool::My(pool.clone()),
            config,
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        };
        let state = AppState {
            connections: Mutex::new(HashMap::from([("server".into(), conn)])),
            profiles: Mutex::new(()),
            profile_path: PathBuf::new(),
        };
        let (a, b) = tokio::join!(
            schema_connection(&state, "server", Some("other database")),
            schema_connection(&state, "server", Some("third_database")),
        );
        assert_eq!(a.unwrap().config.database, "other database");
        assert_eq!(b.unwrap().config.database, "third_database");
        assert_eq!(pool.size(), 0);
        assert_eq!(pool.connect_options().get_database(), Some("original"));
        let original = connection(&state, "server").await.unwrap();
        assert_eq!(original.config.database, "original");
        assert!(original.databases.lock().await.is_empty());
        assert!(schema_connection(&state, "missing", Some("other"))
            .await
            .is_err());
        pool.close().await;
    }
    #[tokio::test]
    #[ignore = "requires DBDE_TEST_MYSQL_URL; read-only MySQL/MariaDB/TiDB integration"]
    async fn mysql_schema_navigation_reads_other_databases_without_new_pools() {
        let url = std::env::var("DBDE_TEST_MYSQL_URL").expect("Set DBDE_TEST_MYSQL_URL");
        let options = sqlx::mysql::MySqlConnectOptions::from_str(&url).unwrap();
        let mut config = config(Driver::Mysql);
        config.database = options.get_database().unwrap_or_default().into();
        let pool = sqlx::mysql::MySqlPoolOptions::new()
            .max_connections(1)
            .connect_with(options)
            .await
            .unwrap();
        let before: Option<String> = sqlx::query_scalar("SELECT DATABASE()")
            .fetch_one(&pool)
            .await
            .unwrap();
        let databases: Vec<String> = sqlx::query_scalar("SHOW DATABASES")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert!(!databases.is_empty());
        let conn = Connection {
            tunnel: None,
            pool: Pool::My(pool.clone()),
            config,
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        };
        let state = AppState {
            connections: Mutex::new(HashMap::from([("server".into(), conn)])),
            profiles: Mutex::new(()),
            profile_path: PathBuf::new(),
        };
        for database in databases.iter().take(3) {
            let tree = load_schema_tree(&state, "server", Some(database))
                .await
                .unwrap();
            assert_eq!(&tree.database, database);
            assert!(tree.tables.iter().all(|table| &table.schema == database));
            let expected: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = ?",
            )
            .bind(database)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(tree.tables.len() as i64, expected);
        }
        let after: Option<String> = sqlx::query_scalar("SELECT DATABASE()")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(before, after);
        assert!(connection(&state, "server")
            .await
            .unwrap()
            .databases
            .lock()
            .await
            .is_empty());
        pool.close().await;
    }
    #[tokio::test]
    async fn sqlite_database_discovery_keeps_the_same_file_pool() {
        let config = config(Driver::Sqlite);
        let (pool, _tunnel) = make_pool(&config, &test_state()).await.unwrap();
        let conn = Connection {
            tunnel: None,
            pool,
            config,
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        };
        assert_eq!(database_names(&conn).await.unwrap(), vec![":memory:"]);
        query(&conn.pool, "CREATE TABLE sample (id INTEGER)")
            .await
            .unwrap();
        let state = AppState {
            connections: Mutex::new(HashMap::from([("server".into(), conn)])),
            profiles: Mutex::new(()),
            profile_path: PathBuf::new(),
        };
        let selected = database_connection(&state, "server", Some(":memory:"))
            .await
            .unwrap();
        let schema = query(
            &selected.pool,
            "SELECT name FROM sqlite_master WHERE type = 'table'",
        )
        .await
        .unwrap();
        assert_eq!(schema.rows, vec![vec![json!("sample")]]);
        assert!(selected.databases.lock().await.is_empty());
        assert!(database_connection(&state, "missing", Some(":memory:"))
            .await
            .is_err());
    }
    #[tokio::test]
    async fn sqlite_queries_preserve_types_and_empty_columns() {
        let pool = Pool::Lite(
            sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap(),
        );
        query(
            &pool,
            "CREATE TABLE sample (id INTEGER, name TEXT, optional TEXT)",
        )
        .await
        .unwrap();
        let changed = query(&pool, "INSERT INTO sample VALUES (42, 'hello', NULL)")
            .await
            .unwrap();
        assert_eq!(changed.affected_rows, 1);
        let result = query(&pool, "SELECT * FROM sample").await.unwrap();
        assert_eq!(result.rows[0], vec![json!(42), json!("hello"), Value::Null]);
        let empty = query(&pool, "SELECT * FROM sample WHERE id = 0")
            .await
            .unwrap();
        assert_eq!(empty.columns, vec!["id", "name", "optional"]);
        assert!(empty.rows.is_empty());
        assert!(query(&pool, "SELECT * FROM nonexistent").await.is_err());
    }
    #[tokio::test]
    async fn sqlite_limits_large_results() {
        let pool = Pool::Lite(
            sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(1)
                .connect("sqlite::memory:")
                .await
                .unwrap(),
        );
        let result = query(&pool, "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 50001) SELECT n FROM seq").await.unwrap();
        assert_eq!(result.rows.len(), MAX_ROWS);
        assert!(result.truncated);
    }
    #[test]
    fn credentials_never_serialize() {
        let config = ConnectionConfig {
            options: Default::default(),
            id: uuid::Uuid::new_v4().to_string(),
            name: "test".into(),
            driver: Driver::Postgres,
            host: "localhost".into(),
            port: 5432,
            username: "user".into(),
            password: Some("top-secret".into()),
            database: "test".into(),
            database_only: false,
            ssl_mode: "require".into(),
            file_path: "".into(),
        };
        assert!(!serde_json::to_string(&config)
            .unwrap()
            .contains("top-secret"));
        assert_eq!(
            safe_error("failed top-secret", "top-secret"),
            "failed [redacted]"
        );
    }
}
