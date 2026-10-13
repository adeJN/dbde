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
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct TableFilter {
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
fn filter_clause(
    filters: &[TableFilter],
    driver: &Driver,
    columns: &[String],
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
                values.push(value);
                let placeholder = if matches!(driver, Driver::Postgres) {
                    format!("${}", values.len())
                } else {
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
            format!(" WHERE {}", conditions.join(" AND "))
        },
        values,
    ))
}

#[derive(Serialize)]
pub(crate) struct TablePagination {
    page: u64,
    page_size: u32,
    total_rows: u64,
}

#[derive(Clone, Serialize)]
pub(crate) struct TableSource {
    #[serde(skip_serializing_if = "Vec::is_empty")]
    filters: Vec<TableFilter>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sort: Option<TableSort>,
    table: TableInfo,
    database: String,
    primary_keys: Vec<String>,
}
fn quote(value: &str, driver: &Driver) -> String {
    let q = if matches!(driver, Driver::Mysql) {
        '`'
    } else {
        '"'
    };
    format!("{q}{}{q}", value.replace(q, &format!("{q}{q}")))
}
fn qualified(table: &TableInfo, driver: &Driver) -> String {
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
async fn primary_keys(conn: &Connection, table: &TableInfo) -> DbResult<Vec<String>> {
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
async fn view_sorted_table_page(
    conn: &Connection,
    table: TableInfo,
    requested_page: u64,
    page_size: u32,
    filters: &[TableFilter],
    sort: Option<TableSort>,
) -> DbResult<QueryResult> {
    if requested_page == 0
        || requested_page > 9_007_199_254_740_991
        || page_size == 0
        || page_size > 5000
    {
        return Err("Page must be positive and page size must be between 1 and 5,000".into());
    }
    let keys = primary_keys(conn, &table).await?;
    let target = qualified(&table, &conn.config.driver);
    let columns = if filters.is_empty() && sort.is_none() {
        Vec::new()
    } else {
        query(&conn.pool, &format!("SELECT * FROM {target} LIMIT 0"))
            .await?
            .columns
    };
    if sort
        .as_ref()
        .is_some_and(|item| !columns.contains(&item.column))
    {
        return Err("Unknown sort column".into());
    }
    let (where_sql, values) = filter_clause(filters, &conn.config.driver, &columns)?;
    let count = query_with_params(
        &conn.pool,
        &format!("SELECT COUNT(*) FROM {target}{where_sql}"),
        &values,
    )
    .await?;
    let total_rows = count
        .rows
        .first()
        .and_then(|row| row.first())
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
        })
        .ok_or_else(|| "Cannot read the table row count".to_string())?;
    let total_pages = total_rows.div_ceil(u64::from(page_size)).max(1);
    let page = requested_page.min(total_pages);
    let offset = (page - 1)
        .checked_mul(u64::from(page_size))
        .ok_or_else(|| "Page offset is too large".to_string())?;
    let mut order_columns = Vec::new();
    if let Some(item) = &sort {
        let direction = match item.direction {
            SortDirection::Asc => "ASC",
            SortDirection::Desc => "DESC",
        };
        order_columns.push(format!(
            "{} {direction}",
            quote(&item.column, &conn.config.driver)
        ));
    }
    order_columns.extend(
        keys.iter()
            .filter(|key| sort.as_ref().is_none_or(|item| item.column != **key))
            .map(|key| quote(key, &conn.config.driver)),
    );
    let order = if order_columns.is_empty() {
        String::new()
    } else {
        format!(" ORDER BY {}", order_columns.join(", "))
    };
    let mut result = query_with_params(
        &conn.pool,
        &format!("SELECT * FROM {target}{where_sql}{order} LIMIT {page_size} OFFSET {offset}"),
        &values,
    )
    .await?;
    result.pagination = Some(TablePagination {
        page,
        page_size,
        total_rows,
    });
    result.source = Some(TableSource {
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
pub(crate) async fn dbde_view_table(
    connection_id: String,
    database: String,
    table: TableInfo,
    page: Option<u64>,
    page_size: Option<u32>,
    filters: Option<Vec<TableFilter>>,
    sort: Option<TableSort>,
    state: State<'_, AppState>,
) -> DbResult<QueryResult> {
    timed(async {
        let conn = database_connection(&state, &connection_id, Some(&database)).await?;
        let filters = filters.unwrap_or_default();
        view_sorted_table_page(
            &conn,
            table,
            page.unwrap_or(1),
            page_size.unwrap_or(1000),
            &filters,
            sort,
        )
        .await
    })
    .await
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
            let mut statement = sqlx::query($sql);
            for value in values { statement = statement.bind(value); }
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
    let values: Vec<Vec<String>> = rows
        .iter()
        .map(|row| {
            if row.len() != keys.len() {
                return Err("The complete primary key is required".into());
            }
            keys.iter()
                .map(|key| {
                    row.get(key)
                        .ok_or_else(|| "Primary key column is missing".to_string())
                        .and_then(key_value)
                })
                .collect()
        })
        .collect::<DbResult<_>>()?;
    let mut seen = std::collections::HashSet::new();
    if values.iter().any(|key| !seen.insert(key.clone())) {
        return Err("Duplicate primary keys in selection".into());
    }
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
        let mut statement = sqlx::query($sql);
        for value in $values {
            statement = statement.bind(value);
        }
        statement.execute($pool).await.map_err(err)?.rows_affected()
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
    let key_values = checked_key_values(&keys, key)?;
    let target = qualified(table, &conn.config.driver);
    let columns = query(&conn.pool, &format!("SELECT * FROM {target} LIMIT 0"))
        .await?
        .columns;
    if !columns.iter().any(|name| name == column) || keys.iter().any(|name| name == column) {
        return Err("This column cannot be edited".into());
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
    let mut values = vec![value];
    values.extend(key_values.into_iter().map(Some));
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
async fn insert_record(
    conn: &Connection,
    table: &TableInfo,
    values: &HashMap<String, Option<String>>,
) -> DbResult<u64> {
    check_write_target(table)?;
    if values.len() > 256
        || values
            .values()
            .any(|value| value.as_ref().is_some_and(|text| text.len() > 1_000_000))
    {
        return Err("Too many columns or a value exceeds 1 MB".into());
    }
    let target = qualified(table, &conn.config.driver);
    let columns = query(&conn.pool, &format!("SELECT * FROM {target} LIMIT 0"))
        .await?
        .columns;
    if values.keys().any(|key| !columns.contains(key)) {
        return Err("Unknown insert column".into());
    }
    let selected = columns
        .iter()
        .filter(|name| values.contains_key(*name))
        .collect::<Vec<_>>();
    let types = pg_column_types(conn, table).await?;
    let sql = if selected.is_empty() {
        if matches!(conn.config.driver, Driver::Mysql) {
            format!("INSERT INTO {target} () VALUES ()")
        } else {
            format!("INSERT INTO {target} DEFAULT VALUES")
        }
    } else {
        let names = selected
            .iter()
            .map(|name| quote(name, &conn.config.driver))
            .collect::<Vec<_>>()
            .join(", ");
        let placeholders = selected
            .iter()
            .enumerate()
            .map(|(index, name)| {
                if matches!(conn.config.driver, Driver::Postgres) {
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
        .map(|name| values.get(*name).cloned().unwrap())
        .collect::<Vec<_>>();
    let inserted = match &conn.pool {
        Pool::Pg(p) => write_statement!(p, &sql, params),
        Pool::My(p) => write_statement!(p, &sql, params),
        Pool::Lite(p) => write_statement!(p, &sql, params),
    };
    if inserted != 1 {
        return Err("The record was not inserted".into());
    }
    Ok(inserted)
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

#[cfg(test)]
pub(crate) mod tests_support {
    use super::*;
    pub(crate) async fn view(conn: &Connection, table: TableInfo) -> Vec<Vec<Value>> {
        view_table(conn, table).await.unwrap().rows
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
        assert!(update_cell(&conn, &table, &key, "id", Some("99".into()))
            .await
            .is_err());
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
            "SELECT name, note FROM records WHERE id IN (3,4) ORDER BY id",
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
    async fn setup() -> Connection {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let conn = Connection {
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
