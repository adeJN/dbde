// Column details for the data editors: allowed ENUM/SET values, boolean columns and the
// foreign keys a table's columns take part in.
use super::*;

/// Reads `enum('a','b')` / `set('a','b')` as MySQL and MariaDB render COLUMN_TYPE.
/// Values are single-quoted with `''` or backslash escapes for quotes and backslashes;
/// commas and any Unicode text may appear inside the quotes. Returns `(is_set, values)`,
/// or `None` for any other type or text that is not a complete value list.
pub(crate) fn mysql_choices(column_type: &str) -> Option<(bool, Vec<String>)> {
    let text = column_type.trim();
    let open = text.find('(')?;
    let is_set = match text[..open].trim().to_ascii_lowercase().as_str() {
        "enum" => false,
        "set" => true,
        _ => return None,
    };
    let mut chars = text[open + 1..].chars().peekable();
    let mut values = Vec::new();
    let skip_space = |chars: &mut std::iter::Peekable<std::str::Chars>| {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
    };
    loop {
        skip_space(&mut chars);
        if chars.next()? != '\'' {
            return None;
        }
        let mut value = String::new();
        loop {
            match chars.next()? {
                '\'' if chars.peek() == Some(&'\'') => {
                    chars.next();
                    value.push('\'');
                }
                '\'' => break,
                '\\' => value.push(match chars.next()? {
                    'n' => '\n',
                    't' => '\t',
                    'r' => '\r',
                    '0' => '\0',
                    'Z' => '\u{1a}',
                    other => other,
                }),
                other => value.push(other),
            }
        }
        values.push(value);
        skip_space(&mut chars);
        match chars.next()? {
            ',' => continue,
            ')' => break,
            _ => return None,
        }
    }
    // Nothing but whitespace may follow the closing parenthesis.
    chars.all(char::is_whitespace).then_some((is_set, values))
}
/// MySQL/MariaDB BOOL and BOOLEAN are stored as `tinyint(1)`.
pub(crate) fn mysql_is_boolean(column_type: &str) -> bool {
    let lower = column_type.trim().to_ascii_lowercase();
    lower == "tinyint(1)" || lower == "tinyint(1) unsigned"
}
fn sqlite_is_boolean(declared: &str) -> bool {
    matches!(
        declared.trim().to_ascii_lowercase().as_str(),
        "bool" | "boolean"
    )
}
fn mysql_column(name: String, column_type: String, nullable: bool) -> ColumnInfo {
    let (enum_values, set_values) = match mysql_choices(&column_type) {
        Some((false, values)) => (Some(values), None),
        Some((true, values)) => (None, Some(values)),
        None => (None, None),
    };
    ColumnInfo {
        is_boolean: mysql_is_boolean(&column_type),
        name,
        data_type: column_type,
        nullable,
        enum_values,
        set_values,
    }
}
pub(crate) async fn table_columns(pool: &Pool, table: &TableInfo) -> DbResult<Vec<ColumnInfo>> {
    match pool {
        Pool::Pg(p) => {
            // PostgreSQL enum labels in their declared order (enumsortorder, which ALTER
            // TYPE ... ADD VALUE BEFORE/AFTER keeps meaningful).
            let rows = sqlx::query("SELECT c.column_name, pg_catalog.format_type(a.atttypid, a.atttypmod), c.is_nullable, CASE WHEN ty.typtype = 'e' THEN ARRAY(SELECT e.enumlabel::text FROM pg_catalog.pg_enum e WHERE e.enumtypid = ty.oid ORDER BY e.enumsortorder) END, a.atttypid = 'pg_catalog.bool'::regtype::oid FROM information_schema.columns c JOIN pg_catalog.pg_namespace n ON n.nspname = c.table_schema JOIN pg_catalog.pg_class t ON t.relnamespace = n.oid AND t.relname = c.table_name JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attname = c.column_name JOIN pg_catalog.pg_type ty ON ty.oid = a.atttypid WHERE c.table_schema = $1 AND c.table_name = $2 ORDER BY c.ordinal_position")
                .bind(&table.schema).bind(&table.name).fetch_all(p).await.map_err(err)?;
            // information_schema.columns omits materialized views; read their columns from the catalog.
            let rows = if rows.is_empty() {
                sqlx::query("SELECT a.attname::text, pg_catalog.format_type(a.atttypid, a.atttypmod), CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END, CASE WHEN ty.typtype = 'e' THEN ARRAY(SELECT e.enumlabel::text FROM pg_catalog.pg_enum e WHERE e.enumtypid = ty.oid ORDER BY e.enumsortorder) END, a.atttypid = 'pg_catalog.bool'::regtype::oid FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class t ON t.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace JOIN pg_catalog.pg_type ty ON ty.oid = a.atttypid WHERE t.relkind = 'm' AND n.nspname = $1 AND t.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped AND pg_catalog.has_table_privilege(t.oid, 'SELECT') ORDER BY a.attnum")
                    .bind(&table.schema).bind(&table.name).fetch_all(p).await.map_err(err)?
            } else {
                rows
            };
            rows.iter()
                .map(|r| {
                    Ok(ColumnInfo {
                        name: r.try_get(0).map_err(err)?,
                        data_type: r.try_get(1).map_err(err)?,
                        nullable: r.try_get::<String, _>(2).map_err(err)? == "YES",
                        enum_values: r.try_get(3).map_err(err)?,
                        set_values: None,
                        is_boolean: r.try_get(4).map_err(err)?,
                    })
                })
                .collect()
        }
        Pool::My(p) => {
            let rows = sqlx::query("SELECT column_name, column_type, is_nullable FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position")
                .bind(&table.schema).bind(&table.name).fetch_all(p).await.map_err(err)?;
            rows.iter()
                .map(|r| {
                    Ok(mysql_column(
                        r.try_get(0).map_err(err)?,
                        r.try_get(1).map_err(err)?,
                        r.try_get::<String, _>(2).map_err(err)? == "YES",
                    ))
                })
                .collect()
        }
        Pool::Lite(p) => {
            let rows = sqlx::query("SELECT name, type, \"notnull\" FROM pragma_table_info(?)")
                .bind(&table.name)
                .fetch_all(p)
                .await
                .map_err(err)?;
            rows.iter()
                .map(|r| {
                    let data_type: String = r.try_get(1).map_err(err)?;
                    Ok(ColumnInfo {
                        name: r.try_get(0).map_err(err)?,
                        is_boolean: sqlite_is_boolean(&data_type),
                        data_type,
                        nullable: r.try_get::<i64, _>(2).map_err(err)? == 0,
                        enum_values: None,
                        set_values: None,
                    })
                })
                .collect()
        }
    }
}

/// One foreign key: `columns[i]` references `referenced_columns[i]`.
#[derive(Serialize)]
pub(crate) struct ForeignKeyInfo {
    name: String,
    columns: Vec<String>,
    referenced_table: TableInfo,
    referenced_columns: Vec<String>,
}
fn check_table(table: &TableInfo) -> DbResult<()> {
    if table.name.is_empty() || table.name.len() > 1024 || table.schema.len() > 1024 {
        return Err("Invalid table name".into());
    }
    Ok(())
}
pub(crate) async fn foreign_keys(pool: &Pool, table: &TableInfo) -> DbResult<Vec<ForeignKeyInfo>> {
    check_table(table)?;
    let referenced = |schema: String, name: String| TableInfo {
        name,
        schema,
        kind: "table".into(),
    };
    match pool {
        Pool::Pg(p) => {
            // conkey/confkey are parallel arrays; unnest them together to keep the pairs.
            let rows = sqlx::query("SELECT c.conname::text, rn.nspname::text, rt.relname::text, array_agg(a.attname::text ORDER BY k.ord), array_agg(ra.attname::text ORDER BY k.ord) FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid = c.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace JOIN pg_catalog.pg_class rt ON rt.oid = c.confrelid JOIN pg_catalog.pg_namespace rn ON rn.oid = rt.relnamespace CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(attnum, refnum, ord) JOIN pg_catalog.pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum JOIN pg_catalog.pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = k.refnum WHERE c.contype = 'f' AND n.nspname = $1 AND t.relname = $2 GROUP BY c.oid, c.conname, rn.nspname, rt.relname ORDER BY c.conname")
                .bind(&table.schema).bind(&table.name).fetch_all(p).await.map_err(err)?;
            rows.iter()
                .map(|r| {
                    Ok(ForeignKeyInfo {
                        name: r.try_get(0).map_err(err)?,
                        referenced_table: referenced(
                            r.try_get(1).map_err(err)?,
                            r.try_get(2).map_err(err)?,
                        ),
                        columns: r.try_get(3).map_err(err)?,
                        referenced_columns: r.try_get(4).map_err(err)?,
                    })
                })
                .collect()
        }
        Pool::My(p) => {
            // TEMPORARY tables cannot have foreign keys, so they simply list none.
            let rows = sqlx::query("SELECT CAST(constraint_name AS CHAR), CAST(referenced_table_schema AS CHAR), CAST(referenced_table_name AS CHAR), CAST(column_name AS CHAR), CAST(referenced_column_name AS CHAR) FROM information_schema.key_column_usage WHERE table_schema = COALESCE(NULLIF(?, ''), DATABASE()) AND table_name = ? AND referenced_table_name IS NOT NULL ORDER BY constraint_name, ordinal_position")
                .bind(&table.schema).bind(&table.name).fetch_all(p).await.map_err(err)?;
            let mut keys: Vec<ForeignKeyInfo> = Vec::new();
            for r in &rows {
                let name: String = r.try_get(0).map_err(err)?;
                let column: String = r.try_get(3).map_err(err)?;
                let target: String = r.try_get(4).map_err(err)?;
                match keys.last_mut() {
                    Some(last) if last.name == name => {
                        last.columns.push(column);
                        last.referenced_columns.push(target);
                    }
                    _ => keys.push(ForeignKeyInfo {
                        name,
                        referenced_table: referenced(
                            r.try_get(1).map_err(err)?,
                            r.try_get(2).map_err(err)?,
                        ),
                        columns: vec![column],
                        referenced_columns: vec![target],
                    }),
                }
            }
            Ok(keys)
        }
        Pool::Lite(p) => {
            let schema = if table.schema.is_empty() {
                "main"
            } else {
                &table.schema
            };
            let rows = sqlx::query("SELECT id, \"table\", \"from\", \"to\" FROM pragma_foreign_key_list(?1, ?2) ORDER BY id, seq")
                .bind(&table.name).bind(schema).fetch_all(p).await.map_err(err)?;
            let mut keys: Vec<(i64, ForeignKeyInfo, Vec<Option<String>>)> = Vec::new();
            for r in &rows {
                let id: i64 = r.try_get(0).map_err(err)?;
                let column: String = r.try_get(2).map_err(err)?;
                let target: Option<String> = r.try_get(3).map_err(err)?;
                match keys.last_mut() {
                    Some((last, key, targets)) if *last == id => {
                        key.columns.push(column);
                        targets.push(target);
                    }
                    _ => keys.push((
                        id,
                        ForeignKeyInfo {
                            name: format!("fk_{id}"),
                            referenced_table: referenced(
                                table.schema.clone(),
                                r.try_get(1).map_err(err)?,
                            ),
                            columns: vec![column],
                            referenced_columns: Vec::new(),
                        },
                        vec![target],
                    )),
                }
            }
            let mut result = Vec::new();
            for (_, mut key, targets) in keys {
                // `REFERENCES parent` without columns means the parent's primary key.
                let implicit = if targets.iter().any(Option::is_none) {
                    sqlx::query_scalar::<_, String>(
                        "SELECT name FROM pragma_table_info(?1, ?2) WHERE pk > 0 ORDER BY pk",
                    )
                    .bind(&key.referenced_table.name)
                    .bind(schema)
                    .fetch_all(p)
                    .await
                    .map_err(err)?
                } else {
                    Vec::new()
                };
                key.referenced_columns = targets
                    .into_iter()
                    .enumerate()
                    .map(|(i, target)| target.or_else(|| implicit.get(i).cloned()))
                    .collect::<Option<Vec<_>>>()
                    .ok_or_else(|| {
                        format!(
                            "Foreign key to {} has no matching key columns",
                            key.referenced_table.name
                        )
                    })?;
                result.push(key);
            }
            Ok(result)
        }
    }
}
#[tauri::command]
pub(crate) async fn dbde_get_foreign_keys(
    connection_id: String,
    table: TableInfo,
    database: Option<String>,
    state: State<'_, AppState>,
) -> DbResult<Vec<ForeignKeyInfo>> {
    check_table(&table)?;
    let conn = timed(database_connection(
        &state,
        &connection_id,
        database.as_deref(),
    ))
    .await?;
    timed(foreign_keys(&conn.pool, &table)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    fn choices(text: &str) -> Option<(bool, Vec<String>)> {
        mysql_choices(text)
    }
    #[test]
    fn enum_and_set_lists_handle_quotes_escapes_commas_and_unicode() {
        assert_eq!(
            choices("enum('small','medium','large')"),
            Some((false, vec!["small".into(), "medium".into(), "large".into()]))
        );
        assert_eq!(
            choices("ENUM( 'it''s' , 'a,b' )"),
            Some((false, vec!["it's".into(), "a,b".into()]))
        );
        assert_eq!(
            choices(r"enum('back\\slash','quote\'d','tab\there')"),
            Some((
                false,
                vec!["back\\slash".into(), "quote'd".into(), "tab\there".into()]
            ))
        );
        assert_eq!(
            choices("set('café','日本語','emoji 🎉','')"),
            Some((
                true,
                vec!["café".into(), "日本語".into(), "emoji 🎉".into(), "".into()]
            ))
        );
        assert_eq!(
            choices("set('a)b','(c')"),
            Some((true, vec!["a)b".into(), "(c".into()]))
        );
    }
    #[test]
    fn other_types_and_broken_lists_are_not_choices() {
        for text in [
            "varchar(20)",
            "enumeration('a')",
            "enum('open",
            "enum('a' 'b')",
            "enum(a,b)",
            "set('a') extra",
            "enum('a'",
            "enum",
            "",
        ] {
            assert_eq!(choices(text), None, "{text}");
        }
        assert!(mysql_is_boolean("tinyint(1)"));
        assert!(mysql_is_boolean("TINYINT(1) unsigned"));
        assert!(!mysql_is_boolean("tinyint(4)"));
        assert!(!mysql_is_boolean("tinyint"));
        assert!(sqlite_is_boolean("BOOLEAN"));
        assert!(!sqlite_is_boolean("INTEGER"));
        let column = mysql_column("size".into(), "set('s','m')".into(), true);
        assert_eq!(column.set_values, Some(vec!["s".into(), "m".into()]));
        assert_eq!(column.enum_values, None);
        assert!(!column.is_boolean);
    }
    async fn sqlite() -> Pool {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let pool = Pool::Lite(pool);
        raw_pool_query(&pool, "CREATE TABLE tenant (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE account (tenant INTEGER, code TEXT, label TEXT, PRIMARY KEY (tenant, code)); CREATE TABLE \"odd \"\"child\" (id INTEGER PRIMARY KEY, owner INTEGER REFERENCES tenant, t INTEGER, c TEXT, active BOOLEAN, FOREIGN KEY (c, t) REFERENCES account (code, tenant))").await.unwrap();
        pool
    }
    fn table(name: &str) -> TableInfo {
        TableInfo {
            name: name.into(),
            schema: "".into(),
            kind: "table".into(),
        }
    }
    #[tokio::test]
    async fn sqlite_foreign_keys_keep_column_pairs_and_resolve_implicit_keys() {
        let pool = sqlite().await;
        let mut keys = foreign_keys(&pool, &table("odd \"child")).await.unwrap();
        keys.sort_by_key(|key| key.columns.len());
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].columns, vec!["owner"]);
        assert_eq!(keys[0].referenced_table.name, "tenant");
        assert_eq!(keys[0].referenced_columns, vec!["id"]);
        // Composite keys keep the declared pairing, not the parent's column order.
        assert_eq!(keys[1].columns, vec!["c", "t"]);
        assert_eq!(keys[1].referenced_table.name, "account");
        assert_eq!(keys[1].referenced_columns, vec!["code", "tenant"]);
        assert!(foreign_keys(&pool, &table("tenant"))
            .await
            .unwrap()
            .is_empty());
        assert!(foreign_keys(&pool, &table("")).await.is_err());
        let columns = table_columns(&pool, &table("odd \"child")).await.unwrap();
        assert!(
            columns
                .iter()
                .find(|c| c.name == "active")
                .unwrap()
                .is_boolean
        );
        assert!(
            !columns
                .iter()
                .find(|c| c.name == "owner")
                .unwrap()
                .is_boolean
        );
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_PG_URL; creates only session-local temporary objects"]
    async fn postgres_enums_booleans_and_foreign_keys() {
        let conn = crate::tests::server_connection("DBDE_TEST_PG_URL", Driver::Postgres).await;
        raw_pool_query(&conn.pool, "CREATE TYPE pg_temp.dbde_mood AS ENUM ('calm', 'it''s, fine', 'héllo'); ALTER TYPE pg_temp.dbde_mood ADD VALUE 'first' BEFORE 'calm'; CREATE TEMPORARY TABLE dbde_parent (tenant int, code text, label text, PRIMARY KEY (tenant, code)); CREATE TEMPORARY TABLE dbde_child (id int PRIMARY KEY, mood pg_temp.dbde_mood, ok boolean NOT NULL, code text, tenant int, FOREIGN KEY (code, tenant) REFERENCES dbde_parent (code, tenant))").await.unwrap();
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
        let child = TableInfo {
            name: "dbde_child".into(),
            schema: schema.clone(),
            kind: "table".into(),
        };
        let columns = table_columns(&conn.pool, &child).await.unwrap();
        let mood = columns.iter().find(|c| c.name == "mood").unwrap();
        assert_eq!(
            mood.enum_values,
            Some(vec![
                "first".into(),
                "calm".into(),
                "it's, fine".into(),
                "héllo".into()
            ])
        );
        let ok = columns.iter().find(|c| c.name == "ok").unwrap();
        assert!(ok.is_boolean && !ok.nullable && ok.enum_values.is_none());
        assert!(!columns.iter().find(|c| c.name == "id").unwrap().is_boolean);
        let keys = foreign_keys(&conn.pool, &child).await.unwrap();
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].columns, vec!["code", "tenant"]);
        assert_eq!(keys[0].referenced_columns, vec!["code", "tenant"]);
        assert_eq!(keys[0].referenced_table.name, "dbde_parent");
        assert_eq!(keys[0].referenced_table.schema, schema);
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_MYSQL_URL; creates only session-local temporary tables"]
    async fn mysql_enum_set_and_boolean_columns_parse_from_the_server() {
        let conn = crate::tests::server_connection("DBDE_TEST_MYSQL_URL", Driver::Mysql).await;
        query(&conn.pool, "CREATE TEMPORARY TABLE dbde_choices (id INT PRIMARY KEY, size ENUM('s','it''s','a,b','back\\\\slash','日本') NULL, tags SET('red','gr''een','ünï') NOT NULL, flag BOOL)").await.unwrap();
        // MariaDB 10.4 leaves TEMPORARY tables out of information_schema; SHOW COLUMNS
        // returns the same COLUMN_TYPE text the editor parses for regular tables.
        let shown = query(&conn.pool, "SHOW COLUMNS FROM dbde_choices")
            .await
            .unwrap();
        let types: HashMap<String, String> = shown
            .rows
            .iter()
            .map(|row| {
                let text = |value: &Value| match value {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                };
                (text(&row[0]), text(&row[1]))
            })
            .collect();
        assert_eq!(
            mysql_choices(&types["size"]),
            Some((
                false,
                vec![
                    "s".into(),
                    "it's".into(),
                    "a,b".into(),
                    "back\\slash".into(),
                    "日本".into()
                ]
            ))
        );
        assert_eq!(
            mysql_choices(&types["tags"]),
            Some((true, vec!["red".into(), "gr'een".into(), "ünï".into()]))
        );
        assert!(mysql_is_boolean(&types["flag"]));
        let mut temp = TableInfo {
            name: "dbde_choices".into(),
            schema: String::new(),
            kind: "table".into(),
        };
        // TEMPORARY tables cannot have foreign keys: the list is empty, not an error.
        assert!(foreign_keys(&conn.pool, &temp).await.unwrap().is_empty());
        temp.schema = query(&conn.pool, "SELECT DATABASE()").await.unwrap().rows[0][0]
            .as_str()
            .unwrap()
            .to_string();
        assert!(table_columns(&conn.pool, &temp).await.is_ok());
    }
}
