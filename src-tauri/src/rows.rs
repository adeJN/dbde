use super::*;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FilterOperator {
    Equals,
    NotEquals,
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    IsNull,
    IsNotNull,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum FilterJoin {
    #[default]
    And,
    Or,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct TableFilter {
    #[serde(default)]
    join: FilterJoin,
    column: String,
    operator: FilterOperator,
    #[serde(default)]
    value: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum SortDirection {
    Asc,
    Desc,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct TableSort {
    column: String,
    direction: SortDirection,
}
// A UTF-8 string literal built only from hex digits, so no input can end the literal.
fn pg_text_literal(value: &str) -> String {
    let hex: String = value.bytes().map(|b| format!("{b:02x}")).collect();
    format!("convert_from(decode('{hex}', 'hex'), 'UTF8')")
}
pub(crate) fn filter_clause(
    filters: &[TableFilter],
    driver: &Driver,
    columns: &[String],
    inline: bool,
) -> DbResult<(String, Vec<String>)> {
    if filters.len() > 10 {
        return Err("Use at most 10 filter conditions".into());
    }
    let mut conditions = Vec::new();
    let mut values = Vec::new();
    for filter in filters {
        if !columns.contains(&filter.column) || filter.value.len() > 10000 {
            return Err("Invalid filter column or value exceeds 10,000 bytes".into());
        }
        let column = quote(&filter.column, driver);
        match filter.operator {
            FilterOperator::IsNull => conditions.push(format!("{column} IS NULL")),
            FilterOperator::IsNotNull => conditions.push(format!("{column} IS NOT NULL")),
            _ => {
                let escaped = filter
                    .value
                    .replace('!', "!!")
                    .replace('%', "!%")
                    .replace('_', "!_");
                let (operator, value, suffix) = match filter.operator {
                    FilterOperator::Equals => ("=", filter.value.clone(), ""),
                    FilterOperator::NotEquals => ("<>", filter.value.clone(), ""),
                    FilterOperator::Contains => ("LIKE", format!("%{escaped}%"), " ESCAPE '!'"),
                    FilterOperator::NotContains => {
                        ("NOT LIKE", format!("%{escaped}%"), " ESCAPE '!'")
                    }
                    FilterOperator::StartsWith => ("LIKE", format!("{escaped}%"), " ESCAPE '!'"),
                    FilterOperator::EndsWith => ("LIKE", format!("%{escaped}"), " ESCAPE '!'"),
                    _ => unreachable!(),
                };
                let placeholder = if inline {
                    pg_text_literal(&value)
                } else if matches!(driver, Driver::Postgres) {
                    values.push(value);
                    format!("${}", values.len())
                } else {
                    values.push(value);
                    "?".into()
                };
                let cast = if matches!(driver, Driver::Mysql) {
                    "CHAR"
                } else {
                    "TEXT"
                };
                conditions.push(format!(
                    "CAST({column} AS {cast}) {operator} {placeholder}{suffix}"
                ));
            }
        }
    }
    Ok((
        if conditions.is_empty() {
            String::new()
        } else {
            format!(
                " WHERE {}",
                conditions
                    .iter()
                    .enumerate()
                    .map(|(index, condition)| {
                        let connector = if index == 0 {
                            ""
                        } else if matches!(filters[index].join, FilterJoin::Or) {
                            " OR "
                        } else {
                            " AND "
                        };
                        format!("{connector}{condition}")
                    })
                    .collect::<String>()
            )
        },
        values,
    ))
}

#[derive(Serialize)]
pub(crate) struct TablePagination {
    page: u64,
    page_size: u32,
    total_rows: u64,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    estimated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    has_next: Option<bool>,
}
// Above this size an exact COUNT(*) on every page change costs more than it is worth.
const ESTIMATE_ROWS_ABOVE: u64 = 1_000_000;
async fn estimated_rows(conn: &Connection, table: &TableInfo) -> Option<u64> {
    if table.kind != "table" {
        return None;
    }
    let estimate: Option<i64> = match &conn.pool {
        Pool::Pg(p) => sqlx::query_scalar("SELECT c.reltuples::bigint FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2")
            .bind(&table.schema).bind(&table.name).fetch_optional(p).await.ok().flatten(),
        Pool::My(p) => sqlx::query_scalar::<_, Option<u64>>("SELECT table_rows FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?")
            .bind(&table.name).fetch_optional(p).await.ok().flatten().flatten().and_then(|n| i64::try_from(n).ok()),
        Pool::Lite(_) => None,
    };
    estimate
        .and_then(|n| u64::try_from(n).ok())
        .filter(|n| *n >= ESTIMATE_ROWS_ABOVE)
}

#[derive(Clone, Serialize)]
pub(crate) struct TableSource {
    quick: bool,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    filters: Vec<TableFilter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sort: Option<TableSort>,
    table: TableInfo,
    database: String,
    primary_keys: Vec<String>,
}
pub(crate) async fn columns_of(conn: &Connection, target: &str) -> DbResult<Vec<String>> {
    Ok(
        query(&conn.pool, &format!("SELECT * FROM {target} LIMIT 0"))
            .await?
            .columns,
    )
}
impl TableSort {
    pub(crate) fn column(&self) -> &str {
        &self.column
    }
}
// The sort column first, then the primary key, so pages and exports share one order.
pub(crate) fn order_clause(sort: Option<&TableSort>, keys: &[String], driver: &Driver) -> String {
    let mut order_columns = Vec::new();
    if let Some(item) = sort {
        let direction = match item.direction {
            SortDirection::Asc => "ASC",
            SortDirection::Desc => "DESC",
        };
        order_columns.push(format!("{} {direction}", quote(&item.column, driver)));
    }
    order_columns.extend(
        keys.iter()
            .filter(|key| sort.is_none_or(|item| item.column != **key))
            .map(|key| quote(key, driver)),
    );
    if order_columns.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", order_columns.join(", "))
    }
}
pub(crate) fn quote(value: &str, driver: &Driver) -> String {
    let q = if matches!(driver, Driver::Mysql) {
        '`'
    } else {
        '"'
    };
    format!("{q}{}{q}", value.replace(q, &format!("{q}{q}")))
}
pub(crate) fn qualified(table: &TableInfo, driver: &Driver) -> String {
    if table.schema.is_empty() {
        quote(&table.name, driver)
    } else {
        format!(
            "{}.{}",
            quote(&table.schema, driver),
            quote(&table.name, driver)
        )
    }
}
pub(crate) async fn primary_keys(conn: &Connection, table: &TableInfo) -> DbResult<Vec<String>> {
    match &conn.pool {
        Pool::Pg(p) => sqlx::query_scalar::<_, String>("SELECT k.column_name FROM information_schema.table_constraints t JOIN information_schema.key_column_usage k ON k.constraint_name = t.constraint_name AND k.constraint_schema = t.constraint_schema AND k.table_name = t.table_name WHERE t.constraint_type = 'PRIMARY KEY' AND t.table_schema = $1 AND t.table_name = $2 ORDER BY k.ordinal_position").bind(&table.schema).bind(&table.name).fetch_all(p).await.map_err(err),
        Pool::My(p) => {
            if table.schema != conn.config.database { return Err("Table does not belong to the selected database".into()); }
            sqlx::query_scalar::<_, String>("SELECT column_name FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = 'PRIMARY' ORDER BY ordinal_position").bind(&table.name).fetch_all(p).await.map_err(err)
        },
        Pool::Lite(p) => {
            if !table.schema.is_empty() && table.schema != "main" { return Err("Only the main SQLite database supports row actions".into()); }
            sqlx::query_scalar::<_, String>("SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk").bind(&table.name).fetch_all(p).await.map_err(err)
        },
    }
}
#[cfg(test)]
async fn view_table(conn: &Connection, table: TableInfo) -> DbResult<QueryResult> {
    view_table_page(conn, table, 1, 1000).await
}
#[cfg(test)]
async fn view_table_page(
    conn: &Connection,
    table: TableInfo,
    requested_page: u64,
    page_size: u32,
) -> DbResult<QueryResult> {
    view_filtered_table_page(conn, table, requested_page, page_size, &[]).await
}
#[cfg(test)]
async fn view_filtered_table_page(
    conn: &Connection,
    table: TableInfo,
    requested_page: u64,
    page_size: u32,
    filters: &[TableFilter],
) -> DbResult<QueryResult> {
    view_sorted_table_page(conn, table, requested_page, page_size, filters, None).await
}
#[cfg(test)]
async fn view_sorted_table_page(
    conn: &Connection,
    table: TableInfo,
    requested_page: u64,
    page_size: u32,
    filters: &[TableFilter],
    sort: Option<TableSort>,
) -> DbResult<QueryResult> {
    view_table_options(conn, table, requested_page, page_size, filters, sort, false).await
}
async fn view_table_options(
    conn: &Connection,
    table: TableInfo,
    requested_page: u64,
    page_size: u32,
    filters: &[TableFilter],
    sort: Option<TableSort>,
    quick: bool,
) -> DbResult<QueryResult> {
    view_table_page_with_estimate(
        conn,
        table,
        requested_page,
        page_size,
        TableReadOptions {
            filters,
            sort,
            quick,
            ..Default::default()
        },
    )
    .await
}
#[derive(Default)]
struct TableReadOptions<'a> {
    filters: &'a [TableFilter],
    sort: Option<TableSort>,
    quick: bool,
    estimate_override: Option<u64>,
}
// The optional estimate allows exercising stale server statistics with local fixtures.
async fn view_table_page_with_estimate(
    conn: &Connection,
    table: TableInfo,
    requested_page: u64,
    page_size: u32,
    options: TableReadOptions<'_>,
) -> DbResult<QueryResult> {
    let TableReadOptions {
        filters,
        sort,
        quick,
        estimate_override,
    } = options;
    if requested_page == 0
        || requested_page > 9_007_199_254_740_991
        || page_size == 0
        || page_size > 5000
    {
        return Err("Page must be positive and page size must be between 1 and 5,000".into());
    }
    let keys = primary_keys(conn, &table).await?;
    if quick && keys.is_empty() {
        return Err("Quick mode requires a primary key. Use Open Table instead.".into());
    }
    let target = qualified(&table, &conn.config.driver);
    let deferred = if quick {
        crate::table_actions::binary_columns(conn, &table).await?
    } else {
        Vec::new()
    };
    if quick && keys.iter().any(|k| deferred.contains(k)) {
        return Err("Quick mode requires scalar primary keys. Use Open Table instead.".into());
    }
    let projection = if deferred.is_empty() {
        "*".to_string()
    } else {
        columns_of(conn, &target)
            .await?
            .iter()
            .map(|name| {
                let q = quote(name, &conn.config.driver);
                if deferred.contains(name) {
                    format!("NULL AS {q}")
                } else {
                    q
                }
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let columns = if filters.is_empty() && sort.is_none() {
        Vec::new()
    } else {
        columns_of(conn, &target).await?
    };
    if sort
        .as_ref()
        .is_some_and(|item| !columns.contains(&item.column))
    {
        return Err("Unknown sort column".into());
    }
    // PostgreSQL reads go over the text protocol so every column type renders (enums,
    // arrays, intervals); filter values are inlined as hex-encoded literals instead.
    let text_protocol = matches!(conn.config.driver, Driver::Postgres);
    let (where_sql, values) = filter_clause(filters, &conn.config.driver, &columns, text_protocol)?;
    let read = |sql: String| {
        let values = values.clone();
        async move {
            if text_protocol {
                raw_pool_query(&conn.pool, &sql).await
            } else {
                query_with_params(&conn.pool, &sql, &values).await
            }
        }
    };
    let estimate = if filters.is_empty() {
        match estimate_override {
            Some(rows) => Some(rows),
            None => estimated_rows(conn, &table).await,
        }
    } else {
        None
    };
    let mut total_rows = match estimate {
        Some(rows) => rows,
        None => read(format!("SELECT COUNT(*) FROM {target}{where_sql}"))
            .await?
            .rows
            .first()
            .and_then(|row| row.first())
            .and_then(|value| {
                value
                    .as_u64()
                    .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
            })
            .ok_or_else(|| "Cannot read the table row count".to_string())?,
    };
    let total_pages = total_rows.div_ceil(u64::from(page_size)).max(1);
    // Statistics are not a hard boundary: the next page may exist beyond them.
    let page = if estimate.is_some() {
        requested_page
    } else {
        requested_page.min(total_pages)
    };
    let offset = (page - 1)
        .checked_mul(u64::from(page_size))
        .ok_or_else(|| "Page offset is too large".to_string())?;
    let order = order_clause(sort.as_ref(), &keys, &conn.config.driver);
    let limit = page_size + u32::from(estimate.is_some());
    let mut result = read(format!(
        "SELECT {projection} FROM {target}{where_sql}{order} LIMIT {limit} OFFSET {offset}"
    ))
    .await?;
    let has_next = estimate.map(|_| result.rows.len() > page_size as usize);
    result.rows.truncate(page_size as usize);
    if estimate.is_some() {
        total_rows = total_rows.max(
            offset
                .saturating_add(result.rows.len() as u64)
                .saturating_add(u64::from(has_next == Some(true))),
        );
    }
    if result.columns.is_empty() {
        result.columns = columns_of(conn, &target).await?;
    }
    for row in &mut result.rows {
        for (i, name) in result.columns.iter().enumerate() {
            if deferred.contains(name) {
                row[i] = json!({"deferred": true});
            }
        }
    }
    result.pagination = Some(TablePagination {
        page,
        page_size,
        total_rows,
        estimated: estimate.is_some(),
        has_next,
    });
    result.source = Some(TableSource {
        quick,
        filters: filters.to_vec(),
        sort,
        table,
        database: if matches!(conn.config.driver, Driver::Sqlite) {
            PathBuf::from(&conn.config.file_path)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into()
        } else {
            conn.config.database.clone()
        },
        primary_keys: keys,
    });
    Ok(result)
}
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Each argument is a named IPC field from the webview.
pub(crate) async fn dbde_view_table(
    connection_id: String,
    database: String,
    table: TableInfo,
    page: Option<u64>,
    page_size: Option<u32>,
    filters: Option<Vec<TableFilter>>,
    sort: Option<TableSort>,
    quick: Option<bool>,
    state: State<'_, AppState>,
) -> DbResult<QueryResult> {
    timed(async {
        let conn = database_connection(&state, &connection_id, Some(&database)).await?;
        let filters = filters.unwrap_or_default();
        view_table_options(
            &conn,
            table,
            page.unwrap_or(1),
            page_size.unwrap_or(1000),
            &filters,
            sort,
            quick.unwrap_or(false),
        )
        .await
    })
    .await
}
pub(crate) enum Bind {
    Text(Option<String>),
    Int(i64),
    Real(f64),
}
// SQLite compares a column without type affinity by storage class, so a numeric key must
// be bound as a number. The other drivers receive text and convert it to the column type.
fn key_bind(value: &Value, driver: &Driver) -> DbResult<Bind> {
    if let (Driver::Sqlite, Value::Number(n)) = (driver, value) {
        if let Some(i) = n.as_i64() {
            return Ok(Bind::Int(i));
        }
        if let Some(f) = n.as_f64() {
            return Ok(Bind::Real(f));
        }
    }
    key_value(value).map(|text| Bind::Text(Some(text)))
}
macro_rules! bind_all {
    ($statement:expr, $values:expr) => {{
        let mut statement = $statement;
        for value in $values {
            statement = match value {
                Bind::Text(v) => statement.bind(v.clone()),
                Bind::Int(v) => statement.bind(*v),
                Bind::Real(v) => statement.bind(*v),
            };
        }
        statement
    }};
}
fn key_value(value: &Value) -> DbResult<String> {
    match value {
        Value::String(v) => Ok(v.clone()),
        Value::Number(v) if v.is_i64() || v.is_u64() => Ok(v.to_string()),
        Value::Bool(v) => Ok(v.to_string()),
        _ => Err("Unsupported or NULL primary key. Use an explicit SQL query for this row.".into()),
    }
}
// The bare key column stays on the left so the primary key index serves each lookup.
// Casting the column instead forced a full scan per row. A primary key matches at most
// one row under its own type and collation, which the rows_affected checks still enforce.
fn key_conditions(
    keys: &[String],
    driver: &Driver,
    types: &HashMap<String, String>,
    first_placeholder: usize,
) -> DbResult<String> {
    keys.iter()
        .enumerate()
        .map(|(i, key)| {
            let column = quote(key, driver);
            Ok(match driver {
                Driver::Postgres => format!(
                    "{column} = CAST(${} AS {})",
                    first_placeholder + i,
                    types.get(key).ok_or("Unknown primary key type")?
                ),
                Driver::Mysql | Driver::Sqlite => format!("{column} = ?"),
            })
        })
        .collect::<DbResult<Vec<_>>>()
        .map(|conditions| conditions.join(" AND "))
}
fn delete_sql(
    table: &TableInfo,
    keys: &[String],
    driver: &Driver,
    types: &HashMap<String, String>,
) -> DbResult<String> {
    Ok(format!(
        "DELETE FROM {} WHERE {}",
        qualified(table, driver),
        key_conditions(keys, driver, types, 1)?
    ))
}
macro_rules! delete_transaction {
    ($pool:expr, $sql:expr, $values:expr) => {{
        let mut tx = $pool.begin().await.map_err(err)?;
        let mut deleted = 0;
        for values in $values {
            let statement = bind_all!(sqlx::query($sql), values);
            let count = statement.execute(&mut *tx).await.map_err(err)?.rows_affected();
            if count != 1 { tx.rollback().await.map_err(err)?; return Err("The selection is stale or a key did not match exactly one row. No rows were deleted. Refresh the table.".into()); }
            deleted += count;
        }
        tx.commit().await.map_err(err)?; Ok(deleted)
    }};
}
async fn delete_rows(
    conn: &Connection,
    table: &TableInfo,
    rows: &[HashMap<String, Value>],
) -> DbResult<u64> {
    if rows.is_empty() || rows.len() > 1000 {
        return Err("Select between 1 and 1,000 rows to delete".into());
    }
    let keys = primary_keys(conn, table).await?;
    if keys.is_empty() {
        return Err("This table has no primary key. Row deletion is unavailable.".into());
    }
    let identities: Vec<Vec<String>> = rows
        .iter()
        .map(|row| checked_key_values(&keys, row))
        .collect::<DbResult<_>>()?;
    let mut seen = std::collections::HashSet::new();
    if identities.iter().any(|key| !seen.insert(key.clone())) {
        return Err("Duplicate primary keys in selection".into());
    }
    let values: Vec<Vec<Bind>> = rows
        .iter()
        .map(|row| {
            keys.iter()
                .map(|key| key_bind(&row[key], &conn.config.driver))
                .collect()
        })
        .collect::<DbResult<_>>()?;
    let types = pg_column_types(conn, table).await?;
    let sql = delete_sql(table, &keys, &conn.config.driver, &types)?;
    match &conn.pool {
        Pool::Pg(p) => delete_transaction!(p, &sql, &values),
        Pool::My(p) => {
            let engine: Option<String> = sqlx::query_scalar("SELECT ENGINE FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?").bind(&table.name).fetch_optional(p).await.map_err(err)?.flatten();
            if !engine.is_some_and(|e| e.eq_ignore_ascii_case("InnoDB")) {
                return Err("Row deletion requires an InnoDB table so the whole selection can be rolled back on failure.".into());
            }
            delete_transaction!(p, &sql, &values)
        }
        Pool::Lite(p) => delete_transaction!(p, &sql, &values),
    }
}
#[tauri::command]
pub(crate) async fn dbde_delete_rows(
    connection_id: String,
    database: String,
    table: TableInfo,
    keys: Vec<HashMap<String, Value>>,
    state: State<'_, AppState>,
) -> DbResult<u64> {
    timed(async {
        let conn = database_connection(&state, &connection_id, Some(&database)).await?;
        delete_rows(&conn, &table, &keys).await
    })
    .await
}

fn checked_key_values(keys: &[String], key: &HashMap<String, Value>) -> DbResult<Vec<String>> {
    if keys.is_empty() || key.len() != keys.len() {
        return Err("The complete primary key is required".into());
    }
    keys.iter()
        .map(|name| {
            key.get(name)
                .ok_or_else(|| "Primary key column is missing".to_string())
                .and_then(key_value)
        })
        .collect()
}
fn check_write_target(table: &TableInfo) -> DbResult<()> {
    if table.kind != "table" {
        Err("Records can only be changed in a table".into())
    } else {
        Ok(())
    }
}
async fn pg_column_types(
    conn: &Connection,
    table: &TableInfo,
) -> DbResult<HashMap<String, String>> {
    let Pool::Pg(pool) = &conn.pool else {
        return Ok(HashMap::new());
    };
    let rows = sqlx::query("SELECT a.attname, format_type(a.atttypid, a.atttypmod) FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped")
        .bind(&table.schema).bind(&table.name).fetch_all(pool).await.map_err(err)?;
    rows.iter()
        .map(|row| Ok((row.try_get(0).map_err(err)?, row.try_get(1).map_err(err)?)))
        .collect()
}
macro_rules! write_statement {
    ($pool:expr, $sql:expr, $values:expr) => {{
        bind_all!(sqlx::query($sql), &$values)
            .execute($pool)
            .await
            .map_err(err)?
            .rows_affected()
    }};
}
async fn update_cell(
    conn: &Connection,
    table: &TableInfo,
    key: &HashMap<String, Value>,
    column: &str,
    value: Option<String>,
) -> DbResult<u64> {
    check_write_target(table)?;
    if value.as_ref().is_some_and(|text| text.len() > 1_000_000) {
        return Err("Cell value exceeds 1 MB".into());
    }
    let keys = primary_keys(conn, table).await?;
    checked_key_values(&keys, key)?; // Rejects incomplete, NULL or binary keys.
    let target = qualified(table, &conn.config.driver);
    let columns = query(&conn.pool, &format!("SELECT * FROM {target} LIMIT 0"))
        .await?
        .columns;
    if !columns.iter().any(|name| name == column) {
        return Err("This column cannot be edited".into());
    }
    if keys.iter().any(|name| name == column) {
        return apply_changes(
            conn,
            table,
            &[Change::Update {
                key: key.clone(),
                values: HashMap::from([(column.to_string(), value)]),
            }],
        )
        .await;
    }
    let types = pg_column_types(conn, table).await?;
    let conditions = key_conditions(&keys, &conn.config.driver, &types, 2)?;
    let placeholder = if matches!(conn.config.driver, Driver::Postgres) {
        format!(
            "CAST($1 AS {})",
            types.get(column).ok_or("Unknown column type")?
        )
    } else {
        "?".into()
    };
    let sql = format!(
        "UPDATE {target} SET {} = {placeholder} WHERE {conditions}",
        quote(column, &conn.config.driver)
    );
    let mut values = vec![Bind::Text(value)];
    for name in &keys {
        values.push(key_bind(&key[name], &conn.config.driver)?);
    }
    let changed = match &conn.pool {
        Pool::Pg(p) => write_statement!(p, &sql, values),
        Pool::My(p) => write_statement!(p, &sql, values),
        Pool::Lite(p) => write_statement!(p, &sql, values),
    };
    if changed != 1 {
        return Err("The record was not updated. Refresh the table and try again.".into());
    }
    Ok(changed)
}
#[tauri::command]
pub(crate) async fn dbde_update_cell(
    connection_id: String,
    database: String,
    table: TableInfo,
    key: HashMap<String, Value>,
    column: String,
    value: Option<String>,
    state: State<'_, AppState>,
) -> DbResult<u64> {
    timed(async {
        let conn = database_connection(&state, &connection_id, Some(&database)).await?;
        update_cell(&conn, &table, &key, &column, value).await
    })
    .await
}
const MAX_INSERT_RECORDS: usize = 1000;
// One INSERT per record; omitted columns take their defaults, None is an explicit NULL.
fn insert_statement(
    driver: &Driver,
    target: &str,
    columns: &[String],
    types: &HashMap<String, String>,
    values: &HashMap<String, Option<String>>,
) -> DbResult<(String, Vec<Bind>)> {
    if values.len() > 256
        || values
            .values()
            .any(|value| value.as_ref().is_some_and(|text| text.len() > 1_000_000))
    {
        return Err("Too many columns or a value exceeds 1 MB".into());
    }
    if values.keys().any(|key| !columns.contains(key)) {
        return Err("Unknown insert column".into());
    }
    let selected = columns
        .iter()
        .filter(|name| values.contains_key(*name))
        .collect::<Vec<_>>();
    let sql = if selected.is_empty() {
        if matches!(driver, Driver::Mysql) {
            format!("INSERT INTO {target} () VALUES ()")
        } else {
            format!("INSERT INTO {target} DEFAULT VALUES")
        }
    } else {
        let names = selected
            .iter()
            .map(|name| quote(name, driver))
            .collect::<Vec<_>>()
            .join(", ");
        let placeholders = selected
            .iter()
            .enumerate()
            .map(|(index, name)| {
                if matches!(driver, Driver::Postgres) {
                    Ok(format!(
                        "CAST(${} AS {})",
                        index + 1,
                        types.get(*name).ok_or("Unknown column type")?
                    ))
                } else {
                    Ok("?".to_string())
                }
            })
            .collect::<DbResult<Vec<_>>>()?
            .join(", ");
        format!("INSERT INTO {target} ({names}) VALUES ({placeholders})")
    };
    let params = selected
        .iter()
        .map(|name| Bind::Text(values.get(*name).cloned().unwrap()))
        .collect();
    Ok((sql, params))
}
// Runs labelled statements in one transaction; each must touch exactly one row.
// Dropping the transaction on an early error rolls it back as well.
macro_rules! statements_transaction {
    ($pool:expr, $statements:expr, $nothing:expr) => {{
        let mut tx = $pool.begin().await.map_err(err)?;
        let mut changed = 0;
        for (label, sql, params) in $statements.iter() {
            let count = bind_all!(sqlx::query(sql), params)
                .execute(&mut *tx)
                .await
                .map_err(|e| format!("{label}: {e}. {}", $nothing))?
                .rows_affected();
            if count != 1 {
                tx.rollback().await.map_err(err)?;
                return Err(format!(
                    "{label} matched {count} rows instead of one; the table changed since it was loaded. {} Refresh and try again.",
                    $nothing
                ));
            }
            changed += count;
        }
        tx.commit().await.map_err(err)?;
        Ok(changed)
    }};
}
async fn require_innodb_for_batches(
    conn: &Connection,
    table: &TableInfo,
    count: usize,
) -> DbResult<()> {
    let Pool::My(p) = &conn.pool else {
        return Ok(());
    };
    if count < 2 {
        return Ok(());
    }
    let engine: Option<String> = sqlx::query_scalar("SELECT ENGINE FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?").bind(&table.name).fetch_optional(p).await.map_err(err)?.flatten();
    if engine.is_some_and(|e| e.eq_ignore_ascii_case("InnoDB")) {
        Ok(())
    } else {
        Err("Saving several changes at once requires an InnoDB table so a failure can be rolled back. Save them one at a time.".into())
    }
}
// Saves every record or none, so a failed copy never leaves half a batch behind.
async fn insert_records(
    conn: &Connection,
    table: &TableInfo,
    records: &[HashMap<String, Option<String>>],
) -> DbResult<u64> {
    check_write_target(table)?;
    if records.is_empty() || records.len() > MAX_INSERT_RECORDS {
        return Err(format!(
            "Save between 1 and {MAX_INSERT_RECORDS} records at a time"
        ));
    }
    let target = qualified(table, &conn.config.driver);
    let columns = columns_of(conn, &target).await?;
    let types = pg_column_types(conn, table).await?;
    let total = records.len();
    let statements = records
        .iter()
        .enumerate()
        .map(|(i, values)| {
            insert_statement(&conn.config.driver, &target, &columns, &types, values)
                .map(|(sql, params)| (format!("Record {} of {total}", i + 1), sql, params))
        })
        .collect::<DbResult<Vec<_>>>()?;
    require_innodb_for_batches(conn, table, statements.len()).await?;
    run_statements(conn, &statements, "No records were saved.").await
}
async fn run_statements(
    conn: &Connection,
    statements: &[(String, String, Vec<Bind>)],
    nothing: &str,
) -> DbResult<u64> {
    match &conn.pool {
        Pool::Pg(p) => statements_transaction!(p, statements, nothing),
        Pool::My(p) => statements_transaction!(p, statements, nothing),
        Pool::Lite(p) => statements_transaction!(p, statements, nothing),
    }
}

/// One staged edit from the data editor. Keys identify existing rows by primary key.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum Change {
    Update {
        key: HashMap<String, Value>,
        values: HashMap<String, Option<String>>,
    },
    Insert {
        values: HashMap<String, Option<String>>,
    },
    Delete {
        key: HashMap<String, Value>,
    },
}
const MAX_CHANGES: usize = 5000;
fn describe_key(keys: &[String], key: &HashMap<String, Value>) -> String {
    keys.iter()
        .map(|name| {
            format!(
                "{name}={}",
                key.get(name).map(|v| v.to_string()).unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}
// Applies a batch of staged edits in one transaction: all of them, or none.
async fn apply_changes(conn: &Connection, table: &TableInfo, changes: &[Change]) -> DbResult<u64> {
    check_write_target(table)?;
    if changes.is_empty() || changes.len() > MAX_CHANGES {
        return Err(format!(
            "Apply between 1 and {MAX_CHANGES} changes at a time"
        ));
    }
    let driver = &conn.config.driver;
    let target = qualified(table, driver);
    let columns = columns_of(conn, &target).await?;
    let types = pg_column_types(conn, table).await?;
    let needs_keys = changes.iter().any(|c| !matches!(c, Change::Insert { .. }));
    let keys = if needs_keys {
        primary_keys(conn, table).await?
    } else {
        Vec::new()
    };
    if needs_keys && keys.is_empty() {
        return Err(
            "This table has no primary key, so existing rows cannot be changed here.".into(),
        );
    }
    let changes_key = |change: &Change| matches!(change, Change::Update { values, .. } if keys.iter().any(|name| values.contains_key(name)));
    if changes.iter().any(changes_key) {
        let mut seen = std::collections::HashSet::new();
        for change in changes {
            let key = match change {
                Change::Update { key, .. } | Change::Delete { key } => key,
                Change::Insert { .. } => continue,
            };
            checked_key_values(&keys, key)?;
            let identity = keys
                .iter()
                .map(|name| {
                    key[name]
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| key[name].to_string())
                })
                .collect::<Vec<_>>();
            if !seen.insert(identity) {
                return Err("A primary key edit cannot target the same record more than once. Nothing was saved.".into());
            }
        }
    }
    let total = changes.len();
    let mut statements = Vec::with_capacity(total);
    // Preserve old identities until all ordinary updates/deletes/inserts have run.
    let mut ordered = changes.iter().enumerate().collect::<Vec<_>>();
    ordered.sort_by_key(|(_, change)| changes_key(change));
    for (i, change) in ordered {
        let position = format!("Change {} of {total}", i + 1);
        statements.push(match change {
            Change::Insert { values } => {
                let (sql, params) = insert_statement(driver, &target, &columns, &types, values)?;
                (format!("{position} (new record)"), sql, params)
            }
            Change::Delete { key } => {
                checked_key_values(&keys, key)?;
                let params = keys
                    .iter()
                    .map(|name| key_bind(&key[name], driver))
                    .collect::<DbResult<Vec<_>>>()?;
                (
                    format!("{position} (delete {})", describe_key(&keys, key)),
                    delete_sql(table, &keys, driver, &types)?,
                    params,
                )
            }
            Change::Update { key, values } => {
                checked_key_values(&keys, key)?;
                if values.is_empty() || values.len() > 256 {
                    return Err(format!("{position}: nothing to update"));
                }
                // Sorted so the SQL is stable; columns are checked against the table.
                let mut names: Vec<&String> = values.keys().collect();
                names.sort();
                let mut assignments = Vec::new();
                let mut params = Vec::new();
                for (index, name) in names.iter().enumerate() {
                    if !columns.contains(name) {
                        return Err(format!("{position}: column {name} cannot be edited"));
                    }
                    let value = values[*name].clone();
                    if keys.contains(name) && value.is_none() {
                        return Err(format!("{position}: primary key cannot be NULL"));
                    }
                    if value.as_ref().is_some_and(|text| text.len() > 1_000_000) {
                        return Err(format!("{position}: a value exceeds 1 MB"));
                    }
                    let placeholder = if matches!(driver, Driver::Postgres) {
                        format!(
                            "CAST(${} AS {})",
                            index + 1,
                            types.get(*name).ok_or("Unknown column type")?
                        )
                    } else {
                        "?".into()
                    };
                    assignments.push(format!("{} = {placeholder}", quote(name, driver)));
                    params.push(Bind::Text(value));
                }
                for name in &keys {
                    params.push(key_bind(&key[name], driver)?);
                }
                let conditions = key_conditions(&keys, driver, &types, names.len() + 1)?;
                (
                    format!("{position} (update {})", describe_key(&keys, key)),
                    format!(
                        "UPDATE {target} SET {} WHERE {conditions}",
                        assignments.join(", ")
                    ),
                    params,
                )
            }
        });
    }
    require_innodb_for_batches(conn, table, statements.len()).await?;
    run_statements(conn, &statements, "Nothing was saved.").await
}
#[tauri::command]
pub(crate) async fn dbde_apply_changes(
    connection_id: String,
    database: String,
    table: TableInfo,
    changes: Vec<Change>,
    state: State<'_, AppState>,
) -> DbResult<u64> {
    timed(async {
        let conn = database_connection(&state, &connection_id, Some(&database)).await?;
        apply_changes(&conn, &table, &changes).await
    })
    .await
}
async fn insert_record(
    conn: &Connection,
    table: &TableInfo,
    values: &HashMap<String, Option<String>>,
) -> DbResult<u64> {
    insert_records(conn, table, std::slice::from_ref(values)).await
}
#[tauri::command]
pub(crate) async fn dbde_insert_record(
    connection_id: String,
    database: String,
    table: TableInfo,
    values: HashMap<String, Option<String>>,
    state: State<'_, AppState>,
) -> DbResult<u64> {
    timed(async {
        let conn = database_connection(&state, &connection_id, Some(&database)).await?;
        insert_record(&conn, &table, &values).await
    })
    .await
}
#[tauri::command]
pub(crate) async fn dbde_insert_records(
    connection_id: String,
    database: String,
    table: TableInfo,
    records: Vec<HashMap<String, Option<String>>>,
    state: State<'_, AppState>,
) -> DbResult<u64> {
    timed(async {
        let conn = database_connection(&state, &connection_id, Some(&database)).await?;
        insert_records(&conn, &table, &records).await
    })
    .await
}

#[cfg(test)]
pub(crate) mod tests_support {
    use super::*;
    pub(crate) async fn view(conn: &Connection, table: TableInfo) -> Vec<Vec<Value>> {
        view_table(conn, table).await.unwrap().rows
    }
    pub(crate) async fn filtered(
        conn: &Connection,
        table: TableInfo,
        column: &str,
        value: &str,
    ) -> Vec<Vec<Value>> {
        let filter = TableFilter {
            join: FilterJoin::And,
            column: column.into(),
            operator: FilterOperator::Contains,
            value: value.into(),
        };
        view_filtered_table_page(conn, table, 1, 100, &[filter])
            .await
            .unwrap()
            .rows
    }
    pub(crate) async fn page_json(conn: &Connection, table: TableInfo, contains: &[&str]) -> Value {
        let filters: Vec<TableFilter> = contains
            .chunks(2)
            .map(|pair| TableFilter {
                join: FilterJoin::And,
                column: pair[0].into(),
                operator: FilterOperator::Contains,
                value: pair[1].into(),
            })
            .collect();
        let page = view_filtered_table_page(conn, table, 1, 10, &filters)
            .await
            .unwrap();
        serde_json::to_value(page.pagination.unwrap()).unwrap()
    }
    pub(crate) async fn update(
        conn: &Connection,
        table: &TableInfo,
        key: &HashMap<String, Value>,
        column: &str,
        value: Option<String>,
    ) -> DbResult<u64> {
        update_cell(conn, table, key, column, value).await
    }
    pub(crate) async fn delete(
        conn: &Connection,
        table: &TableInfo,
        rows: &[HashMap<String, Value>],
    ) -> DbResult<u64> {
        delete_rows(conn, table, rows).await
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn quick_mode_defers_binary_values_and_loads_by_complete_primary_key() {
        let conn = setup().await;
        raw_pool_query(&conn.pool, "CREATE TABLE quick_binary (id INTEGER PRIMARY KEY, payload BLOB); INSERT INTO quick_binary VALUES (1, X'00ff')").await.unwrap();
        let table = TableInfo {
            name: "quick_binary".into(),
            schema: "".into(),
            kind: "table".into(),
        };
        let page = view_table_options(&conn, table.clone(), 1, 1000, &[], None, true)
            .await
            .unwrap();
        assert_eq!(page.rows, vec![vec![json!(1), json!({"deferred": true})]]);
        let row = load_record(&conn, &table, &HashMap::from([("id".into(), json!(1))]))
            .await
            .unwrap();
        assert_eq!(row, vec![json!(1), json!({"hex": "00ff"})]);
        assert!(load_record(&conn, &table, &HashMap::new()).await.is_err());
    }

    #[tokio::test]
    async fn batches_insert_every_record_or_none() {
        let conn = setup().await;
        query(&conn.pool, "CREATE TABLE people (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, note TEXT DEFAULT 'none')").await.unwrap();
        let table = TableInfo {
            name: "people".into(),
            schema: "".into(),
            kind: "table".into(),
        };
        let record = |email: &str, note: Option<Option<&str>>| {
            let mut values = HashMap::from([("email".to_string(), Some(email.to_string()))]);
            if let Some(note) = note {
                values.insert("note".into(), note.map(String::from));
            }
            values
        };
        let saved = insert_records(
            &conn,
            &table,
            &[
                record("a@x", None),
                record("b@x", Some(None)),
                record("c@x", Some(Some("hi"))),
            ],
        )
        .await
        .unwrap();
        assert_eq!(saved, 3);
        let rows = query(&conn.pool, "SELECT email, note FROM people ORDER BY id")
            .await
            .unwrap()
            .rows;
        assert_eq!(
            rows,
            vec![
                vec![json!("a@x"), json!("none")],
                vec![json!("b@x"), Value::Null],
                vec![json!("c@x"), json!("hi")]
            ]
        );
        // The duplicate email fails the second record; the first must not stay behind.
        let error = insert_records(&conn, &table, &[record("d@x", None), record("a@x", None)])
            .await
            .unwrap_err();
        assert!(error.starts_with("Record 2 of 2"), "{error}");
        assert!(error.ends_with("No records were saved."), "{error}");
        let count = query(&conn.pool, "SELECT COUNT(*) FROM people")
            .await
            .unwrap()
            .rows;
        assert_eq!(count, vec![vec![json!(3)]]);
        assert!(insert_records(&conn, &table, &[]).await.is_err());
        assert!(insert_records(
            &conn,
            &table,
            &[HashMap::from([("bogus".to_string(), None)])]
        )
        .await
        .is_err());
    }
    #[tokio::test]
    async fn staged_changes_apply_together_or_not_at_all() {
        let conn = setup().await;
        let table = table();
        let key = |tenant: &str, id: i64| {
            HashMap::from([
                ("tenant".to_string(), json!(tenant)),
                ("id".to_string(), json!(id)),
            ])
        };
        let changes = vec![
            Change::Update {
                key: key("a", 1),
                values: HashMap::from([("name".to_string(), Some("uno".to_string()))]),
            },
            Change::Delete { key: key("b", 1) },
            Change::Insert {
                values: HashMap::from([
                    ("tenant".to_string(), Some("c".to_string())),
                    ("id".to_string(), Some("9".to_string())),
                    ("name".to_string(), None),
                ]),
            },
        ];
        assert_eq!(apply_changes(&conn, &table, &changes).await.unwrap(), 3);
        let rows = query(
            &conn.pool,
            "SELECT tenant, id, name FROM sample ORDER BY tenant, id",
        )
        .await
        .unwrap()
        .rows;
        assert_eq!(
            rows,
            vec![
                vec![json!("a"), json!(1), json!("uno")],
                vec![json!("a"), json!(2), json!("three")],
                vec![json!("c"), json!(9), Value::Null],
            ]
        );
        // A stale key in the middle rolls back the edit before it.
        let stale = vec![
            Change::Update {
                key: key("a", 2),
                values: HashMap::from([("name".to_string(), Some("changed".to_string()))]),
            },
            Change::Delete { key: key("zz", 1) },
        ];
        let error = apply_changes(&conn, &table, &stale).await.unwrap_err();
        assert!(
            error.starts_with("Change 2 of 2 (delete tenant=\"zz\", id=1) matched 0 rows"),
            "{error}"
        );
        let name = query(
            &conn.pool,
            "SELECT name FROM sample WHERE tenant = 'a' AND id = 2",
        )
        .await
        .unwrap()
        .rows;
        assert_eq!(name, vec![vec![json!("three")]]);
        // NULL keys and unknown columns are rejected before anything runs.
        for values in [
            HashMap::from([("id".to_string(), None)]),
            HashMap::from([("bogus".to_string(), None)]),
        ] {
            assert!(apply_changes(
                &conn,
                &table,
                &[Change::Update {
                    key: key("a", 1),
                    values
                }]
            )
            .await
            .is_err());
        }
        assert!(apply_changes(&conn, &table, &[]).await.is_err());
    }
    #[test]
    fn key_lookups_leave_the_indexed_column_uncast() {
        let keys = vec!["tenant".to_string(), "id".to_string()];
        let types = HashMap::from([
            ("tenant".to_string(), "text".to_string()),
            ("id".to_string(), "integer".to_string()),
        ]);
        assert_eq!(
            key_conditions(&keys, &Driver::Postgres, &types, 2).unwrap(),
            "\"tenant\" = CAST($2 AS text) AND \"id\" = CAST($3 AS integer)"
        );
        assert_eq!(
            key_conditions(&keys, &Driver::Mysql, &types, 1).unwrap(),
            "`tenant` = ? AND `id` = ?"
        );
        assert!(key_conditions(&keys, &Driver::Postgres, &HashMap::new(), 1).is_err());
    }
    #[tokio::test]
    async fn sorted_pages_and_record_writes_validate_columns_and_keys() {
        let conn = setup().await;
        query(
            &conn.pool,
            "CREATE TABLE records (id INTEGER PRIMARY KEY, name TEXT, note TEXT)",
        )
        .await
        .unwrap();
        query(
            &conn.pool,
            "INSERT INTO records (name) VALUES ('Zed'), ('Amy'), ('Bob')",
        )
        .await
        .unwrap();
        let table = TableInfo {
            name: "records".into(),
            schema: "".into(),
            kind: "table".into(),
        };
        let sort = TableSort {
            column: "name".into(),
            direction: SortDirection::Desc,
        };
        let page = view_sorted_table_page(&conn, table.clone(), 2, 1, &[], Some(sort))
            .await
            .unwrap();
        assert_eq!(page.rows[0][1], json!("Bob"));
        assert_eq!(page.pagination.unwrap().total_rows, 3);
        assert!(view_sorted_table_page(
            &conn,
            table.clone(),
            1,
            1,
            &[],
            Some(TableSort {
                column: "missing".into(),
                direction: SortDirection::Asc
            })
        )
        .await
        .is_err());
        let key = HashMap::from([("id".to_string(), json!(3))]);
        assert_eq!(
            update_cell(&conn, &table, &key, "note", Some("reviewed".into()))
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            update_cell(&conn, &table, &key, "id", Some("99".into()))
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            insert_record(
                &conn,
                &table,
                &HashMap::from([
                    ("name".to_string(), Some("New".into())),
                    ("note".to_string(), None)
                ])
            )
            .await
            .unwrap(),
            1
        );
        assert!(insert_record(
            &conn,
            &table,
            &HashMap::from([("bad".to_string(), Some("x".into()))])
        )
        .await
        .is_err());
        let result = query(
            &conn.pool,
            "SELECT name, note FROM records WHERE id IN (99,100) ORDER BY id",
        )
        .await
        .unwrap();
        assert_eq!(
            result.rows,
            vec![
                vec![json!("Bob"), json!("reviewed")],
                vec![json!("New"), Value::Null]
            ]
        );
    }
    #[tokio::test]
    async fn primary_key_edits_preserve_original_identity_and_roll_back_conflicts() {
        let conn = setup().await;
        let table = table();
        let update = |tenant: &str, id: i64, entries: &[(&str, &str)]| Change::Update {
            key: key(tenant, id),
            values: entries
                .iter()
                .map(|(k, v)| (k.to_string(), Some(v.to_string())))
                .collect(),
        };
        apply_changes(
            &conn,
            &table,
            &[update(
                "a",
                1,
                &[("tenant", "new"), ("id", "7"), ("name", "renamed")],
            )],
        )
        .await
        .unwrap();
        assert_eq!(
            query(
                &conn.pool,
                "SELECT name FROM sample WHERE tenant='new' AND id=7"
            )
            .await
            .unwrap()
            .rows,
            vec![vec![json!("renamed")]]
        );
        update_cell(&conn, &table, &key("new", 7), "name", Some("again".into()))
            .await
            .unwrap();
        // A duplicate destination fails atomically, including ordinary edits preceding it.
        assert!(apply_changes(
            &conn,
            &table,
            &[
                update("new", 7, &[("name", "must roll back")]),
                update("b", 1, &[("tenant", "a"), ("id", "2")]),
            ]
        )
        .await
        .is_err());
        assert_eq!(
            query(
                &conn.pool,
                "SELECT name FROM sample WHERE tenant='new' AND id=7"
            )
            .await
            .unwrap()
            .rows,
            vec![vec![json!("again")]]
        );
        // Duplicate targeting is rejected before a changed key can identify another record.
        assert!(apply_changes(
            &conn,
            &table,
            &[
                update("new", 7, &[("id", "8")]),
                Change::Delete { key: key("new", 7) },
            ]
        )
        .await
        .is_err());
        assert!(apply_changes(
            &conn,
            &table,
            &[Change::Update {
                key: key("new", 7),
                values: HashMap::from([("tenant".into(), None)])
            }]
        )
        .await
        .is_err());
        delete_rows(&conn, &table, &[key("new", 7)]).await.unwrap();
        assert!(query(&conn.pool, "SELECT * FROM sample WHERE tenant='new'")
            .await
            .unwrap()
            .rows
            .is_empty());
    }

    #[tokio::test]
    async fn primary_key_edits_respect_foreign_keys() {
        let conn = setup().await;
        raw_pool_query(&conn.pool, "PRAGMA foreign_keys=ON; CREATE TABLE parent_keys (id INTEGER PRIMARY KEY); INSERT INTO parent_keys VALUES(1); CREATE TABLE child_cascade (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent_keys(id) ON UPDATE CASCADE); INSERT INTO child_cascade VALUES(1,1);").await.unwrap();
        let table = TableInfo {
            name: "parent_keys".into(),
            schema: "".into(),
            kind: "table".into(),
        };
        update_cell(
            &conn,
            &table,
            &HashMap::from([("id".into(), json!(1))]),
            "id",
            Some("2".into()),
        )
        .await
        .unwrap();
        assert_eq!(
            query(&conn.pool, "SELECT parent_id FROM child_cascade")
                .await
                .unwrap()
                .rows,
            vec![vec![json!(2)]]
        );
        raw_pool_query(&conn.pool, "CREATE TABLE child_restrict (parent_id INTEGER REFERENCES parent_keys(id) ON UPDATE RESTRICT); INSERT INTO child_restrict VALUES(2);").await.unwrap();
        assert!(update_cell(
            &conn,
            &table,
            &HashMap::from([("id".into(), json!(2))]),
            "id",
            Some("3".into())
        )
        .await
        .is_err());
        assert_eq!(
            query(&conn.pool, "SELECT id FROM parent_keys")
                .await
                .unwrap()
                .rows,
            vec![vec![json!(2)]]
        );
        assert_eq!(
            query(&conn.pool, "SELECT parent_id FROM child_cascade")
                .await
                .unwrap()
                .rows,
            vec![vec![json!(2)]]
        );
    }

    #[tokio::test]
    async fn underestimated_counts_do_not_hide_later_pages() {
        let conn = setup().await;
        query(
            &conn.pool,
            "CREATE TABLE estimated_data (id INTEGER PRIMARY KEY)",
        )
        .await
        .unwrap();
        query(&conn.pool, "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 1205) INSERT INTO estimated_data SELECT x FROM n").await.unwrap();
        let table = TableInfo {
            name: "estimated_data".into(),
            schema: "".into(),
            kind: "table".into(),
        };
        let first = view_table_page_with_estimate(
            &conn,
            table.clone(),
            1,
            1000,
            TableReadOptions {
                estimate_override: Some(1000),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(first.rows.len(), 1000);
        assert_eq!(first.pagination.unwrap().has_next, Some(true));
        let second = view_table_page_with_estimate(
            &conn,
            table,
            2,
            1000,
            TableReadOptions {
                estimate_override: Some(1000),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert_eq!(second.rows.len(), 205);
        assert_eq!(second.rows[0][0], json!(1001));
        let pagination = second.pagination.unwrap();
        assert_eq!(pagination.page, 2);
        assert_eq!(pagination.has_next, Some(false));
        assert_eq!(pagination.total_rows, 1205);
    }
    #[tokio::test]
    async fn or_filters_apply_to_count_paging_and_preserve_connectors() {
        let conn = setup().await;
        query(
            &conn.pool,
            "CREATE TABLE or_test (id INTEGER PRIMARY KEY, name TEXT)",
        )
        .await
        .unwrap();
        query(
            &conn.pool,
            "INSERT INTO or_test VALUES (1, 'alpha'), (2, 'beta'), (3, 'gamma')",
        )
        .await
        .unwrap();
        let filters: Vec<TableFilter> = serde_json::from_value(json!([
            {"column":"name", "operator":"equals", "value":"alpha"},
            {"join":"or", "column":"name", "operator":"equals", "value":"gamma"}
        ]))
        .unwrap();
        let result = view_filtered_table_page(
            &conn,
            TableInfo {
                name: "or_test".into(),
                schema: "".into(),
                kind: "table".into(),
            },
            2,
            1,
            &filters,
        )
        .await
        .unwrap();
        assert_eq!(result.rows, vec![vec![json!(3), json!("gamma")]]);
        assert_eq!(result.pagination.unwrap().total_rows, 2);
        assert_eq!(serde_json::to_value(&filters).unwrap()[1]["join"], "or");
        assert!(serde_json::from_value::<TableFilter>(
            json!({"join":"OR 1=1", "column":"name", "operator":"equals", "value":"alpha"})
        )
        .is_err());
    }
    #[tokio::test]
    async fn filters_apply_before_count_and_paging_and_bind_untrusted_values() {
        let conn = setup().await;
        query(
            &conn.pool,
            "CREATE TABLE filter_test (id INTEGER PRIMARY KEY, name TEXT, status TEXT)",
        )
        .await
        .unwrap();
        query(&conn.pool, "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 1205) INSERT INTO filter_test SELECT n, 'row ' || n, CASE WHEN n > 1000 THEN 'target' ELSE 'other' END FROM seq").await.unwrap();
        let table = TableInfo {
            name: "filter_test".into(),
            schema: "".into(),
            kind: "table".into(),
        };
        let filter = |column: &str, operator, value: &str| TableFilter {
            join: FilterJoin::And,
            column: column.into(),
            operator,
            value: value.into(),
        };
        let page = view_filtered_table_page(
            &conn,
            table.clone(),
            2,
            100,
            &[filter("status", FilterOperator::Equals, "target")],
        )
        .await
        .unwrap();
        assert_eq!(page.pagination.unwrap().total_rows, 205);
        assert_eq!(page.rows[0][0], json!(1101));
        query(
            &conn.pool,
            "INSERT INTO filter_test VALUES (1300, '100%_done!', NULL)",
        )
        .await
        .unwrap();
        let literal = view_filtered_table_page(
            &conn,
            table.clone(),
            1,
            1000,
            &[
                filter("name", FilterOperator::Contains, "%_"),
                filter("status", FilterOperator::IsNull, ""),
            ],
        )
        .await
        .unwrap();
        assert_eq!(literal.rows.len(), 1);
        assert_eq!(literal.rows[0][0], json!(1300));
        let injected = view_filtered_table_page(
            &conn,
            table.clone(),
            1,
            1000,
            &[filter(
                "status",
                FilterOperator::Equals,
                "target' OR 1=1 --",
            )],
        )
        .await
        .unwrap();
        assert!(injected.rows.is_empty());
        assert!(view_filtered_table_page(
            &conn,
            table,
            1,
            1000,
            &[filter("bad_column", FilterOperator::Equals, "x")]
        )
        .await
        .is_err());
    }
    #[tokio::test]
    async fn paging_fetches_beyond_one_thousand_and_clamps_last_page() {
        let conn = setup().await;
        query(
            &conn.pool,
            "CREATE TABLE paged (id INTEGER PRIMARY KEY, label TEXT)",
        )
        .await
        .unwrap();
        query(&conn.pool, "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 1505) INSERT INTO paged SELECT n, 'row' FROM seq").await.unwrap();
        let table = TableInfo {
            name: "paged".into(),
            schema: "".into(),
            kind: "table".into(),
        };
        let first = view_table_page(&conn, table.clone(), 1, 1000)
            .await
            .unwrap();
        assert_eq!(first.rows.len(), 1000);
        assert_eq!(first.pagination.unwrap().total_rows, 1505);
        let next = view_table_page(&conn, table.clone(), 2, 1000)
            .await
            .unwrap();
        assert_eq!(next.rows.len(), 505);
        assert_eq!(next.rows[0][0], json!(1001));
        assert_eq!(next.rows[504][0], json!(1505));
        let resized = view_table_page(&conn, table.clone(), 3, 500).await.unwrap();
        assert_eq!(resized.rows.len(), 500);
        assert_eq!(resized.rows[0][0], json!(1001));
        let clamped = view_table_page(&conn, table.clone(), 99, 500)
            .await
            .unwrap();
        assert_eq!(clamped.pagination.unwrap().page, 4);
        assert_eq!(clamped.rows.len(), 5);
        for (page, size) in [(0, 1000), (1, 0), (1, 5001)] {
            assert!(view_table_page(&conn, table.clone(), page, size)
                .await
                .is_err());
        }
    }
    #[tokio::test]
    async fn paging_uses_complete_primary_key_order_and_handles_deletions() {
        let conn = setup().await;
        let middle = view_table_page(&conn, table(), 2, 1).await.unwrap();
        assert_eq!(middle.rows[0][0], json!("a"));
        assert_eq!(middle.rows[0][1], json!(2));
        delete_rows(&conn, &table(), &[key("b", 1)]).await.unwrap();
        let last = view_table_page(&conn, table(), 3, 1).await.unwrap();
        assert_eq!(last.pagination.as_ref().unwrap().page, 2);
        assert_eq!(last.pagination.unwrap().total_rows, 2);
        delete_rows(&conn, &table(), &[key("a", 1), key("a", 2)])
            .await
            .unwrap();
        let empty = view_table_page(&conn, table(), 5, 1000).await.unwrap();
        assert_eq!(empty.pagination.as_ref().unwrap().page, 1);
        assert_eq!(empty.pagination.unwrap().total_rows, 0);
        assert!(empty.rows.is_empty());
        assert_eq!(empty.columns.len(), 3);
    }
    pub(super) async fn setup() -> Connection {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let conn = Connection {
            tunnel: None,
            pool: Pool::Lite(pool),
            config: super::super::tests::config(Driver::Sqlite),
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        };
        query(
            &conn.pool,
            "CREATE TABLE sample (tenant TEXT, id INTEGER, name TEXT, PRIMARY KEY (tenant, id))",
        )
        .await
        .unwrap();
        query(
            &conn.pool,
            "INSERT INTO sample VALUES ('a', 1, 'one'), ('b', 1, 'two'), ('a', 2, 'three')",
        )
        .await
        .unwrap();
        conn
    }
    fn table() -> TableInfo {
        TableInfo {
            name: "sample".into(),
            schema: "".into(),
            kind: "table".into(),
        }
    }
    fn key(tenant: &str, id: i64) -> HashMap<String, Value> {
        HashMap::from([("tenant".into(), json!(tenant)), ("id".into(), json!(id))])
    }
    #[tokio::test]
    async fn deletion_uses_complete_composite_keys() {
        let conn = setup().await;
        let view = view_table(&conn, table()).await.unwrap();
        assert_eq!(view.source.unwrap().primary_keys, vec!["tenant", "id"]);
        assert_eq!(
            delete_rows(&conn, &table(), &[key("a", 1)]).await.unwrap(),
            1
        );
        let remaining = query(
            &conn.pool,
            "SELECT tenant, id FROM sample ORDER BY tenant, id",
        )
        .await
        .unwrap();
        assert_eq!(
            remaining.rows,
            vec![vec![json!("a"), json!(2)], vec![json!("b"), json!(1)]]
        );
    }
    #[tokio::test]
    async fn stale_or_invalid_selections_do_not_partially_delete() {
        let conn = setup().await;
        assert!(
            delete_rows(&conn, &table(), &[key("a", 1), key("missing", 4)])
                .await
                .is_err()
        );
        assert!(
            delete_rows(&conn, &table(), &[HashMap::from([("id".into(), json!(1))])])
                .await
                .is_err()
        );
        assert!(delete_rows(&conn, &table(), &[key("a", 1), key("a", 1)])
            .await
            .is_err());
        assert_eq!(
            query(&conn.pool, "SELECT COUNT(*) FROM sample")
                .await
                .unwrap()
                .rows,
            vec![vec![json!(3)]]
        );
    }
    #[tokio::test]
    async fn injection_and_missing_primary_key_are_rejected() {
        let conn = setup().await;
        assert!(delete_rows(&conn, &table(), &[key("a' OR 1=1 --", 1)])
            .await
            .is_err());
        query(&conn.pool, "CREATE TABLE no_key (id INTEGER)")
            .await
            .unwrap();
        let no_key = TableInfo {
            name: "no_key".into(),
            schema: "".into(),
            kind: "table".into(),
        };
        assert!(
            delete_rows(&conn, &no_key, &[HashMap::from([("id".into(), json!(1))])])
                .await
                .is_err()
        );
        assert_eq!(
            query(&conn.pool, "SELECT COUNT(*) FROM sample")
                .await
                .unwrap()
                .rows,
            vec![vec![json!(3)]]
        );
    }
    #[tokio::test]
    async fn statement_errors_roll_back_prior_deletions() {
        let conn = setup().await;
        query(&conn.pool, "PRAGMA foreign_keys = ON").await.unwrap();
        query(&conn.pool, "CREATE TABLE child (tenant TEXT, id INTEGER, FOREIGN KEY (tenant, id) REFERENCES sample (tenant, id))").await.unwrap();
        query(&conn.pool, "INSERT INTO child VALUES ('b', 1)")
            .await
            .unwrap();
        assert!(delete_rows(&conn, &table(), &[key("a", 2), key("b", 1)])
            .await
            .is_err());
        assert_eq!(
            query(&conn.pool, "SELECT COUNT(*) FROM sample")
                .await
                .unwrap()
                .rows,
            vec![vec![json!(3)]]
        );
    }
    #[tokio::test]
    async fn quoted_identifiers_are_handled_as_identifiers() {
        let conn = setup().await;
        query(
            &conn.pool,
            "CREATE TABLE \"odd\"\"table\" (\"odd\"\"key\" TEXT PRIMARY KEY)",
        )
        .await
        .unwrap();
        query(&conn.pool, "INSERT INTO \"odd\"\"table\" VALUES ('one')")
            .await
            .unwrap();
        let odd = TableInfo {
            name: "odd\"table".into(),
            schema: "".into(),
            kind: "table".into(),
        };
        let view = view_table(&conn, odd.clone()).await.unwrap();
        assert_eq!(view.source.unwrap().primary_keys, vec!["odd\"key"]);
        assert_eq!(
            delete_rows(
                &conn,
                &odd,
                &[HashMap::from([("odd\"key".into(), json!("one"))])]
            )
            .await
            .unwrap(),
            1
        );
        assert!(view_table(&conn, odd).await.unwrap().rows.is_empty());
    }
}

#[tauri::command]
pub(crate) async fn dbde_load_record(
    connection_id: String,
    database: String,
    table: TableInfo,
    key: HashMap<String, Value>,
    state: State<'_, AppState>,
) -> DbResult<Vec<Value>> {
    timed(async {
        let conn = database_connection(&state, &connection_id, Some(&database)).await?;
        load_record(&conn, &table, &key).await
    })
    .await
}

async fn load_record(
    conn: &Connection,
    table: &TableInfo,
    key: &HashMap<String, Value>,
) -> DbResult<Vec<Value>> {
    let keys = primary_keys(conn, table).await?;
    checked_key_values(&keys, key)?;
    let types = pg_column_types(conn, table).await?;
    let conditions = key_conditions(&keys, &conn.config.driver, &types, 1)?;
    let sql = format!(
        "SELECT * FROM {} WHERE {conditions} LIMIT 1",
        qualified(table, &conn.config.driver)
    );
    let params = keys
        .iter()
        .map(|name| key_bind(&key[name], &conn.config.driver))
        .collect::<DbResult<Vec<_>>>()?;
    macro_rules! read_record {
        ($pool:expr, $decode:ident) => {{
            let row = bind_all!(sqlx::query(&sql), &params)
                .fetch_optional($pool)
                .await
                .map_err(err)?
                .ok_or("This record no longer exists. Refresh the table.")?;
            (0..row.len())
                .map(|i| $decode(&row, i))
                .collect::<DbResult<Vec<_>>>()
        }};
    }
    match &conn.pool {
        Pool::Pg(p) => read_record!(p, pg_cell),
        Pool::My(p) => read_record!(p, my_cell),
        Pool::Lite(p) => read_record!(p, lite_cell),
    }
}

// Raw Mode deliberately accepts a small set of zero-argument server functions.
// Values and primary keys never become SQL fragments; the complete key is bound.
fn checked_raw_expression(value: &str, driver: &Driver) -> DbResult<String> {
    let expression = value.trim().to_ascii_uppercase();
    let common = ["CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME"];
    let allowed = common.contains(&expression.as_str())
        || match driver {
            Driver::Mysql => ["NOW()", "UUID()"].contains(&expression.as_str()),
            Driver::Postgres => {
                ["NOW()", "GEN_RANDOM_UUID()", "RANDOM()"].contains(&expression.as_str())
            }
            Driver::Sqlite => expression == "RANDOM()",
        };
    if !allowed {
        return Err(
            "Unsupported Raw Mode expression. Use a supported zero-argument function.".into(),
        );
    }
    Ok(expression)
}
async fn raw_cell(
    conn: &Connection,
    table: &TableInfo,
    key: &HashMap<String, Value>,
    column: &str,
    expression: &str,
) -> DbResult<u64> {
    check_write_target(table)?;
    let expression = checked_raw_expression(expression, &conn.config.driver)?;
    let keys = primary_keys(conn, table).await?;
    checked_key_values(&keys, key)?;
    let target = qualified(table, &conn.config.driver);
    let columns = query(&conn.pool, &format!("SELECT * FROM {target} LIMIT 0"))
        .await?
        .columns;
    if !columns.iter().any(|name| name == column) || keys.iter().any(|name| name == column) {
        return Err("This column cannot be edited".into());
    }
    let types = pg_column_types(conn, table).await?;
    let conditions = key_conditions(&keys, &conn.config.driver, &types, 1)?;
    let sql = format!(
        "UPDATE {target} SET {} = {expression} WHERE {conditions}",
        quote(column, &conn.config.driver)
    );
    let values = keys
        .iter()
        .map(|name| key_bind(&key[name], &conn.config.driver))
        .collect::<DbResult<Vec<_>>>()?;
    macro_rules! apply {
        ($pool:expr) => {{
            let mut tx = $pool.begin().await.map_err(err)?;
            let changed = bind_all!(sqlx::query(&sql), &values)
                .execute(&mut *tx)
                .await
                .map_err(err)?
                .rows_affected();
            if changed != 1 {
                return Err(
                    "The record changed or no longer exists. Refresh and try again.".into(),
                );
            }
            tx.commit().await.map_err(err)?;
            changed
        }};
    }
    Ok(match &conn.pool {
        Pool::Pg(p) => apply!(p),
        Pool::My(p) => apply!(p),
        Pool::Lite(p) => apply!(p),
    })
}
#[tauri::command]
pub(crate) async fn dbde_raw_cell(
    connection_id: String,
    database: String,
    table: TableInfo,
    key: HashMap<String, Value>,
    column: String,
    expression: String,
    state: State<'_, AppState>,
) -> DbResult<u64> {
    timed(async {
        let conn = database_connection(&state, &connection_id, Some(&database)).await?;
        raw_cell(&conn, &table, &key, &column, &expression).await
    })
    .await
}
#[cfg(test)]
mod raw_mode_tests {
    use super::*;
    #[test]
    fn raw_mode_rejects_sql_fragments() {
        assert_eq!(
            checked_raw_expression(" now() ", &Driver::Mysql).unwrap(),
            "NOW()"
        );
        for value in [
            "NOW(); DELETE FROM t",
            "sleep(10)",
            "(SELECT password FROM users)",
            "UUID() --",
            "CURRENT_TIMESTAMP()",
        ] {
            assert!(checked_raw_expression(value, &Driver::Mysql).is_err());
        }
        assert!(checked_raw_expression("UUID()", &Driver::Postgres).is_err());
    }
    #[tokio::test]
    async fn raw_mode_binds_complete_key_and_never_updates_primary_key() {
        let conn = super::tests::setup().await;
        query(
            &conn.pool,
            "CREATE TABLE raw_records (id INTEGER PRIMARY KEY, value TEXT)",
        )
        .await
        .unwrap();
        query(
            &conn.pool,
            "INSERT INTO raw_records VALUES (1, 'old'), (2, 'keep')",
        )
        .await
        .unwrap();
        let table = TableInfo {
            name: "raw_records".into(),
            schema: "".into(),
            kind: "table".into(),
        };
        let key = HashMap::from([("id".into(), json!(1))]);
        assert_eq!(
            raw_cell(&conn, &table, &key, "value", "CURRENT_TIMESTAMP")
                .await
                .unwrap(),
            1
        );
        assert!(raw_cell(&conn, &table, &key, "id", "RANDOM()")
            .await
            .is_err());
        assert!(
            raw_cell(&conn, &table, &HashMap::new(), "value", "CURRENT_TIMESTAMP")
                .await
                .is_err()
        );
        let result = query(&conn.pool, "SELECT value FROM raw_records WHERE id=2")
            .await
            .unwrap();
        assert_eq!(result.rows[0][0], json!("keep"));
    }
}
