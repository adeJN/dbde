//! Database objects beyond tables and views: routines, triggers, events, sequences and
//! materialized views. Catalog lookups bind names as parameters; generated statements
//! quote every identifier, and PostgreSQL routine signatures always come from the catalog.
use super::*;
use rows::quote;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ObjectKind {
    Function,
    Procedure,
    Trigger,
    Event,
    Sequence,
    MaterializedView,
}
impl ObjectKind {
    fn label(self) -> &'static str {
        match self {
            Self::Function => "function",
            Self::Procedure => "procedure",
            Self::Trigger => "trigger",
            Self::Event => "event",
            Self::Sequence => "sequence",
            Self::MaterializedView => "materialized view",
        }
    }
    fn keyword(self) -> &'static str {
        match self {
            Self::Function => "FUNCTION",
            Self::Procedure => "PROCEDURE",
            Self::Trigger => "TRIGGER",
            Self::Event => "EVENT",
            Self::Sequence => "SEQUENCE",
            Self::MaterializedView => "MATERIALIZED VIEW",
        }
    }
}
/// Object kinds each driver has; others are rejected before any SQL is built.
pub(crate) fn supported_kinds(driver: &Driver) -> &'static [ObjectKind] {
    use ObjectKind::*;
    match driver {
        Driver::Postgres => &[Function, Procedure, Trigger, Sequence, MaterializedView],
        Driver::Mysql => &[Function, Procedure, Trigger, Event],
        Driver::Sqlite => &[Trigger],
    }
}
fn check_kind(driver: &Driver, kind: ObjectKind) -> DbResult<()> {
    if supported_kinds(driver).contains(&kind) {
        Ok(())
    } else {
        Err(format!("This database does not support {}s.", kind.label()))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub(crate) struct DbObject {
    kind: ObjectKind,
    #[serde(default)]
    schema: String,
    name: String,
    /// The table a trigger belongs to.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    table: Option<String>,
    /// PostgreSQL argument types identifying an overloaded function or procedure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    signature: Option<String>,
    // The fields below are display-only and never used to build SQL.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    /// "trigger" for PostgreSQL trigger functions, which cannot be called directly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    flag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    increment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    start: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    comment: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    refresh_concurrently: bool,
}
fn object(kind: ObjectKind, schema: &str, name: String) -> DbObject {
    DbObject {
        kind,
        schema: schema.into(),
        name,
        table: None,
        signature: None,
        detail: None,
        status: None,
        flag: None,
        last_value: None,
        increment: None,
        start: None,
        comment: None,
        refresh_concurrently: false,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ObjectAction {
    Drop,
    Enable,
    Disable,
    Refresh,
    RefreshConcurrently,
    Restart,
}

fn valid_name(value: &str, what: &str) -> DbResult<()> {
    if value.contains('\0') || value.chars().count() > 256 {
        return Err(format!("The {what} name is not valid."));
    }
    Ok(())
}
/// Checks an object from the webview and fills in the schema each driver expects.
fn validate_object(conn: &Connection, mut object: DbObject) -> DbResult<DbObject> {
    let driver = &conn.config.driver;
    check_kind(driver, object.kind)?;
    if object.name.trim().is_empty() {
        return Err("Choose an object.".into());
    }
    valid_name(&object.name, "object")?;
    valid_name(&object.schema, "schema")?;
    if let Some(table) = &object.table {
        valid_name(table, "table")?;
    }
    if object.signature.as_ref().is_some_and(|s| s.len() > 4096) {
        return Err("The argument list is too long.".into());
    }
    match driver {
        Driver::Postgres => {
            if object.schema.is_empty() {
                return Err("PostgreSQL objects need a schema.".into());
            }
        }
        Driver::Mysql => {
            if object.schema.is_empty() {
                object.schema = conn.config.database.clone();
            }
            if object.schema != conn.config.database {
                return Err("The object does not belong to the selected database.".into());
            }
        }
        Driver::Sqlite => {
            if !object.schema.is_empty() && object.schema != "main" {
                return Err("Only objects in the main SQLite database are supported.".into());
            }
            object.schema.clear();
        }
    }
    if object.kind == ObjectKind::Trigger
        && *driver == Driver::Postgres
        && object.table.as_deref().unwrap_or("").is_empty()
    {
        return Err("Choose the trigger's table.".into());
    }
    Ok(object)
}
/// The schema-qualified, quoted name of an object (SQLite names are unqualified).
fn target(object: &DbObject, driver: &Driver) -> String {
    if object.schema.is_empty() {
        quote(&object.name, driver)
    } else {
        format!(
            "{}.{}",
            quote(&object.schema, driver),
            quote(&object.name, driver)
        )
    }
}
fn pg_trigger_table(object: &DbObject) -> String {
    format!(
        "{}.{}",
        quote(&object.schema, &Driver::Postgres),
        quote(object.table.as_deref().unwrap_or(""), &Driver::Postgres)
    )
}
/// The statement an action runs. PostgreSQL routine signatures must already be resolved
/// from the catalog (see `resolve`); they are never taken verbatim from the webview.
pub(crate) fn action_sql(
    object: &DbObject,
    driver: &Driver,
    action: ObjectAction,
    value: Option<&str>,
) -> DbResult<String> {
    use ObjectAction::*;
    use ObjectKind::*;
    check_kind(driver, object.kind)?;
    let name = target(object, driver);
    match (action, object.kind) {
        (Drop, Function | Procedure) if *driver == Driver::Postgres => {
            let signature = object
                .signature
                .as_deref()
                .ok_or("The argument list of this routine is unknown. Refresh and try again.")?;
            Ok(format!(
                "DROP {} {name}({signature})",
                object.kind.keyword()
            ))
        }
        (Drop, Trigger) if *driver == Driver::Postgres => Ok(format!(
            "DROP TRIGGER {} ON {}",
            quote(&object.name, driver),
            pg_trigger_table(object)
        )),
        (Drop, kind) => Ok(format!("DROP {} {name}", kind.keyword())),
        (Enable | Disable, Event) => Ok(format!(
            "ALTER EVENT {name} {}",
            if action == Enable {
                "ENABLE"
            } else {
                "DISABLE"
            }
        )),
        (Refresh, MaterializedView) => Ok(format!("REFRESH MATERIALIZED VIEW {name}")),
        (RefreshConcurrently, MaterializedView) => {
            Ok(format!("REFRESH MATERIALIZED VIEW CONCURRENTLY {name}"))
        }
        (Restart, Sequence) => {
            let value = value.map(str::trim).unwrap_or("");
            let start: i64 = value
                .parse()
                .map_err(|_| "Enter a whole number to restart the sequence with.".to_string())?;
            Ok(format!("ALTER SEQUENCE {name} RESTART WITH {start}"))
        }
        _ => Err(format!(
            "This action is not available for a {}.",
            object.kind.label()
        )),
    }
}

// Schemas a user works in: no system catalogs, TOAST, or other sessions' temporary schemas.
const PG_USER_NAMESPACE: &str = "n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname !~ '^pg_toast' AND (n.nspname !~ '^pg_temp_' OR n.oid = pg_catalog.pg_my_temp_schema())";
// Functions are identified by their input types; PostgreSQL 14+ procedures also by OUT
// arguments, which the identity arguments include with their modes.
const PG_SIGNATURE: &str = "CASE WHEN p.prokind = 'p' THEN pg_catalog.pg_get_function_identity_arguments(p.oid) ELSE pg_catalog.oidvectortypes(p.proargtypes) END";
fn pg_not_extension(class: &str, oid: &str) -> String {
    format!("NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.{class}'::regclass AND d.objid = {oid} AND d.deptype = 'e')")
}
fn pg_prokind(kind: ObjectKind) -> &'static str {
    if kind == ObjectKind::Procedure {
        "p"
    } else {
        "f"
    }
}
fn text(row: &sqlx::mysql::MySqlRow, index: usize) -> DbResult<Option<String>> {
    // information_schema columns can arrive as binary strings; decode them leniently.
    if let Ok(value) = row.try_get::<Option<String>, _>(index) {
        return Ok(value);
    }
    let bytes: Option<Vec<u8>> = row.try_get(index).map_err(err)?;
    Ok(bytes.map(|b| String::from_utf8_lossy(&b).into_owned()))
}
fn mysql_event_error(message: String) -> String {
    if message.contains("1577") {
        format!("{message}. Events are unavailable while the server's event scheduler is disabled; MariaDB/MySQL disable it at startup when the system tables need mysql_upgrade.")
    } else {
        message
    }
}
/// "EVERY 1 DAY · starts … · ends …" or "AT …", from information_schema.EVENTS.
pub(crate) fn event_schedule(
    event_type: &str,
    execute_at: Option<&str>,
    interval_value: Option<&str>,
    interval_field: Option<&str>,
    starts: Option<&str>,
    ends: Option<&str>,
) -> String {
    if event_type.eq_ignore_ascii_case("ONE TIME") {
        return format!("AT {}", execute_at.unwrap_or("?"));
    }
    let mut schedule = format!(
        "EVERY {} {}",
        interval_value.unwrap_or("?"),
        interval_field.unwrap_or("").replace('_', " ")
    )
    .trim_end()
    .to_string();
    if let Some(starts) = starts {
        schedule.push_str(&format!(" · starts {starts}"));
    }
    if let Some(ends) = ends {
        schedule.push_str(&format!(" · ends {ends}"));
    }
    schedule
}
/// "BEFORE INSERT" from a SQLite CREATE TRIGGER statement (SQLite defaults to BEFORE).
pub(crate) fn sqlite_trigger_timing(sql: &str) -> String {
    let upper = sql.to_ascii_uppercase();
    let words: Vec<&str> = upper
        .split(|c: char| c.is_whitespace() || c == '(' || c == ')' || c == ';')
        .filter(|w| !w.is_empty())
        .collect();
    let event = words
        .iter()
        .position(|w| ["INSERT", "UPDATE", "DELETE"].contains(w));
    let Some(event) = event else {
        return String::new();
    };
    let timing = match words[..event]
        .iter()
        .rev()
        .find(|w| ["BEFORE", "AFTER", "OF", "INSTEAD"].contains(w))
    {
        Some(&"AFTER") => "AFTER",
        Some(&"OF") | Some(&"INSTEAD") => "INSTEAD OF",
        _ => "BEFORE",
    };
    format!("{timing} {}", words[event])
}

pub(crate) async fn list_objects(conn: &Connection, kind: ObjectKind) -> DbResult<Vec<DbObject>> {
    check_kind(&conn.config.driver, kind)?;
    match &conn.pool {
        Pool::Pg(p) => list_pg(p, kind).await,
        Pool::My(p) => list_mysql(p, &conn.config.database, kind).await,
        Pool::Lite(p) => {
            let rows = sqlx::query("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
                .fetch_all(p)
                .await
                .map_err(err)?;
            rows.iter()
                .map(|r| {
                    let mut item = object(kind, "", r.try_get(0).map_err(err)?);
                    item.table = r.try_get(1).map_err(err)?;
                    let sql: Option<String> = r.try_get(2).map_err(err)?;
                    item.detail = sql.as_deref().map(sqlite_trigger_timing);
                    Ok(item)
                })
                .collect()
        }
    }
}
async fn list_pg(p: &sqlx::PgPool, kind: ObjectKind) -> DbResult<Vec<DbObject>> {
    match kind {
        ObjectKind::Function | ObjectKind::Procedure => {
            // Aggregates and window functions (prokind 'a'/'w') need their own DROP forms
            // and cannot be edited as routines, so they are left out.
            let sql = format!("SELECT n.nspname::text, p.proname::text, {PG_SIGNATURE}, pg_catalog.pg_get_function_result(p.oid), l.lanname::text, p.prorettype IN ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype), pg_catalog.obj_description(p.oid, 'pg_proc') FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace JOIN pg_catalog.pg_language l ON l.oid = p.prolang WHERE p.prokind = $1::\"char\" AND {PG_USER_NAMESPACE} AND {} ORDER BY 1, 2, 3", pg_not_extension("pg_proc", "p.oid"));
            let rows = sqlx::query(&sql)
                .bind(pg_prokind(kind))
                .fetch_all(p)
                .await
                .map_err(err)?;
            rows.iter()
                .map(|r| {
                    let schema: String = r.try_get(0).map_err(err)?;
                    let mut item = object(kind, &schema, r.try_get(1).map_err(err)?);
                    item.signature = Some(r.try_get(2).map_err(err)?);
                    let returns: Option<String> = r.try_get(3).map_err(err)?;
                    let language: String = r.try_get(4).map_err(err)?;
                    item.detail = Some(match returns {
                        Some(returns) => format!("RETURNS {returns} · {language}"),
                        None => language,
                    });
                    if r.try_get::<bool, _>(5).map_err(err)? {
                        item.flag = Some("trigger".into());
                    }
                    item.comment = r.try_get(6).map_err(err)?;
                    Ok(item)
                })
                .collect()
        }
        ObjectKind::Trigger => {
            let sql = format!("SELECT n.nspname::text, t.tgname::text, c.relname::text, (CASE WHEN t.tgtype::int & 2 <> 0 THEN 'BEFORE' WHEN t.tgtype::int & 64 <> 0 THEN 'INSTEAD OF' ELSE 'AFTER' END) || ' ' || concat_ws(' OR ', CASE WHEN t.tgtype::int & 4 <> 0 THEN 'INSERT' END, CASE WHEN t.tgtype::int & 16 <> 0 THEN 'UPDATE' END, CASE WHEN t.tgtype::int & 8 <> 0 THEN 'DELETE' END, CASE WHEN t.tgtype::int & 32 <> 0 THEN 'TRUNCATE' END) || CASE WHEN t.tgtype::int & 1 <> 0 THEN ' · each row' ELSE ' · each statement' END, CASE WHEN t.tgenabled = 'D' THEN 'DISABLED' ELSE 'ENABLED' END FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE NOT t.tgisinternal AND {PG_USER_NAMESPACE} AND {} ORDER BY 1, 3, 2", pg_not_extension("pg_class", "c.oid"));
            let rows = sqlx::query(&sql).fetch_all(p).await.map_err(err)?;
            rows.iter()
                .map(|r| {
                    let schema: String = r.try_get(0).map_err(err)?;
                    let mut item = object(kind, &schema, r.try_get(1).map_err(err)?);
                    item.table = Some(r.try_get(2).map_err(err)?);
                    item.detail = Some(r.try_get(3).map_err(err)?);
                    item.status = Some(r.try_get(4).map_err(err)?);
                    Ok(item)
                })
                .collect()
        }
        ObjectKind::Sequence => {
            let sql = format!("SELECT n.nspname::text, c.relname::text, pg_catalog.format_type(s.seqtypid, NULL), s.seqincrement::text, s.seqstart::text, CASE WHEN pg_catalog.has_sequence_privilege(c.oid, 'SELECT,USAGE') THEN pg_catalog.pg_sequence_last_value(c.oid)::text END, pg_catalog.obj_description(c.oid, 'pg_class') FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_sequence s ON s.seqrelid = c.oid WHERE c.relkind = 'S' AND {PG_USER_NAMESPACE} AND {} ORDER BY 1, 2", pg_not_extension("pg_class", "c.oid"));
            let rows = sqlx::query(&sql).fetch_all(p).await.map_err(err)?;
            rows.iter()
                .map(|r| {
                    let schema: String = r.try_get(0).map_err(err)?;
                    let mut item = object(kind, &schema, r.try_get(1).map_err(err)?);
                    item.detail = Some(r.try_get(2).map_err(err)?);
                    item.increment = Some(r.try_get(3).map_err(err)?);
                    item.start = Some(r.try_get(4).map_err(err)?);
                    item.last_value = r.try_get(5).map_err(err)?;
                    item.comment = r.try_get(6).map_err(err)?;
                    Ok(item)
                })
                .collect()
        }
        ObjectKind::MaterializedView => {
            // CONCURRENTLY needs a populated view and a plain unique index on columns.
            let sql = format!("SELECT n.nspname::text, c.relname::text, c.relispopulated, c.relispopulated AND EXISTS (SELECT 1 FROM pg_catalog.pg_index i WHERE i.indrelid = c.oid AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indexprs IS NULL), pg_catalog.pg_size_pretty(pg_catalog.pg_total_relation_size(c.oid)), pg_catalog.obj_description(c.oid, 'pg_class') FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind = 'm' AND {PG_USER_NAMESPACE} AND {} ORDER BY 1, 2", pg_not_extension("pg_class", "c.oid"));
            let rows = sqlx::query(&sql).fetch_all(p).await.map_err(err)?;
            rows.iter()
                .map(|r| {
                    let schema: String = r.try_get(0).map_err(err)?;
                    let mut item = object(kind, &schema, r.try_get(1).map_err(err)?);
                    let populated: bool = r.try_get(2).map_err(err)?;
                    item.refresh_concurrently = r.try_get(3).map_err(err)?;
                    let size: String = r.try_get(4).map_err(err)?;
                    item.status = Some(
                        if populated {
                            "POPULATED"
                        } else {
                            "NOT POPULATED"
                        }
                        .into(),
                    );
                    item.detail = Some(size);
                    item.comment = r.try_get(5).map_err(err)?;
                    Ok(item)
                })
                .collect()
        }
        ObjectKind::Event => Err("PostgreSQL has no events.".into()),
    }
}
async fn list_mysql(
    p: &sqlx::MySqlPool,
    database: &str,
    kind: ObjectKind,
) -> DbResult<Vec<DbObject>> {
    match kind {
        ObjectKind::Function | ObjectKind::Procedure => {
            let rows = sqlx::query("SELECT CAST(ROUTINE_NAME AS CHAR), CAST(DTD_IDENTIFIER AS CHAR), CAST(LAST_ALTERED AS CHAR), CAST(ROUTINE_COMMENT AS CHAR), CAST(DEFINER AS CHAR) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_TYPE = ? ORDER BY ROUTINE_NAME")
                .bind(kind.keyword())
                .fetch_all(p)
                .await
                .map_err(err)?;
            rows.iter()
                .map(|r| {
                    let mut item = object(kind, database, text(r, 0)?.unwrap_or_default());
                    let returns = text(r, 1)?.filter(|s| !s.is_empty());
                    let definer = text(r, 4)?.unwrap_or_default();
                    item.detail = Some(match returns {
                        Some(returns) => format!("RETURNS {returns} · {definer}"),
                        None => definer,
                    });
                    item.status = text(r, 2)?;
                    item.comment = text(r, 3)?.filter(|s| !s.is_empty());
                    Ok(item)
                })
                .collect()
        }
        ObjectKind::Trigger => {
            let rows = sqlx::query("SELECT CAST(TRIGGER_NAME AS CHAR), CAST(EVENT_OBJECT_TABLE AS CHAR), CAST(CONCAT(ACTION_TIMING, ' ', EVENT_MANIPULATION) AS CHAR) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME")
                .fetch_all(p)
                .await
                .map_err(err)?;
            rows.iter()
                .map(|r| {
                    let mut item = object(kind, database, text(r, 0)?.unwrap_or_default());
                    item.table = text(r, 1)?;
                    item.detail = text(r, 2)?;
                    Ok(item)
                })
                .collect()
        }
        ObjectKind::Event => {
            let rows = sqlx::query("SELECT CAST(EVENT_NAME AS CHAR), CAST(STATUS AS CHAR), CAST(EVENT_TYPE AS CHAR), CAST(EXECUTE_AT AS CHAR), CAST(INTERVAL_VALUE AS CHAR), CAST(INTERVAL_FIELD AS CHAR), CAST(STARTS AS CHAR), CAST(ENDS AS CHAR), CAST(EVENT_COMMENT AS CHAR) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE() ORDER BY EVENT_NAME")
                .fetch_all(p)
                .await
                .map_err(|e| mysql_event_error(err(e)))?;
            rows.iter()
                .map(|r| {
                    let mut item = object(kind, database, text(r, 0)?.unwrap_or_default());
                    item.status = text(r, 1)?;
                    item.detail = Some(event_schedule(
                        &text(r, 2)?.unwrap_or_default(),
                        text(r, 3)?.as_deref(),
                        text(r, 4)?.as_deref(),
                        text(r, 5)?.as_deref(),
                        text(r, 6)?.as_deref(),
                        text(r, 7)?.as_deref(),
                    ));
                    item.comment = text(r, 8)?.filter(|s| !s.is_empty());
                    Ok(item)
                })
                .collect()
        }
        _ => Err(format!("MySQL has no {}s.", kind.label())),
    }
}

/// Finds a PostgreSQL routine by bound schema, name and signature, and returns its OID with
/// the catalog's own signature text, so the webview cannot inject SQL through it.
async fn pg_routine(
    p: &sqlx::PgPool,
    object: &DbObject,
) -> DbResult<(sqlx::postgres::types::Oid, String)> {
    let sql = format!("SELECT p.oid, {PG_SIGNATURE} FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = $3::\"char\" AND {PG_SIGNATURE} = $4");
    let row = sqlx::query(&sql)
        .bind(&object.schema)
        .bind(&object.name)
        .bind(pg_prokind(object.kind))
        .bind(object.signature.as_deref().unwrap_or(""))
        .fetch_optional(p)
        .await
        .map_err(err)?
        .ok_or_else(|| {
            format!(
                "The {} no longer exists. Refresh and try again.",
                object.kind.label()
            )
        })?;
    Ok((row.try_get(0).map_err(err)?, row.try_get(1).map_err(err)?))
}
async fn resolve(conn: &Connection, mut object: DbObject) -> DbResult<DbObject> {
    if let (Pool::Pg(p), ObjectKind::Function | ObjectKind::Procedure) = (&conn.pool, object.kind) {
        object.signature = Some(pg_routine(p, &object).await?.1);
    }
    Ok(object)
}

#[derive(Serialize)]
pub(crate) struct ObjectDefinition {
    /// The read-only definition, as the database reports it.
    definition: String,
    /// A script that replaces the object with its edited definition.
    edit_script: String,
    /// A call template with every parameter named (PostgreSQL routines).
    #[serde(skip_serializing_if = "Option::is_none")]
    execute_script: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}
pub(crate) struct RoutineParameter {
    pub name: String,
    pub data_type: String,
    /// pg_proc.proargmodes: i, o, b (INOUT), v (VARIADIC) or t (TABLE column).
    pub mode: String,
}
/// `SELECT * FROM f(...)` or `CALL p(...)` with a typed NULL placeholder per parameter.
pub(crate) fn pg_execute_script(object: &DbObject, parameters: &[RoutineParameter]) -> String {
    let procedure = object.kind == ObjectKind::Procedure;
    let arguments: Vec<String> = parameters
        .iter()
        .filter(|p| match p.mode.as_str() {
            "i" | "b" | "v" => true,
            // PostgreSQL 14+ procedures take a placeholder for OUT arguments too.
            "o" => procedure,
            _ => false,
        })
        .map(|p| {
            let variadic = if p.mode == "v" { "VARIADIC " } else { "" };
            let label = match (p.name.is_empty(), p.mode.as_str()) {
                (true, "o") => "OUT".to_string(),
                (true, "b") => "INOUT".to_string(),
                (true, _) => "unnamed".to_string(),
                (false, "o") => format!("{} (OUT)", p.name),
                (false, "b") => format!("{} (INOUT)", p.name),
                (false, _) => p.name.clone(),
            };
            format!(
                "{variadic}NULL::{} /* {} */",
                p.data_type,
                label.replace("*/", "* /")
            )
        })
        .collect();
    let list = if arguments.is_empty() {
        String::new()
    } else {
        format!("\n  {}\n", arguments.join(",\n  "))
    };
    let name = target(object, &Driver::Postgres);
    if procedure {
        format!("CALL {name}({list});\n")
    } else {
        format!("SELECT * FROM {name}({list});\n")
    }
}
pub(crate) struct SequenceInfo {
    pub data_type: String,
    pub increment: String,
    pub min: String,
    pub max: String,
    pub start: String,
    pub cache: String,
    pub cycle: bool,
    pub last_value: Option<String>,
    /// Quoted table.column the sequence is owned by, with whether it is an identity.
    pub owned_by: Option<(String, bool)>,
}
pub(crate) fn pg_sequence_ddl(object: &DbObject, info: &SequenceInfo) -> String {
    let name = target(object, &Driver::Postgres);
    let mut ddl = format!(
        "CREATE SEQUENCE {name}\n  AS {}\n  INCREMENT BY {}\n  MINVALUE {}\n  MAXVALUE {}\n  START WITH {}\n  CACHE {}\n  {};",
        info.data_type,
        info.increment,
        info.min,
        info.max,
        info.start,
        info.cache,
        if info.cycle { "CYCLE" } else { "NO CYCLE" }
    );
    match &info.owned_by {
        Some((column, false)) => {
            ddl.push_str(&format!("\n\nALTER SEQUENCE {name} OWNED BY {column};"))
        }
        Some((column, true)) => ddl.push_str(&format!("\n\n-- Identity sequence of {column}.")),
        None => {}
    }
    ddl.push_str(&format!(
        "\n\n-- Current value: {}",
        info.last_value
            .as_deref()
            .unwrap_or("not used yet (or no SELECT/USAGE privilege)")
    ));
    ddl
}
pub(crate) fn pg_sequence_edit(object: &DbObject, info: &SequenceInfo) -> String {
    format!(
        "-- Change the options you need; ALTER SEQUENCE keeps the current value unless you add RESTART.\nALTER SEQUENCE {}\n  INCREMENT BY {}\n  MINVALUE {}\n  MAXVALUE {}\n  CACHE {}\n  {};\n",
        target(object, &Driver::Postgres),
        info.increment,
        info.min,
        info.max,
        info.cache,
        if info.cycle { "CYCLE" } else { "NO CYCLE" }
    )
}
/// MariaDB replaces routines, triggers and events in place; MySQL needs DROP first.
pub(crate) fn mysql_edit_script(
    object: &DbObject,
    definition: &str,
    mariadb: bool,
    sql_mode: Option<&str>,
) -> String {
    let mut script = String::new();
    if let Some(mode) = sql_mode.filter(|m| !m.is_empty()) {
        script.push_str(&format!(
            "-- Created with sql_mode {mode}; the replacement uses this tab's sql_mode.\n"
        ));
    }
    script.push_str(
        "-- DBde sends the whole script in one call, so no DELIMITER lines are needed.\n",
    );
    let body = definition.trim_end().trim_end_matches(';').trim_end();
    if mariadb {
        let replaced = body
            .strip_prefix("CREATE ")
            .map(|rest| format!("CREATE OR REPLACE {rest}"))
            .unwrap_or_else(|| body.to_string());
        script.push_str(&format!("{replaced};\n"));
    } else {
        script.push_str(&format!(
            "-- MySQL cannot replace a {} in place: the DROP runs first, so review the body before running.\nDROP {} IF EXISTS {};\n{body};\n",
            object.kind.label(),
            object.kind.keyword(),
            target(object, &Driver::Mysql)
        ));
    }
    script
}

async fn pg_definition(p: &sqlx::PgPool, object: &DbObject) -> DbResult<ObjectDefinition> {
    match object.kind {
        ObjectKind::Function | ObjectKind::Procedure => {
            let (oid, _) = pg_routine(p, object).await?;
            let definition: String = sqlx::query_scalar("SELECT pg_catalog.pg_get_functiondef($1)")
                .bind(oid)
                .fetch_one(p)
                .await
                .map_err(err)?;
            let definition = format!("{};", definition.trim_end());
            let row = sqlx::query("SELECT ARRAY(SELECT COALESCE(a.n, '') FROM unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[]), p.proargmodes, p.proargnames) WITH ORDINALITY AS a(t, m, n, o) ORDER BY a.o), ARRAY(SELECT pg_catalog.format_type(a.t, NULL) FROM unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[]), p.proargmodes, p.proargnames) WITH ORDINALITY AS a(t, m, n, o) ORDER BY a.o), ARRAY(SELECT COALESCE(a.m::text, 'i') FROM unnest(COALESCE(p.proallargtypes, p.proargtypes::oid[]), p.proargmodes, p.proargnames) WITH ORDINALITY AS a(t, m, n, o) ORDER BY a.o), p.prorettype IN ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype) FROM pg_catalog.pg_proc p WHERE p.oid = $1")
                .bind(oid)
                .fetch_one(p)
                .await
                .map_err(err)?;
            let names: Vec<String> = row.try_get(0).map_err(err)?;
            let types: Vec<String> = row.try_get(1).map_err(err)?;
            let modes: Vec<String> = row.try_get(2).map_err(err)?;
            let trigger: bool = row.try_get(3).map_err(err)?;
            let parameters: Vec<RoutineParameter> = names
                .into_iter()
                .zip(types)
                .zip(modes)
                .map(|((name, data_type), mode)| RoutineParameter {
                    name,
                    data_type,
                    mode,
                })
                .collect();
            Ok(ObjectDefinition {
                edit_script: format!("-- CREATE OR REPLACE keeps grants and dependent objects. It cannot change argument or return types; drop and recreate for that.\n{definition}\n"),
                execute_script: (!trigger).then(|| pg_execute_script(object, &parameters)),
                note: trigger.then(|| "Trigger functions run from triggers and cannot be called directly.".into()),
                definition,
            })
        }
        ObjectKind::Trigger => {
            let definition: Option<String> = sqlx::query_scalar("SELECT pg_catalog.pg_get_triggerdef(t.oid, true) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND t.tgname = $3 AND NOT t.tgisinternal")
                .bind(&object.schema)
                .bind(object.table.as_deref().unwrap_or(""))
                .bind(&object.name)
                .fetch_optional(p)
                .await
                .map_err(err)?;
            let definition = format!(
                "{};",
                definition
                    .ok_or("The trigger no longer exists. Refresh and try again.")?
                    .trim_end()
            );
            Ok(ObjectDefinition {
                // One simple-protocol call runs as a single transaction: if CREATE fails,
                // the DROP is rolled back too.
                edit_script: format!(
                    "-- Both statements run in one transaction, so a failed CREATE keeps the old trigger.\nDROP TRIGGER IF EXISTS {} ON {};\n{definition}\n",
                    quote(&object.name, &Driver::Postgres),
                    pg_trigger_table(object)
                ),
                execute_script: None,
                note: Some("The trigger function is listed under Functions.".into()),
                definition,
            })
        }
        ObjectKind::Sequence => {
            let row = sqlx::query("SELECT pg_catalog.format_type(s.seqtypid, NULL), s.seqincrement::text, s.seqmin::text, s.seqmax::text, s.seqstart::text, s.seqcache::text, s.seqcycle, CASE WHEN pg_catalog.has_sequence_privilege(c.oid, 'SELECT,USAGE') THEN pg_catalog.pg_sequence_last_value(c.oid)::text END, (SELECT quote_ident(tn.nspname) || '.' || quote_ident(tc.relname) || '.' || quote_ident(a.attname) FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class tc ON tc.oid = d.refobjid JOIN pg_catalog.pg_namespace tn ON tn.oid = tc.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid = tc.oid AND a.attnum = d.refobjsubid WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a', 'i') LIMIT 1), EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'i') FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace JOIN pg_catalog.pg_sequence s ON s.seqrelid = c.oid WHERE n.nspname = $1 AND c.relname = $2")
                .bind(&object.schema)
                .bind(&object.name)
                .fetch_optional(p)
                .await
                .map_err(err)?
                .ok_or("The sequence no longer exists. Refresh and try again.")?;
            let owned: Option<String> = row.try_get(8).map_err(err)?;
            let identity: bool = row.try_get(9).map_err(err)?;
            let info = SequenceInfo {
                data_type: row.try_get(0).map_err(err)?,
                increment: row.try_get(1).map_err(err)?,
                min: row.try_get(2).map_err(err)?,
                max: row.try_get(3).map_err(err)?,
                start: row.try_get(4).map_err(err)?,
                cache: row.try_get(5).map_err(err)?,
                cycle: row.try_get(6).map_err(err)?,
                last_value: row.try_get(7).map_err(err)?,
                owned_by: owned.map(|column| (column, identity)),
            };
            Ok(ObjectDefinition {
                definition: pg_sequence_ddl(object, &info),
                edit_script: pg_sequence_edit(object, &info),
                execute_script: None,
                note: None,
            })
        }
        ObjectKind::MaterializedView => {
            let view = TableInfo {
                name: object.name.clone(),
                schema: object.schema.clone(),
                kind: "view".into(),
            };
            let ddl = schema::pg_ddl(p, &view, false).await?;
            let definition = ddl.trim_end().trim_end_matches(';').to_string() + ";";
            let indexes: Vec<String> = sqlx::query_scalar("SELECT pg_catalog.pg_get_indexdef(i.indexrelid) || ';' FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid = i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 ORDER BY 1")
                .bind(&object.schema)
                .bind(&object.name)
                .fetch_all(p)
                .await
                .map_err(err)?;
            let mut full = definition.clone();
            for index in &indexes {
                full.push_str("\n\n");
                full.push_str(index);
            }
            Ok(ObjectDefinition {
                edit_script: format!(
                    "-- PostgreSQL cannot replace a materialized view in place. These statements run in one\n-- transaction: the data is recomputed, and dependent views block the DROP. Grants are not kept.\nDROP MATERIALIZED VIEW {};\n{full}\n",
                    target(object, &Driver::Postgres)
                ),
                definition: full,
                execute_script: None,
                note: None,
            })
        }
        ObjectKind::Event => Err("PostgreSQL has no events.".into()),
    }
}
async fn mysql_definition(p: &sqlx::MySqlPool, object: &DbObject) -> DbResult<ObjectDefinition> {
    let column = match object.kind {
        ObjectKind::Function => "Create Function",
        ObjectKind::Procedure => "Create Procedure",
        ObjectKind::Trigger => "SQL Original Statement",
        ObjectKind::Event => "Create Event",
        _ => return Err(format!("MySQL has no {}s.", object.kind.label())),
    };
    let sql = format!(
        "SHOW CREATE {} {}",
        object.kind.keyword(),
        target(object, &Driver::Mysql)
    );
    let row = sqlx::raw_sql(&sql)
        .fetch_all(p)
        .await
        .map_err(|e| format!("Cannot read the {} definition: {e}", object.kind.label()))?
        .into_iter()
        .next()
        .ok_or_else(|| {
            format!(
                "The {} no longer exists. Refresh and try again.",
                object.kind.label()
            )
        })?;
    let index = row
        .columns()
        .iter()
        .position(|c| c.name().eq_ignore_ascii_case(column))
        .ok_or("The server did not return a definition.")?;
    let definition = text(&row, index)?.filter(|d| !d.trim().is_empty()).ok_or_else(|| {
        format!(
            "The server hides this {}'s definition from your account. Its body is visible only to its definer or to accounts with {}.",
            object.kind.label(),
            if object.kind == ObjectKind::Trigger {
                "the TRIGGER privilege on its table"
            } else if object.kind == ObjectKind::Event {
                "the EVENT privilege"
            } else {
                "SHOW_ROUTINE, or SELECT on mysql.proc (MariaDB) / the global SELECT privilege (MySQL)"
            }
        )
    })?;
    let sql_mode = row
        .columns()
        .iter()
        .position(|c| c.name().eq_ignore_ascii_case("sql_mode"))
        .map(|i| text(&row, i))
        .transpose()?
        .flatten();
    let version: String = sqlx::query_scalar("SELECT CAST(VERSION() AS CHAR)")
        .fetch_one(p)
        .await
        .map_err(err)?;
    let definition = format!("{};", definition.trim_end());
    Ok(ObjectDefinition {
        edit_script: mysql_edit_script(
            object,
            &definition,
            version.contains("MariaDB"),
            sql_mode.as_deref(),
        ),
        definition,
        execute_script: None,
        note: None,
    })
}
pub(crate) async fn object_definition(
    conn: &Connection,
    object: &DbObject,
) -> DbResult<ObjectDefinition> {
    match &conn.pool {
        Pool::Pg(p) => pg_definition(p, object).await,
        Pool::My(p) => mysql_definition(p, object).await,
        Pool::Lite(p) => {
            let sql: Option<Option<String>> = sqlx::query_scalar(
                "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
            )
            .bind(&object.name)
            .fetch_optional(p)
            .await
            .map_err(err)?;
            let sql = sql
                .flatten()
                .ok_or("The trigger no longer exists. Refresh and try again.")?;
            let definition = format!("{};", sql.trim_end().trim_end_matches(';'));
            Ok(ObjectDefinition {
                edit_script: format!(
                    "-- SQLite cannot replace a trigger in place: the DROP runs first.\nDROP TRIGGER IF EXISTS {};\n{definition}\n",
                    quote(&object.name, &Driver::Sqlite)
                ),
                definition,
                execute_script: None,
                note: None,
            })
        }
    }
}
async fn object_action(
    conn: &Connection,
    object: DbObject,
    action: ObjectAction,
    value: Option<&str>,
    preview: bool,
) -> DbResult<String> {
    let object = resolve(conn, validate_object(conn, object)?).await?;
    let sql = action_sql(&object, &conn.config.driver, action, value)?;
    if !preview {
        raw_pool_query(&conn.pool, &sql).await?;
    }
    Ok(sql)
}

#[tauri::command]
pub(crate) async fn dbde_list_objects(
    connection_id: String,
    database: Option<String>,
    kind: ObjectKind,
    state: State<'_, AppState>,
) -> DbResult<Vec<DbObject>> {
    timed(async {
        let conn = database_connection(&state, &connection_id, database.as_deref()).await?;
        list_objects(&conn, kind).await
    })
    .await
}
#[tauri::command]
pub(crate) async fn dbde_object_definition(
    connection_id: String,
    database: Option<String>,
    object: DbObject,
    state: State<'_, AppState>,
) -> DbResult<ObjectDefinition> {
    timed(async {
        let conn = database_connection(&state, &connection_id, database.as_deref()).await?;
        let object = validate_object(&conn, object)?;
        object_definition(&conn, &object).await
    })
    .await
}
/// Builds (preview) or runs one validated statement on an object, returning the SQL.
#[tauri::command]
pub(crate) async fn dbde_object_action(
    connection_id: String,
    database: String,
    object: DbObject,
    action: ObjectAction,
    value: Option<String>,
    preview: Option<bool>,
    state: State<'_, AppState>,
) -> DbResult<String> {
    let preview = preview.unwrap_or(false);
    let conn = timed(database_connection(&state, &connection_id, Some(&database))).await?;
    let refresh = matches!(
        action,
        ObjectAction::Refresh | ObjectAction::RefreshConcurrently
    );
    if !refresh || preview {
        return timed(object_action(
            &conn,
            object,
            action,
            value.as_deref(),
            preview,
        ))
        .await;
    }
    // Refreshing recomputes the whole view; allow the connection's query timeout, at least 10 minutes.
    let seconds = conn
        .config
        .options
        .query_timeout_secs
        .unwrap_or(0)
        .clamp(600, MAX_QUERY_TIMEOUT_SECS);
    tokio::time::timeout(
        Duration::from_secs(seconds),
        object_action(&conn, object, action, value.as_deref(), false),
    )
    .await
    .map_err(|_| format!("Refresh did not finish within {seconds} seconds. It may still be running on the server."))?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn named(kind: ObjectKind, schema: &str, name: &str) -> DbObject {
        object(kind, schema, name.into())
    }
    fn conn_for(driver: Driver, pool: Pool) -> Connection {
        Connection {
            tunnel: None,
            pool,
            config: crate::tests::config(driver),
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    async fn sqlite() -> Connection {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        conn_for(Driver::Sqlite, Pool::Lite(pool))
    }

    #[test]
    fn kinds_are_limited_per_driver() {
        assert!(check_kind(&Driver::Sqlite, ObjectKind::Trigger).is_ok());
        assert!(check_kind(&Driver::Sqlite, ObjectKind::Function).is_err());
        assert!(check_kind(&Driver::Mysql, ObjectKind::Event).is_ok());
        assert!(check_kind(&Driver::Mysql, ObjectKind::Sequence).is_err());
        assert!(check_kind(&Driver::Postgres, ObjectKind::Event).is_err());
        assert!(check_kind(&Driver::Postgres, ObjectKind::MaterializedView).is_ok());
        let parsed: ObjectKind = serde_json::from_value(json!("materialized_view")).unwrap();
        assert_eq!(parsed, ObjectKind::MaterializedView);
        assert!(serde_json::from_value::<ObjectKind>(json!("table")).is_err());
    }
    #[test]
    fn postgres_statements_quote_names_and_use_the_signature() {
        let mut f = named(ObjectKind::Function, "s\"x", "f");
        assert!(action_sql(&f, &Driver::Postgres, ObjectAction::Drop, None).is_err());
        f.signature = Some("integer, text".into());
        assert_eq!(
            action_sql(&f, &Driver::Postgres, ObjectAction::Drop, None).unwrap(),
            "DROP FUNCTION \"s\"\"x\".\"f\"(integer, text)"
        );
        let mut p = named(ObjectKind::Procedure, "s", "p");
        p.signature = Some(String::new());
        assert_eq!(
            action_sql(&p, &Driver::Postgres, ObjectAction::Drop, None).unwrap(),
            "DROP PROCEDURE \"s\".\"p\"()"
        );
        let mut t = named(ObjectKind::Trigger, "public", "audit");
        t.table = Some("my table".into());
        assert_eq!(
            action_sql(&t, &Driver::Postgres, ObjectAction::Drop, None).unwrap(),
            "DROP TRIGGER \"audit\" ON \"public\".\"my table\""
        );
        let q = named(ObjectKind::Sequence, "public", "ids");
        assert_eq!(
            action_sql(&q, &Driver::Postgres, ObjectAction::Restart, Some(" 42 ")).unwrap(),
            "ALTER SEQUENCE \"public\".\"ids\" RESTART WITH 42"
        );
        assert!(action_sql(
            &q,
            &Driver::Postgres,
            ObjectAction::Restart,
            Some("1; DROP")
        )
        .is_err());
        assert!(action_sql(&q, &Driver::Postgres, ObjectAction::Restart, None).is_err());
        assert_eq!(
            action_sql(&q, &Driver::Postgres, ObjectAction::Drop, None).unwrap(),
            "DROP SEQUENCE \"public\".\"ids\""
        );
        let m = named(ObjectKind::MaterializedView, "public", "totals");
        assert_eq!(
            action_sql(
                &m,
                &Driver::Postgres,
                ObjectAction::RefreshConcurrently,
                None
            )
            .unwrap(),
            "REFRESH MATERIALIZED VIEW CONCURRENTLY \"public\".\"totals\""
        );
        assert_eq!(
            action_sql(&m, &Driver::Postgres, ObjectAction::Drop, None).unwrap(),
            "DROP MATERIALIZED VIEW \"public\".\"totals\""
        );
        assert!(action_sql(&m, &Driver::Postgres, ObjectAction::Enable, None).is_err());
        assert!(action_sql(&f, &Driver::Postgres, ObjectAction::Refresh, None).is_err());
    }
    #[test]
    fn mysql_and_sqlite_statements_quote_names() {
        let e = named(ObjectKind::Event, "shop", "nightly `job`");
        assert_eq!(
            action_sql(&e, &Driver::Mysql, ObjectAction::Disable, None).unwrap(),
            "ALTER EVENT `shop`.`nightly ``job``` DISABLE"
        );
        assert_eq!(
            action_sql(&e, &Driver::Mysql, ObjectAction::Enable, None).unwrap(),
            "ALTER EVENT `shop`.`nightly ``job``` ENABLE"
        );
        let f = named(ObjectKind::Function, "shop", "total");
        assert_eq!(
            action_sql(&f, &Driver::Mysql, ObjectAction::Drop, None).unwrap(),
            "DROP FUNCTION `shop`.`total`"
        );
        let t = named(ObjectKind::Trigger, "shop", "bi");
        assert_eq!(
            action_sql(&t, &Driver::Mysql, ObjectAction::Drop, None).unwrap(),
            "DROP TRIGGER `shop`.`bi`"
        );
        assert!(action_sql(&f, &Driver::Mysql, ObjectAction::Restart, Some("1")).is_err());
        let s = named(ObjectKind::Trigger, "", "a\"b");
        assert_eq!(
            action_sql(&s, &Driver::Sqlite, ObjectAction::Drop, None).unwrap(),
            "DROP TRIGGER \"a\"\"b\""
        );
        assert!(action_sql(
            &named(ObjectKind::Function, "", "f"),
            &Driver::Sqlite,
            ObjectAction::Drop,
            None
        )
        .is_err());
    }
    #[tokio::test]
    async fn webview_objects_are_validated_and_normalised() {
        let mut my = conn_for(
            Driver::Mysql,
            Pool::Lite(sqlx::SqlitePool::connect_lazy("sqlite::memory:").unwrap()),
        );
        my.config.database = "shop".into();
        let normalised = validate_object(&my, named(ObjectKind::Event, "", "e")).unwrap();
        assert_eq!(normalised.schema, "shop");
        assert!(validate_object(&my, named(ObjectKind::Event, "other", "e")).is_err());
        assert!(validate_object(&my, named(ObjectKind::Sequence, "shop", "e")).is_err());
        assert!(validate_object(&my, named(ObjectKind::Event, "shop", " ")).is_err());
        assert!(validate_object(&my, named(ObjectKind::Event, "shop", "a\0b")).is_err());
        let mut pg = my.clone();
        pg.config.driver = Driver::Postgres;
        assert!(validate_object(&pg, named(ObjectKind::Function, "", "f")).is_err());
        assert!(validate_object(&pg, named(ObjectKind::Trigger, "public", "t")).is_err());
        let mut lite = my.clone();
        lite.config.driver = Driver::Sqlite;
        assert!(validate_object(&lite, named(ObjectKind::Trigger, "temp", "t")).is_err());
        assert_eq!(
            validate_object(&lite, named(ObjectKind::Trigger, "main", "t"))
                .unwrap()
                .schema,
            ""
        );
    }
    #[test]
    fn scripts_and_templates_are_generated_per_driver() {
        let f = named(ObjectKind::Function, "app", "add");
        let params = vec![
            RoutineParameter {
                name: "a".into(),
                data_type: "integer".into(),
                mode: "i".into(),
            },
            RoutineParameter {
                name: "".into(),
                data_type: "text[]".into(),
                mode: "v".into(),
            },
            RoutineParameter {
                name: "total".into(),
                data_type: "integer".into(),
                mode: "o".into(),
            },
        ];
        assert_eq!(
            pg_execute_script(&f, &params),
            "SELECT * FROM \"app\".\"add\"(\n  NULL::integer /* a */,\n  VARIADIC NULL::text[] /* unnamed */\n);\n"
        );
        let p = named(ObjectKind::Procedure, "app", "move");
        assert_eq!(
            pg_execute_script(&p, &params[2..]),
            "CALL \"app\".\"move\"(\n  NULL::integer /* total (OUT) */\n);\n"
        );
        assert_eq!(pg_execute_script(&p, &[]), "CALL \"app\".\"move\"();\n");
        let routine = named(ObjectKind::Procedure, "shop", "p");
        let body =
            "CREATE DEFINER=`root`@`localhost` PROCEDURE `p`()\nBEGIN SELECT 1; SELECT 2; END;";
        let mysql = mysql_edit_script(&routine, body, false, Some("STRICT_TRANS_TABLES"));
        assert!(
            mysql.contains("DROP PROCEDURE IF EXISTS `shop`.`p`;\nCREATE DEFINER"),
            "{mysql}"
        );
        assert!(mysql.contains("sql_mode STRICT_TRANS_TABLES"));
        assert!(!mysql.lines().any(|line| line.starts_with("DELIMITER")));
        assert!(mysql.ends_with("END;\n"));
        let maria = mysql_edit_script(&routine, body, true, None);
        assert!(maria.contains("CREATE OR REPLACE DEFINER=`root`@`localhost` PROCEDURE"));
        assert!(!maria.contains("DROP"));
        let seq = named(ObjectKind::Sequence, "public", "ids");
        let info = SequenceInfo {
            data_type: "bigint".into(),
            increment: "1".into(),
            min: "1".into(),
            max: "9223372036854775807".into(),
            start: "1".into(),
            cache: "1".into(),
            cycle: false,
            last_value: Some("7".into()),
            owned_by: Some(("public.t.id".into(), false)),
        };
        let ddl = pg_sequence_ddl(&seq, &info);
        assert!(
            ddl.starts_with("CREATE SEQUENCE \"public\".\"ids\"\n  AS bigint\n  INCREMENT BY 1")
        );
        assert!(ddl.contains("NO CYCLE;"));
        assert!(ddl.contains("ALTER SEQUENCE \"public\".\"ids\" OWNED BY public.t.id;"));
        assert!(ddl.ends_with("-- Current value: 7"));
        assert!(pg_sequence_edit(&seq, &info)
            .contains("ALTER SEQUENCE \"public\".\"ids\"\n  INCREMENT BY 1"));
    }
    #[test]
    fn schedules_and_sqlite_timing_are_readable() {
        assert_eq!(
            event_schedule(
                "RECURRING",
                None,
                Some("1"),
                Some("DAY_HOUR"),
                Some("2026-01-01 00:00:00"),
                None
            ),
            "EVERY 1 DAY HOUR · starts 2026-01-01 00:00:00"
        );
        assert_eq!(
            event_schedule(
                "ONE TIME",
                Some("2026-02-01 10:00:00"),
                None,
                None,
                None,
                None
            ),
            "AT 2026-02-01 10:00:00"
        );
        assert_eq!(
            sqlite_trigger_timing("CREATE TRIGGER t AFTER UPDATE OF x ON a BEGIN SELECT 1; END"),
            "AFTER UPDATE"
        );
        assert_eq!(
            sqlite_trigger_timing("CREATE TRIGGER before_x INSERT ON a BEGIN SELECT 1; END"),
            "BEFORE INSERT"
        );
        assert_eq!(
            sqlite_trigger_timing(
                "create trigger v_ins instead of insert on v begin select 1; end"
            ),
            "INSTEAD OF INSERT"
        );
    }
    #[tokio::test]
    async fn sqlite_triggers_are_listed_defined_and_dropped() {
        let conn = sqlite().await;
        raw_pool_query(&conn.pool, "CREATE TABLE items (id INTEGER PRIMARY KEY, n INTEGER); CREATE TABLE log (msg TEXT); CREATE TRIGGER \"items log\" AFTER INSERT ON items BEGIN INSERT INTO log VALUES ('a'); INSERT INTO log VALUES ('b'); END; CREATE TRIGGER keep BEFORE DELETE ON items BEGIN SELECT 1; END").await.unwrap();
        let found = list_objects(&conn, ObjectKind::Trigger).await.unwrap();
        assert_eq!(
            found.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            ["items log", "keep"]
        );
        assert_eq!(found[0].table.as_deref(), Some("items"));
        assert_eq!(found[0].detail.as_deref(), Some("AFTER INSERT"));
        assert!(list_objects(&conn, ObjectKind::Function).await.is_err());
        let definition = object_definition(&conn, &found[0]).await.unwrap();
        assert!(definition
            .definition
            .starts_with("CREATE TRIGGER \"items log\" AFTER INSERT"));
        // The edit script replaces the trigger through the same multi-statement executor.
        raw_pool_query(&conn.pool, &definition.edit_script)
            .await
            .unwrap();
        raw_pool_query(&conn.pool, "INSERT INTO items (n) VALUES (1)")
            .await
            .unwrap();
        let logged = query(&conn.pool, "SELECT COUNT(*) FROM log").await.unwrap();
        assert_eq!(logged.rows[0][0], json!(2));
        let sql = object_action(&conn, found[0].clone(), ObjectAction::Drop, None, true)
            .await
            .unwrap();
        assert_eq!(sql, "DROP TRIGGER \"items log\"");
        assert_eq!(
            list_objects(&conn, ObjectKind::Trigger)
                .await
                .unwrap()
                .len(),
            2,
            "preview must not drop"
        );
        object_action(&conn, found[0].clone(), ObjectAction::Drop, None, false)
            .await
            .unwrap();
        let left = list_objects(&conn, ObjectKind::Trigger).await.unwrap();
        assert_eq!(
            left.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            ["keep"]
        );
        assert!(object_definition(&conn, &found[0]).await.is_err());
    }
    async fn pg_conn() -> Connection {
        crate::tests::server_connection("DBDE_TEST_PG_URL", Driver::Postgres).await
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_PG_URL; creates only pg_temp objects on a one-connection pool"]
    async fn postgres_objects_round_trip_in_the_temp_schema() {
        let conn = pg_conn().await;
        raw_pool_query(&conn.pool, "CREATE TABLE pg_temp.dbde_obj_t (id int PRIMARY KEY, v int); CREATE FUNCTION pg_temp.dbde_obj_f(a integer, b text) RETURNS integer LANGUAGE sql AS $$ SELECT a $$; CREATE FUNCTION pg_temp.dbde_obj_f(a integer) RETURNS integer LANGUAGE sql AS $$ SELECT a; $$; CREATE FUNCTION pg_temp.dbde_obj_tf() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.v := 1; RETURN NEW; END; $$; CREATE TRIGGER dbde_obj_trg BEFORE INSERT ON pg_temp.dbde_obj_t FOR EACH ROW EXECUTE FUNCTION pg_temp.dbde_obj_tf(); CREATE SEQUENCE pg_temp.dbde_obj_seq INCREMENT BY 5; CREATE PROCEDURE pg_temp.dbde_obj_p(IN x int, INOUT y int) LANGUAGE plpgsql AS $$ BEGIN y := x; END; $$").await.unwrap();
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
        let functions = list_objects(&conn, ObjectKind::Function).await.unwrap();
        let mine: Vec<_> = functions.iter().filter(|f| f.schema == schema).collect();
        assert_eq!(mine.len(), 3, "{:?}", mine);
        let two = mine
            .iter()
            .find(|f| f.signature.as_deref() == Some("integer, text"))
            .unwrap();
        assert!(mine
            .iter()
            .any(|f| f.name == "dbde_obj_tf" && f.flag.as_deref() == Some("trigger")));
        assert!(functions.iter().all(|f| f.schema != "pg_catalog"));
        let definition = object_definition(&conn, two).await.unwrap();
        assert!(
            definition
                .definition
                .starts_with("CREATE OR REPLACE FUNCTION"),
            "{}",
            definition.definition
        );
        assert!(definition
            .execute_script
            .as_deref()
            .unwrap()
            .contains("NULL::integer /* a */,\n  NULL::text /* b */"));
        // A routine body with semicolons, re-sent as one script, replaces the function.
        raw_pool_query(&conn.pool, &definition.edit_script)
            .await
            .unwrap();
        let exec = definition.execute_script.unwrap();
        raw_pool_query(&conn.pool, &exec).await.unwrap();
        let forged = DbObject {
            signature: Some("integer, text); DROP TABLE x; --".into()),
            ..(*two).clone()
        };
        assert!(object_action(&conn, forged, ObjectAction::Drop, None, true)
            .await
            .is_err());
        let drop = object_action(&conn, (*two).clone(), ObjectAction::Drop, None, false)
            .await
            .unwrap();
        assert_eq!(
            drop,
            format!("DROP FUNCTION \"{schema}\".\"dbde_obj_f\"(integer, text)")
        );
        let procedures = list_objects(&conn, ObjectKind::Procedure).await.unwrap();
        let p = procedures.iter().find(|p| p.name == "dbde_obj_p").unwrap();
        assert_eq!(
            p.signature.as_deref(),
            Some("IN x integer, INOUT y integer")
        );
        let call = object_definition(&conn, p)
            .await
            .unwrap()
            .execute_script
            .unwrap();
        assert!(
            call.starts_with(&format!("CALL \"{schema}\".\"dbde_obj_p\"(")),
            "{call}"
        );
        raw_pool_query(&conn.pool, &call).await.unwrap();
        let triggers = list_objects(&conn, ObjectKind::Trigger).await.unwrap();
        let trg = triggers.iter().find(|t| t.name == "dbde_obj_trg").unwrap();
        assert_eq!(trg.detail.as_deref(), Some("BEFORE INSERT · each row"));
        let trigger_def = object_definition(&conn, trg).await.unwrap();
        assert!(
            trigger_def
                .definition
                .starts_with("CREATE TRIGGER dbde_obj_trg BEFORE INSERT"),
            "{}",
            trigger_def.definition
        );
        raw_pool_query(&conn.pool, &trigger_def.edit_script)
            .await
            .unwrap();
        let sequences = list_objects(&conn, ObjectKind::Sequence).await.unwrap();
        let seq = sequences.iter().find(|s| s.name == "dbde_obj_seq").unwrap();
        assert_eq!(seq.increment.as_deref(), Some("5"));
        assert!(object_definition(&conn, seq)
            .await
            .unwrap()
            .definition
            .contains("INCREMENT BY 5"));
        object_action(
            &conn,
            seq.clone(),
            ObjectAction::Restart,
            Some("100"),
            false,
        )
        .await
        .unwrap();
        let next = query(&conn.pool, "SELECT nextval('pg_temp.dbde_obj_seq')")
            .await
            .unwrap();
        assert_eq!(next.rows[0][0], json!(100));
        object_action(&conn, trg.clone(), ObjectAction::Drop, None, false)
            .await
            .unwrap();
        assert!(!list_objects(&conn, ObjectKind::Trigger)
            .await
            .unwrap()
            .iter()
            .any(|t| t.name == "dbde_obj_trg"));
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_PG_URL; the materialized view is created inside a transaction that is always rolled back"]
    async fn postgres_materialized_views_round_trip_in_a_rolled_back_transaction() {
        // Materialized views cannot be temporary. The pool has one connection, so BEGIN
        // holds for every call below; a panic drops the connection, which also rolls back.
        let conn = pg_conn().await;
        raw_pool_query(&conn.pool, "BEGIN; CREATE SCHEMA dbde_obj_mv; CREATE TABLE dbde_obj_mv.src (id int); INSERT INTO dbde_obj_mv.src VALUES (1), (2); CREATE MATERIALIZED VIEW dbde_obj_mv.totals AS SELECT id FROM dbde_obj_mv.src; CREATE UNIQUE INDEX totals_id ON dbde_obj_mv.totals (id)").await.unwrap();
        let result = async {
            let views = list_objects(&conn, ObjectKind::MaterializedView)
                .await
                .unwrap();
            let view = views
                .iter()
                .find(|m| m.schema == "dbde_obj_mv")
                .unwrap()
                .clone();
            assert!(view.refresh_concurrently);
            assert_eq!(view.status.as_deref(), Some("POPULATED"));
            let definition = object_definition(&conn, &view).await.unwrap();
            assert!(
                definition
                    .definition
                    .starts_with("CREATE MATERIALIZED VIEW \"dbde_obj_mv\".\"totals\" AS"),
                "{}",
                definition.definition
            );
            assert!(definition
                .definition
                .contains("CREATE UNIQUE INDEX totals_id"));
            let columns = column_meta::table_columns(
                &conn.pool,
                &TableInfo {
                    name: "totals".into(),
                    schema: "dbde_obj_mv".into(),
                    kind: "view".into(),
                },
            )
            .await
            .unwrap();
            assert_eq!(
                columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
                ["id"]
            );
            raw_pool_query(&conn.pool, "INSERT INTO dbde_obj_mv.src VALUES (3)")
                .await
                .unwrap();
            let sql = object_action(&conn, view.clone(), ObjectAction::Refresh, None, false)
                .await
                .unwrap();
            assert_eq!(sql, "REFRESH MATERIALIZED VIEW \"dbde_obj_mv\".\"totals\"");
            let count = query(&conn.pool, "SELECT COUNT(*) FROM dbde_obj_mv.totals")
                .await
                .unwrap();
            assert_eq!(count.rows[0][0], json!(3));
            raw_pool_query(&conn.pool, &definition.edit_script)
                .await
                .unwrap();
            object_action(&conn, view, ObjectAction::Drop, None, false)
                .await
                .unwrap();
        }
        .await;
        raw_pool_query(&conn.pool, "ROLLBACK").await.unwrap();
        let left = query(
            &conn.pool,
            "SELECT COUNT(*) FROM pg_namespace WHERE nspname = 'dbde_obj_mv'",
        )
        .await
        .unwrap();
        assert_eq!(left.rows[0][0], json!(0));
        result
    }
    /// Drops the test's objects even when an assertion fails, on a fresh connection in its
    /// own runtime (the test's runtime is blocked while this runs).
    struct MysqlCleanup(String, Vec<String>);
    impl Drop for MysqlCleanup {
        fn drop(&mut self) {
            let (url, statements) = (self.0.clone(), std::mem::take(&mut self.1));
            std::thread::spawn(move || {
                tokio::runtime::Runtime::new()
                    .unwrap()
                    .block_on(async move {
                        let pool = sqlx::mysql::MySqlPoolOptions::new()
                            .max_connections(1)
                            .connect(&url)
                            .await
                            .unwrap();
                        for statement in statements {
                            // DROP … IF EXISTS fails only on a server that cannot store that
                            // kind of object at all (see the skips below): nothing was created.
                            if let Err(error) = sqlx::raw_sql(&statement).execute(&pool).await {
                                eprintln!("Cleanup `{statement}`: {error}");
                            }
                        }
                    })
            })
            .join()
            .unwrap();
        }
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_MYSQL_URL; creates uniquely named routines, a trigger and an event in that database and always drops them"]
    async fn mysql_objects_round_trip_and_are_cleaned_up() {
        let url = std::env::var("DBDE_TEST_MYSQL_URL").unwrap();
        let mut conn = crate::tests::server_connection("DBDE_TEST_MYSQL_URL", Driver::Mysql).await;
        let Pool::My(pool) = &conn.pool else {
            unreachable!()
        };
        conn.config.database = sqlx::query_scalar::<_, String>("SELECT DATABASE()")
            .fetch_one(pool)
            .await
            .unwrap();
        let suffix = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        let (f, p, t, e, tbl) = (
            format!("dbde_f_{suffix}"),
            format!("dbde_p_{suffix}"),
            format!("dbde_t_{suffix}"),
            format!("dbde_e_{suffix}"),
            format!("dbde_tbl_{suffix}"),
        );
        let _cleanup = MysqlCleanup(
            url,
            vec![
                format!("DROP FUNCTION IF EXISTS `{f}`"),
                format!("DROP PROCEDURE IF EXISTS `{p}`"),
                format!("DROP EVENT IF EXISTS `{e}`"),
                format!("DROP TABLE IF EXISTS `{tbl}`"),
            ],
        );
        // One call, no DELIMITER: the server parses compound bodies containing semicolons.
        raw_pool_query(&conn.pool, &format!("CREATE TABLE `{tbl}` (id INT); CREATE TRIGGER `{t}` BEFORE INSERT ON `{tbl}` FOR EACH ROW BEGIN SET NEW.id = COALESCE(NEW.id, 0); SET NEW.id = NEW.id + 1; END")).await.unwrap();
        let triggers = list_objects(&conn, ObjectKind::Trigger).await.unwrap();
        let trig = triggers.iter().find(|x| x.name == t).unwrap().clone();
        assert_eq!(trig.table.as_deref(), Some(tbl.as_str()));
        assert_eq!(trig.detail.as_deref(), Some("BEFORE INSERT"));
        let trigger_def = object_definition(&conn, &trig).await.unwrap();
        assert!(trigger_def.definition.contains("COALESCE(NEW.id, 0)"));
        raw_pool_query(&conn.pool, &trigger_def.edit_script)
            .await
            .unwrap();
        raw_pool_query(&conn.pool, &format!("INSERT INTO `{tbl}` VALUES (NULL)"))
            .await
            .unwrap();
        let ids = query(&conn.pool, &format!("SELECT id FROM `{tbl}`"))
            .await
            .unwrap();
        assert_eq!(ids.rows, vec![vec![json!(1)]]);
        let mut other = trig.clone();
        other.schema = "mysql".into();
        assert!(object_action(&conn, other, ObjectAction::Drop, None, false)
            .await
            .is_err());
        object_action(&conn, trig, ObjectAction::Drop, None, false)
            .await
            .unwrap();
        assert!(!list_objects(&conn, ObjectKind::Trigger)
            .await
            .unwrap()
            .iter()
            .any(|x| x.name == t));
        // Servers whose system tables predate their version (MariaDB without mysql_upgrade)
        // disable the event scheduler (error 1577) and cannot store routines (error 1558).
        // Those parts are reported and skipped; the test never changes the server.
        let skipped = |result: &DbResult<QueryResult>| match result {
            Err(error)
                if ["1577", "1558", "mysql.proc"]
                    .iter()
                    .any(|code| error.contains(code)) =>
            {
                eprintln!("Skipping MySQL checks this server cannot run: {error}");
                true
            }
            _ => false,
        };
        let created = raw_pool_query(&conn.pool, &format!("CREATE EVENT `{e}` ON SCHEDULE EVERY 1 DAY DISABLE DO BEGIN SELECT 1; SELECT 2; END")).await;
        if !skipped(&created) {
            created.unwrap();
            let events = list_objects(&conn, ObjectKind::Event).await.unwrap();
            let event = events.iter().find(|x| x.name == e).unwrap().clone();
            assert_eq!(event.status.as_deref(), Some("DISABLED"));
            assert!(event.detail.as_deref().unwrap().starts_with("EVERY 1 DAY"));
            raw_pool_query(
                &conn.pool,
                &object_definition(&conn, &event).await.unwrap().edit_script,
            )
            .await
            .unwrap();
            object_action(&conn, event.clone(), ObjectAction::Enable, None, false)
                .await
                .unwrap();
            let events = list_objects(&conn, ObjectKind::Event).await.unwrap();
            assert_eq!(
                events
                    .iter()
                    .find(|x| x.name == e)
                    .unwrap()
                    .status
                    .as_deref(),
                Some("ENABLED")
            );
            object_action(&conn, event, ObjectAction::Drop, None, false)
                .await
                .unwrap();
            assert!(!list_objects(&conn, ObjectKind::Event)
                .await
                .unwrap()
                .iter()
                .any(|x| x.name == e));
        } else {
            let error = list_objects(&conn, ObjectKind::Event).await.err().unwrap();
            assert!(error.contains("event scheduler is disabled"), "{error}");
        }
        let routines = raw_pool_query(&conn.pool, &format!("CREATE FUNCTION `{f}`(a INT) RETURNS INT DETERMINISTIC BEGIN DECLARE b INT; SET b = a + 1; RETURN b; END; CREATE PROCEDURE `{p}`() BEGIN SELECT 1; SELECT 2; END")).await;
        if skipped(&routines) {
            return;
        }
        routines.unwrap();
        let functions = list_objects(&conn, ObjectKind::Function).await.unwrap();
        let func = functions.iter().find(|x| x.name == f).unwrap().clone();
        assert!(func.detail.as_deref().unwrap().starts_with("RETURNS int"));
        let definition = object_definition(&conn, &func).await.unwrap();
        assert!(definition.definition.contains("SET b = a + 1;"));
        // The edit script (CREATE OR REPLACE on MariaDB, DROP + CREATE on MySQL) runs as one call.
        raw_pool_query(&conn.pool, &definition.edit_script)
            .await
            .unwrap();
        let value = query(&conn.pool, &format!("SELECT `{f}`(1)"))
            .await
            .unwrap();
        assert_eq!(value.rows[0][0], json!(2));
        let procs = list_objects(&conn, ObjectKind::Procedure).await.unwrap();
        let proc_ = procs.iter().find(|x| x.name == p).unwrap().clone();
        raw_pool_query(
            &conn.pool,
            &object_definition(&conn, &proc_).await.unwrap().edit_script,
        )
        .await
        .unwrap();
        for item in [func, proc_] {
            object_action(&conn, item, ObjectAction::Drop, None, false)
                .await
                .unwrap();
        }
        assert!(!list_objects(&conn, ObjectKind::Function)
            .await
            .unwrap()
            .iter()
            .any(|x| x.name == f));
    }
}
