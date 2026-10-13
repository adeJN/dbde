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
mod rows;

const MAX_ROWS: usize = 50_000;
const DEADLINE: Duration = Duration::from_secs(30);
const MAX_SESSIONS: usize = 16;
type DbResult<T> = Result<T, String>;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Driver {
    Postgres,
    Mysql,
    Sqlite,
}
#[derive(Clone, Serialize, Deserialize)]
struct ConnectionConfig {
    id: String,
    name: String,
    driver: Driver,
    host: String,
    port: u16,
    username: String,
    #[serde(default, skip_serializing)]
    password: Option<String>,
    database: String,
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
type SessionSlot = Arc<Mutex<Option<Session>>>;
#[derive(Clone)]
struct Connection {
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
}
#[derive(Serialize)]
struct ColumnInfo {
    name: String,
    data_type: String,
    nullable: bool,
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
    if !["disable", "require", "verify-full"].contains(&config.ssl_mode.as_str()) {
        return Err("Invalid SSL mode".into());
    }
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
async fn password(config: &ConnectionConfig) -> DbResult<String> {
    if let Some(password) = &config.password {
        return Ok(password.clone());
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
async fn make_pool(config: &ConnectionConfig) -> DbResult<Pool> {
    validate(config)?;
    if let Driver::Sqlite = config.driver {
        let options = sqlx::sqlite::SqliteConnectOptions::new()
            .filename(&config.file_path)
            .create_if_missing(true)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));
        return sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(options)
            .await
            .map(Pool::Lite)
            .map_err(err);
    }
    let secret = password(config).await?;
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
            sqlx::postgres::PgPoolOptions::new()
                .max_connections(3)
                .min_connections(0)
                .acquire_timeout(Duration::from_secs(10))
                .idle_timeout(Duration::from_secs(60))
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
            sqlx::mysql::MySqlPoolOptions::new()
                .max_connections(3)
                .min_connections(0)
                .acquire_timeout(Duration::from_secs(10))
                .idle_timeout(Duration::from_secs(60))
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
    let pool = {
        let mut pools = conn.databases.lock().await;
        if let Some(pool) = pools.get(database) {
            pool.clone()
        } else {
            let pool = match &conn.pool {
                Pool::Pg(p) => {
                    let options = p.connect_options().as_ref().clone().database(database);
                    sqlx::postgres::PgPoolOptions::new()
                        .max_connections(2)
                        .min_connections(0)
                        .acquire_timeout(Duration::from_secs(10))
                        .idle_timeout(Duration::from_secs(60))
                        .connect_with(options)
                        .await
                        .map(Pool::Pg)
                        .map_err(err)?
                }
                Pool::My(p) => {
                    let options = p.connect_options().as_ref().clone().database(database);
                    sqlx::mysql::MySqlPoolOptions::new()
                        .max_connections(2)
                        .min_connections(0)
                        .acquire_timeout(Duration::from_secs(10))
                        .idle_timeout(Duration::from_secs(60))
                        .connect_with(options)
                        .await
                        .map(Pool::My)
                        .map_err(err)?
                }
                Pool::Lite(p) => Pool::Lite(p.clone()),
            };
            pools.insert(database.into(), pool.clone());
            pool
        }
    };
    conn.pool = pool;
    conn.config.database = database.into();
    Ok(conn)
}
async fn timed<T>(future: impl std::future::Future<Output = DbResult<T>>) -> DbResult<T> {
    tokio::time::timeout(DEADLINE, future).await.map_err(|_| "Operation timed out after 30 seconds. A write may have committed; verify database state before retrying.".to_string())?
}
#[tauri::command]
async fn dbde_test_connection(config: ConnectionConfig) -> DbResult<bool> {
    timed(async {
        let pool = make_pool(&config).await?;
        close(pool).await;
        Ok(true)
    })
    .await
}
#[tauri::command]
async fn dbde_connect(config: ConnectionConfig, state: State<'_, AppState>) -> DbResult<String> {
    let pool = timed(make_pool(&config)).await?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut config = config;
    config.password = None;
    state.connections.lock().await.insert(
        id.clone(),
        Connection {
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
        if let Some(session) = slot.lock().await.take() {
            close_session(session).await;
        }
    });
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
    Err(format!(
        "Unsupported PostgreSQL type {} in column {}. Cast it to TEXT in the query.",
        row.columns()[i].type_info().name(),
        row.columns()[i].name()
    ))
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
    Err(format!(
        "Unsupported MySQL type {} in column {}. Cast it to CHAR in the query.",
        row.columns()[i].type_info().name(),
        row.columns()[i].name()
    ))
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
        if result.columns.is_empty() {
            // Rows carry column names, so an empty SELECT needs a describe to keep its headers.
            // Scripts and statements that cannot be described simply report no columns.
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
async fn open_session(conn: &Connection) -> DbResult<SessionConn> {
    match &conn.pool {
        Pool::Pg(p) => sqlx::PgConnection::connect_with(p.connect_options().as_ref())
            .await
            .map(SessionConn::Pg)
            .map_err(err),
        Pool::My(p) => sqlx::MySqlConnection::connect_with(p.connect_options().as_ref())
            .await
            .map(SessionConn::My)
            .map_err(err),
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
        if !sessions.contains_key(session_id) && sessions.len() >= MAX_SESSIONS {
            return Err(format!(
                "At most {MAX_SESSIONS} query tabs can run on one connection. Close a tab and try again."
            ));
        }
        sessions.entry(session_id.into()).or_default().clone()
    };
    // Holding the slot serialises a tab's queries. If the deadline drops this future,
    // the taken connection is dropped with it and the server rolls back its transaction.
    let mut guard = slot.lock().await;
    let mut session = match guard.take() {
        Some(session) if session.database == conn.config.database => session,
        previous => {
            if let Some(previous) = previous {
                close_session(previous).await;
            }
            Session {
                conn: open_session(conn).await?,
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
    state: State<'_, AppState>,
) -> DbResult<QueryResult> {
    if query.trim().is_empty() {
        return Err("Query is empty".into());
    }
    if query.len() > 1_000_000 {
        return Err("Query exceeds the 1 MB limit".into());
    }
    timed(async {
        let conn = database_connection(&state, &connection_id, database.as_deref()).await?;
        match (&conn.pool, session_id) {
            // SQLite pools hold one connection, so every tab already shares one session.
            (Pool::Lite(_), _) | (_, None) => raw_pool_query(&conn.pool, &query).await,
            (_, Some(session_id)) => session_query(&conn, &session_id, &query).await,
        }
    })
    .await
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
    timed(database_names(&conn)).await
}
#[tauri::command]
async fn dbde_get_schema_tree(
    connection_id: String,
    database: Option<String>,
    state: State<'_, AppState>,
) -> DbResult<SchemaTree> {
    let conn = timed(database_connection(
        &state,
        &connection_id,
        database.as_deref(),
    ))
    .await?;
    let sql = match conn.config.driver {
        Driver::Postgres => "SELECT table_name, table_schema, table_type FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name",
        Driver::Mysql => "SELECT table_name, table_schema, table_type FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name",
        Driver::Sqlite => "SELECT name, '' AS schema_name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    };
    let result = timed(query(&conn.pool, sql)).await?;
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
    timed(async {
        match &conn.pool {
            Pool::Pg(p) => { let rows = sqlx::query("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position").bind(&table.schema).bind(&table.name).fetch_all(p).await.map_err(err)?; rows.iter().map(|r| Ok(ColumnInfo { name: r.try_get(0).map_err(err)?, data_type: r.try_get(1).map_err(err)?, nullable: r.try_get::<String, _>(2).map_err(err)? == "YES" })).collect() },
            Pool::My(p) => { let rows = sqlx::query("SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position").bind(&table.schema).bind(&table.name).fetch_all(p).await.map_err(err)?; rows.iter().map(|r| Ok(ColumnInfo { name: r.try_get(0).map_err(err)?, data_type: r.try_get(1).map_err(err)?, nullable: r.try_get::<String, _>(2).map_err(err)? == "YES" })).collect() },
            Pool::Lite(p) => { let rows = sqlx::query("SELECT name, type, \"notnull\" FROM pragma_table_info(?)").bind(&table.name).fetch_all(p).await.map_err(err)?; rows.iter().map(|r| Ok(ColumnInfo { name: r.try_get(0).map_err(err)?, data_type: r.try_get(1).map_err(err)?, nullable: r.try_get::<i64, _>(2).map_err(err)? == 0 })).collect() },
        }
    }).await
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
            move || match keyring::Entry::new("com.dbde.desktop", &id)
                .map_err(err)?
                .delete_credential()
            {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(err(e)),
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
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            app.manage(AppState {
                connections: Mutex::new(HashMap::new()),
                profiles: Mutex::new(()),
                profile_path: directory.join("connections.json"),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            dbde_test_connection,
            dbde_connect,
            dbde_disconnect,
            dbde_close_session,
            dbde_get_schema_tree,
            dbde_list_databases,
            dbde_get_columns,
            dbde_execute_query,
            dbde_list_profiles,
            dbde_save_profile,
            dbde_delete_profile,
            rows::dbde_view_table,
            rows::dbde_delete_rows,
            rows::dbde_update_cell,
            rows::dbde_insert_record
        ])
        .run(tauri::generate_context!())
        .expect("Failed to start DBde");
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert_eq!(password(&config).await.unwrap(), "");
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
        assert!(dbde_test_connection(config.clone()).await.unwrap());
        let pool = make_pool(&config).await.unwrap();
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
    async fn server_connection(var: &str, driver: Driver) -> Connection {
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
    pub(super) fn config(driver: Driver) -> ConnectionConfig {
        ConnectionConfig {
            id: uuid::Uuid::new_v4().to_string(),
            name: "Server".into(),
            driver,
            host: "localhost".into(),
            port: 5432,
            username: "user".into(),
            password: Some("".into()),
            database: "".into(),
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
    #[tokio::test]
    async fn sqlite_database_discovery_keeps_the_same_file_pool() {
        let config = config(Driver::Sqlite);
        let pool = make_pool(&config).await.unwrap();
        let conn = Connection {
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
            id: uuid::Uuid::new_v4().to_string(),
            name: "test".into(),
            driver: Driver::Postgres,
            host: "localhost".into(),
            port: 5432,
            username: "user".into(),
            password: Some("top-secret".into()),
            database: "test".into(),
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
