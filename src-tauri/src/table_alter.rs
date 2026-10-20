use super::*;
use table_rename::{mysql_definition, validate, FieldRename};

#[derive(Clone, Deserialize)]
pub(crate) struct TypeEdit {
    name: String,
    length: String,
    decimals: String,
    #[serde(default)]
    unsigned: bool,
    #[serde(default)]
    zerofill: bool,
    #[serde(default)]
    values: Vec<String>,
}
#[derive(Clone, Deserialize)]
pub(crate) struct DefaultEdit {
    kind: String,
    value: String,
}
#[derive(Clone, Default, Deserialize)]
pub(crate) struct FieldPatch {
    data_type: Option<TypeEdit>,
    not_null: Option<bool>,
    comment: Option<String>,
    default: Option<DefaultEdit>,
    charset: Option<String>,
    collation: Option<String>,
    generated: Option<bool>,
    stored: Option<bool>,
    expression: Option<String>,
    primary: Option<bool>,
    auto_increment: Option<bool>,
}
#[derive(Clone, Deserialize)]
pub(crate) struct FieldChange {
    from: String,
    to: String,
    #[serde(default)]
    patch: FieldPatch,
}

fn literal(value: &str, backslash: bool) -> DbResult<String> {
    if value.contains('\0') || value.len() > 65535 {
        return Err("Invalid default or comment value.".into());
    }
    let value = if backslash {
        value.replace('\\', "\\\\")
    } else {
        value.into()
    };
    Ok(format!("'{}'", value.replace('\'', "''")))
}
fn sql_type(edit: &TypeEdit, mysql: bool, backslash: bool) -> DbResult<String> {
    let name = edit.name.to_lowercase();
    let allowed = if mysql {
        vec![
            "int",
            "integer",
            "bigint",
            "smallint",
            "tinyint",
            "mediumint",
            "varchar",
            "char",
            "text",
            "tinytext",
            "mediumtext",
            "longtext",
            "decimal",
            "numeric",
            "float",
            "double",
            "date",
            "datetime",
            "timestamp",
            "time",
            "year",
            "json",
            "boolean",
            "bool",
            "enum",
            "set",
            "blob",
            "tinyblob",
            "mediumblob",
            "longblob",
            "binary",
            "varbinary",
            "bit",
        ]
    } else {
        vec![
            "integer",
            "int",
            "bigint",
            "smallint",
            "varchar",
            "character varying",
            "char",
            "character",
            "text",
            "numeric",
            "decimal",
            "real",
            "double precision",
            "boolean",
            "date",
            "timestamp",
            "timestamp without time zone",
            "timestamp with time zone",
            "time",
            "time without time zone",
            "time with time zone",
            "uuid",
            "json",
            "jsonb",
            "bytea",
        ]
    };
    if !allowed.contains(&name.as_str()) {
        return Err("Choose a supported data type.".into());
    }
    let number = |value: &str| -> DbResult<Option<u32>> {
        if value.is_empty() {
            Ok(None)
        } else {
            value
                .parse::<u32>()
                .map(Some)
                .map_err(|_| "Length and decimals must be whole numbers.".into())
        }
    };
    let length = number(&edit.length)?;
    let decimals = number(&edit.decimals)?;
    let temporal = name.starts_with("timestamp") || name.starts_with("time") || name == "datetime";
    let numeric = ["decimal", "numeric", "float", "double"].contains(&name.as_str());
    if let Some(n) = length {
        if temporal {
            if n > 6 {
                return Err("Date/time precision must be between 0 and 6.".into());
            }
        } else if n == 0 || n > 65535 {
            return Err("Length must be between 1 and 65535.".into());
        }
        if ["decimal", "numeric"].contains(&name.as_str()) && n > if mysql { 65 } else { 1000 } {
            return Err("Decimal precision is too large.".into());
        }
        if !temporal
            && !numeric
            && ![
                "int",
                "integer",
                "bigint",
                "smallint",
                "tinyint",
                "mediumint",
                "varchar",
                "character varying",
                "char",
                "character",
                "binary",
                "varbinary",
                "bit",
            ]
            .contains(&name.as_str())
        {
            return Err("This type does not support a length.".into());
        }
    }
    if let Some(scale) = decimals {
        if !numeric || length.is_none() || scale > length.unwrap_or(0) || (mysql && scale > 30) {
            return Err("Decimals must fit within the numeric precision.".into());
        }
    }
    if ["enum", "set"].contains(&name.as_str()) {
        if edit.values.is_empty() || edit.values.len() > 1024 {
            return Err("Provide the allowed enum/set values.".into());
        }
        return Ok(format!(
            "{name}({})",
            edit.values
                .iter()
                .map(|v| literal(v, backslash))
                .collect::<DbResult<Vec<_>>>()?
                .join(",")
        ));
    }
    let mut result = name.clone();
    if let Some(length) = length {
        let args = format!(
            "({length}{})",
            decimals.map(|n| format!(",{n}")).unwrap_or_default()
        );
        if name.contains(" time zone") {
            let at = result.find(' ').unwrap();
            result.insert_str(at, &args);
        } else {
            result.push_str(&args);
        }
    }
    if ["varchar", "char", "binary", "varbinary", "bit"].contains(&name.as_str())
        && mysql
        && length.is_none()
    {
        return Err("This type requires a length.".into());
    }
    if edit.unsigned || edit.zerofill {
        if !mysql
            || ![
                "int",
                "integer",
                "bigint",
                "smallint",
                "tinyint",
                "mediumint",
                "decimal",
                "numeric",
                "float",
                "double",
            ]
            .contains(&name.as_str())
        {
            return Err("Unsigned is available for MySQL numeric fields only.".into());
        }
        result.push_str(" unsigned");
        if edit.zerofill {
            result.push_str(" zerofill");
        }
    }
    Ok(result)
}

// Top-level tokens retain exact byte ranges, including complete quoted literals
// and parenthesized expressions. Edits replace only the requested attributes.
fn tokens(sql: &str, backslash: bool) -> DbResult<Vec<(usize, usize)>> {
    let b = sql.as_bytes();
    let mut result = Vec::new();
    let mut at = 0;
    while at < b.len() {
        if b[at].is_ascii_whitespace() {
            at += 1;
            continue;
        }
        let start = at;
        let mut quote = 0;
        let mut depth = 0usize;
        while at < b.len() {
            let c = b[at];
            if quote != 0 {
                if c == b'\\' && backslash && quote != b'`' {
                    at += 2;
                    continue;
                }
                if c == quote {
                    if b.get(at + 1) == Some(&quote) {
                        at += 2;
                        continue;
                    }
                    quote = 0;
                }
            } else if c == b'\'' || c == b'"' || c == b'`' {
                quote = c;
            } else if c == b'/' && b.get(at + 1) == Some(&b'*') {
                at += 2;
                while at + 1 < b.len() && !(b[at] == b'*' && b[at + 1] == b'/') {
                    at += 1;
                }
                if at + 1 >= b.len() {
                    return Err("Unclosed column attribute comment.".into());
                }
                at += 2;
                continue;
            } else if c == b'(' {
                depth += 1;
            } else if c == b')' {
                if depth == 0 {
                    return Err("Unbalanced expression.".into());
                }
                depth -= 1;
            } else if c.is_ascii_whitespace() && depth == 0 {
                break;
            }
            at += 1;
        }
        if quote != 0 || depth != 0 || at > b.len() {
            return Err("Unbalanced expression.".into());
        }
        result.push((start, at));
    }
    Ok(result)
}
fn attribute(sql: &str, key: &str, backslash: bool) -> DbResult<Option<(usize, usize)>> {
    let parts = tokens(sql, backslash)?;
    let word = |i: usize| {
        parts
            .get(i)
            .map(|(a, b)| sql[*a..*b].to_ascii_uppercase())
            .unwrap_or_default()
    };
    let mut i = 0;
    while i < parts.len() {
        let w = word(i);
        let (kind, count) = match w.as_str() {
            "NOT" if word(i + 1) == "NULL" => ("nullable", 2),
            "NULL" => ("nullable", 1),
            "DEFAULT" => (
                "default",
                if word(i + 1).starts_with('_') && word(i + 2).starts_with('\'') {
                    3
                } else {
                    2
                },
            ),
            "CHARACTER" if word(i + 1) == "SET" => ("charset", 3),
            "COLLATE" => ("collation", 2),
            "COMMENT" => ("comment", 2),
            "AUTO_INCREMENT" => ("auto_increment", 1),
            "ON" if word(i + 1) == "UPDATE" => ("on_update", 3),
            "GENERATED" | "AS" => {
                let mut end = i;
                while end < parts.len() && word(end) != "AS" {
                    end += 1;
                }
                end += 2;
                if ["VIRTUAL", "STORED", "PERSISTENT"].contains(&word(end).as_str()) {
                    end += 1;
                }
                ("generated", end - i)
            }
            "CHECK" => ("check", 2),
            "REFERENCES" => ("references", 2),
            "INVISIBLE" | "VISIBLE" => ("visibility", 1),
            "COLUMN_FORMAT" | "STORAGE" | "SRID" => ("other", 2),
            _ if w.starts_with("/*") => ("other", 1),
            _ => ("", 1),
        };
        if kind == key {
            let end = parts
                .get(i + count - 1)
                .ok_or("Incomplete column attribute")?
                .1;
            return Ok(Some((parts[i].0, end)));
        }
        i += count;
    }
    Ok(None)
}
fn replace(sql: &mut String, key: &str, value: &str, backslash: bool) -> DbResult<()> {
    if let Some((start, end)) = attribute(sql, key, backslash)? {
        sql.replace_range(start..end, value);
    } else if !value.is_empty() {
        sql.push(' ');
        sql.push_str(value);
    }
    *sql = sql.trim().to_string();
    Ok(())
}
fn default_sql(edit: &DefaultEdit, backslash: bool) -> DbResult<String> {
    let expression = edit.value.to_uppercase();
    let expression_valid = ["CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME"]
        .iter()
        .any(|name| {
            expression == *name
                || expression.strip_prefix(name).is_some_and(|suffix| {
                    suffix == "()"
                        || (suffix.starts_with('(')
                            && suffix.ends_with(')')
                            && suffix[1..suffix.len() - 1].len() == 1
                            && suffix[1..suffix.len() - 1]
                                .parse::<u8>()
                                .is_ok_and(|n| n <= 6))
                })
        });
    match edit.kind.as_str() {
        "none" => Ok(String::new()),
        "null" => Ok("DEFAULT NULL".into()),
        "value" => Ok(format!("DEFAULT {}", literal(&edit.value, backslash)?)),
        "expression" if expression_valid => Ok(format!("DEFAULT {}", edit.value.to_uppercase())),
        _ => Err("Choose a supported default value or expression.".into()),
    }
}
fn mysql_patch(original: &str, patch: &FieldPatch, backslash: bool) -> DbResult<String> {
    if patch.primary == Some(true) && patch.not_null == Some(false) {
        return Err("Primary key fields must be Not Null.".into());
    }
    if patch.generated == Some(true)
        && patch
            .default
            .as_ref()
            .is_some_and(|value| value.kind != "none")
    {
        return Err("Generated fields cannot have a default.".into());
    }
    let mut sql = original.to_string();
    if let Some(edit) = &patch.data_type {
        let end = [
            "nullable",
            "default",
            "charset",
            "collation",
            "comment",
            "auto_increment",
            "generated",
            "on_update",
            "visibility",
            "other",
            "check",
            "references",
        ]
        .iter()
        .filter_map(|key| attribute(&sql, key, backslash).ok().flatten().map(|v| v.0))
        .min()
        .unwrap_or(sql.len());
        let prefix = sql[..end].trim();
        for (a, b) in tokens(prefix, backslash)?.into_iter().skip(1) {
            if !["UNSIGNED", "ZEROFILL", "BINARY", "PRECISION"]
                .contains(&prefix[a..b].to_ascii_uppercase().as_str())
            {
                return Err(
                    "This field has extended type attributes. Use SQL Editor to preserve them."
                        .into(),
                );
            }
        }
        sql.replace_range(..end, &format!("{} ", sql_type(edit, true, backslash)?));
    }
    if let Some(required) = patch.not_null {
        replace(
            &mut sql,
            "nullable",
            if required { "NOT NULL" } else { "NULL" },
            backslash,
        )?;
        if required {
            if let Some((a, b)) = attribute(&sql, "default", backslash)? {
                if sql[a..b].eq_ignore_ascii_case("DEFAULT NULL") {
                    replace(&mut sql, "default", "", backslash)?;
                }
            }
        }
    }
    if let Some(value) = &patch.comment {
        if value.chars().count() > 1024 {
            return Err("Field comments are limited to 1024 characters.".into());
        }
        replace(
            &mut sql,
            "comment",
            &format!("COMMENT {}", literal(value, backslash)?),
            backslash,
        )?;
    }
    if let Some(edit) = &patch.default {
        let mut edit = edit.clone();
        if edit.kind == "value" && sql.to_lowercase().starts_with("bool") {
            edit.value = match edit.value.to_lowercase().as_str() {
                "true" => "1".into(),
                "false" => "0".into(),
                _ => edit.value,
            };
        }
        replace(
            &mut sql,
            "default",
            &default_sql(&edit, backslash)?,
            backslash,
        )?;
    }
    for (key, prefix, value) in [
        ("charset", "CHARACTER SET", &patch.charset),
        ("collation", "COLLATE", &patch.collation),
    ] {
        if let Some(value) = value {
            if !value
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_')
            {
                return Err("Invalid charset or collation.".into());
            }
            replace(
                &mut sql,
                key,
                &if value.is_empty() {
                    String::new()
                } else {
                    format!("{prefix} {value}")
                },
                backslash,
            )?;
        }
    }
    if let Some(enabled) = patch.auto_increment {
        replace(
            &mut sql,
            "auto_increment",
            if enabled { "AUTO_INCREMENT" } else { "" },
            backslash,
        )?;
    }
    if patch.generated.is_some() || patch.stored.is_some() || patch.expression.is_some() {
        if patch.generated == Some(true) {
            replace(&mut sql, "default", "", backslash)?;
        }
        let current = attribute(&sql, "generated", backslash)?;
        if patch.generated == Some(false) {
            replace(&mut sql, "generated", "", backslash)?;
        } else {
            let old = current
                .map(|(a, b)| sql[a..b].to_string())
                .unwrap_or_default();
            let expression = patch
                .expression
                .clone()
                .or_else(|| {
                    old.find('(')
                        .and_then(|a| old.rfind(')').map(|b| old[a + 1..b].to_string()))
                })
                .unwrap_or_default();
            if expression.trim().is_empty()
                || expression.len() > 10000
                || expression.contains([';', '\0'])
                || expression.contains("--")
                || expression.contains("/*")
            {
                return Err("Provide a valid generated field expression.".into());
            }
            tokens(&expression, backslash)?;
            let stored = patch.stored.unwrap_or_else(|| {
                old.to_uppercase().ends_with("STORED") || old.to_uppercase().ends_with("PERSISTENT")
            });
            replace(
                &mut sql,
                "generated",
                &format!(
                    "GENERATED ALWAYS AS ({expression}) {}",
                    if stored { "STORED" } else { "VIRTUAL" }
                ),
                backslash,
            )?;
        }
    }
    Ok(sql)
}

async fn mysql_plan(
    connection: &mut sqlx::MySqlConnection,
    table: &TableInfo,
    changes: &[FieldChange],
) -> DbResult<String> {
    let target = rows::qualified(table, &Driver::Mysql);
    let rows = sqlx::query(&format!("SHOW FULL COLUMNS FROM {target}"))
        .fetch_all(&mut *connection)
        .await
        .map_err(err)?;
    let names = rows
        .iter()
        .map(|row| row.try_get::<String, _>(0).map_err(err))
        .collect::<DbResult<Vec<_>>>()?;
    validate(
        &names,
        &changes
            .iter()
            .map(|c| FieldRename {
                from: c.from.clone(),
                to: c.to.clone(),
            })
            .collect::<Vec<_>>(),
        &Driver::Mysql,
    )?;
    let mode: String = sqlx::query_scalar("SELECT @@SESSION.sql_mode")
        .fetch_one(&mut *connection)
        .await
        .map_err(err)?;
    let backslash = !mode.split(',').any(|m| m == "NO_BACKSLASH_ESCAPES");
    let row = sqlx::query(&format!("SHOW CREATE TABLE {target}"))
        .fetch_one(&mut *connection)
        .await
        .map_err(err)?;
    let ddl: String = row.try_get(1).map_err(err)?;
    let mut clauses = Vec::new();
    for change in changes {
        let original = mysql_definition(&ddl, &change.from, backslash)?;
        clauses.push(format!(
            "CHANGE COLUMN {} {} {}",
            rows::quote(&change.from, &Driver::Mysql),
            rows::quote(&change.to, &Driver::Mysql),
            mysql_patch(&original, &change.patch, backslash)?
        ));
    }
    if changes.iter().any(|c| c.patch.primary.is_some()) {
        let rows = sqlx::query(&format!("SHOW INDEX FROM {target}"))
            .fetch_all(&mut *connection)
            .await
            .map_err(err)?;
        let mut primary: Vec<(i64, String)> = Vec::new();
        for row in rows {
            if row.try_get::<String, _>("Key_name").map_err(err)? == "PRIMARY" {
                primary.push((
                    row.try_get::<i64, _>("Seq_in_index")
                        .or_else(|_| row.try_get::<u64, _>("Seq_in_index").map(|n| n as i64))
                        .map_err(err)?,
                    row.try_get("Column_name").map_err(err)?,
                ));
            }
        }
        primary.sort_by_key(|v| v.0);
        let old: Vec<String> = primary.into_iter().map(|(_, name)| name).collect();
        let mut keys: Vec<String> = old
            .iter()
            .filter(|name| {
                !changes
                    .iter()
                    .any(|c| &c.from == *name && c.patch.primary == Some(false))
            })
            .map(|name| {
                changes
                    .iter()
                    .find(|c| &c.from == name)
                    .map(|c| c.to.clone())
                    .unwrap_or(name.clone())
            })
            .collect();
        for change in changes {
            if change.patch.primary == Some(true) && !keys.contains(&change.to) {
                keys.push(change.to.clone());
            }
        }
        if !old.is_empty() {
            clauses.push("DROP PRIMARY KEY".into());
        }
        if !keys.is_empty() {
            clauses.push(format!(
                "ADD PRIMARY KEY ({})",
                keys.iter()
                    .map(|name| rows::quote(name, &Driver::Mysql))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
    }
    Ok(format!(
        "ALTER TABLE {target}\n  {};",
        clauses.join(",\n  ")
    ))
}

#[tauri::command]
pub(crate) async fn dbde_alter_table_fields(
    connection_id: String,
    database: String,
    table: TableInfo,
    changes: Vec<FieldChange>,
    preview: bool,
    state: State<'_, AppState>,
) -> DbResult<String> {
    timed(async {
        if table.kind!="table" || changes.is_empty() || changes.len()>256 {return Err("Choose table fields to edit.".into());}
        let conn=database_connection(&state,&connection_id,Some(&database)).await?;
        match &conn.pool {
            Pool::My(pool) => {
                let mut acquired = pool.acquire().await.map_err(err)?;
                if preview { return mysql_plan(&mut acquired, &table, &changes).await; }
                // A private connection prevents strict-mode changes leaking to query tabs,
                // including when a request times out. STRICT_ALL_TABLES rejects truncation.
                let mut connection = acquired.detach();
                let mode: String = sqlx::query_scalar("SELECT @@SESSION.sql_mode").fetch_one(&mut connection).await.map_err(err)?;
                let strict = if mode.split(',').any(|m| m == "STRICT_ALL_TABLES") { mode } else if mode.is_empty() { "STRICT_ALL_TABLES".into() } else { format!("{mode},STRICT_ALL_TABLES") };
                sqlx::query("SET SESSION sql_mode = ?").bind(strict).execute(&mut connection).await.map_err(err)?;
                let sql = mysql_plan(&mut connection, &table, &changes).await?;
                sqlx::query(&sql).execute(&mut connection).await.map_err(err)?;
                Ok(sql)
            },
            _=>Err("Use SQL Editor to change field properties for this database. Field renaming is available in Design Table.".into()),
        }
    }).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "Uses session-local temporary tables only; requires DBDE_TEST_MYSQL_URL"]
    async fn mysql_edits_fields_and_rejects_truncating_batch() {
        let url = std::env::var("DBDE_TEST_MYSQL_URL").expect("Set a MySQL test URL");
        let mut connection = sqlx::MySqlConnection::connect(&url).await.unwrap();
        sqlx::query("SET SESSION sql_mode='STRICT_ALL_TABLES'")
            .execute(&mut connection)
            .await
            .unwrap();
        sqlx::query("CREATE TEMPORARY TABLE dbde_field_edit_test (id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,label VARCHAR(40) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT 'Guest' COMMENT 'keep',qty DECIMAL(10,2) DEFAULT 0,calc INT GENERATED ALWAYS AS (qty * 2) VIRTUAL)").execute(&mut connection).await.unwrap();
        sqlx::query("INSERT INTO dbde_field_edit_test(label,qty) VALUES ('Ada',3)")
            .execute(&mut connection)
            .await
            .unwrap();
        let table = TableInfo {
            name: "dbde_field_edit_test".into(),
            schema: "".into(),
            kind: "table".into(),
        };
        let changes = vec![
            FieldChange {
                from: "label".into(),
                to: "title".into(),
                patch: FieldPatch {
                    data_type: Some(TypeEdit {
                        name: "varchar".into(),
                        length: "80".into(),
                        decimals: "".into(),
                        unsigned: false,
                        zerofill: false,
                        values: vec![],
                    }),
                    not_null: Some(true),
                    comment: Some("Customer's title".into()),
                    default: Some(DefaultEdit {
                        kind: "value".into(),
                        value: "Visitor".into(),
                    }),
                    charset: Some("utf8mb4".into()),
                    collation: Some("utf8mb4_unicode_ci".into()),
                    primary: Some(true),
                    ..Default::default()
                },
            },
            FieldChange {
                from: "qty".into(),
                to: "qty".into(),
                patch: FieldPatch {
                    data_type: Some(TypeEdit {
                        name: "decimal".into(),
                        length: "12".into(),
                        decimals: "3".into(),
                        unsigned: false,
                        zerofill: false,
                        values: vec![],
                    }),
                    not_null: Some(true),
                    default: Some(DefaultEdit {
                        kind: "value".into(),
                        value: "1.250".into(),
                    }),
                    ..Default::default()
                },
            },
            FieldChange {
                from: "calc".into(),
                to: "calc".into(),
                patch: FieldPatch {
                    expression: Some("`qty` * 3".into()),
                    ..Default::default()
                },
            },
        ];
        let plan = mysql_plan(&mut connection, &table, &changes).await.unwrap();
        let before = sqlx::query("SHOW FULL COLUMNS FROM dbde_field_edit_test")
            .fetch_all(&mut connection)
            .await
            .unwrap();
        assert!(before
            .iter()
            .any(|row| row.get::<String, _>("Field") == "label"));
        sqlx::query(&plan).execute(&mut connection).await.unwrap();
        let row = sqlx::query("SHOW CREATE TABLE dbde_field_edit_test")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        let ddl: String = row.try_get(1).unwrap();
        let title = mysql_definition(&ddl, "title", true).unwrap();
        assert!(title.starts_with("varchar(80)"));
        assert!(title.contains("utf8mb4_unicode_ci"));
        assert!(title.contains("NOT NULL"));
        assert!(title.contains("Visitor"));
        assert!(title.contains("title"));
        assert!(ddl.contains("PRIMARY KEY (`id`,`title`)"));
        let qty = mysql_definition(&ddl, "qty", true).unwrap();
        assert!(qty.starts_with("decimal(12,3)"));
        let row = sqlx::query(
            "SELECT CAST(title AS CHAR), CAST(qty AS CHAR), calc FROM dbde_field_edit_test",
        )
        .fetch_one(&mut connection)
        .await
        .unwrap();
        assert_eq!(row.get::<String, _>(0), "Ada");
        assert_eq!(row.get::<String, _>(1), "3.000");
        assert_eq!(row.get::<i32, _>(2), 9);
        let bad = vec![
            FieldChange {
                from: "title".into(),
                to: "title".into(),
                patch: FieldPatch {
                    data_type: Some(TypeEdit {
                        name: "varchar".into(),
                        length: "1".into(),
                        decimals: "".into(),
                        unsigned: false,
                        zerofill: false,
                        values: vec![],
                    }),
                    ..Default::default()
                },
            },
            FieldChange {
                from: "qty".into(),
                to: "qty".into(),
                patch: FieldPatch {
                    default: Some(DefaultEdit {
                        kind: "value".into(),
                        value: "9".into(),
                    }),
                    ..Default::default()
                },
            },
        ];
        let plan = mysql_plan(&mut connection, &table, &bad).await.unwrap();
        assert!(sqlx::query(&plan).execute(&mut connection).await.is_err());
        let row = sqlx::query("SHOW CREATE TABLE dbde_field_edit_test")
            .fetch_one(&mut connection)
            .await
            .unwrap();
        let after: String = row.try_get(1).unwrap();
        assert_eq!(after, ddl);
        sqlx::query("DROP TEMPORARY TABLE dbde_field_edit_test")
            .execute(&mut connection)
            .await
            .unwrap();
    }
    #[test]
    fn changes_only_requested_mysql_attributes() {
        let original="varchar(60) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL DEFAULT 'x, y' COMMENT 'keep me' /*!80023 INVISIBLE */";
        let patch = FieldPatch {
            data_type: Some(TypeEdit {
                name: "varchar".into(),
                length: "120".into(),
                decimals: "".into(),
                unsigned: false,
                zerofill: false,
                values: vec![],
            }),
            not_null: Some(false),
            ..Default::default()
        };
        let changed = mysql_patch(original, &patch, true).unwrap();
        assert!(changed.starts_with("varchar(120)"));
        assert!(changed.contains("DEFAULT 'x, y'"));
        assert!(changed.contains("COMMENT 'keep me'"));
        assert!(changed.contains("INVISIBLE"));
        assert!(changed.contains("/*!80023 INVISIBLE */"));
        assert!(!changed.contains("NOT NULL"));
        let patch = FieldPatch {
            default: Some(DefaultEdit {
                kind: "value".into(),
                value: "Ada's \\ data".into(),
            }),
            comment: Some("new".into()),
            ..Default::default()
        };
        let changed = mysql_patch(original, &patch, true).unwrap();
        assert!(changed.contains("DEFAULT 'Ada''s \\\\ data'"));
        assert!(changed.contains("COMMENT 'new'"));
        assert!(changed.contains("NOT NULL"));
        let required = mysql_patch(
            "int DEFAULT NULL",
            &FieldPatch {
                not_null: Some(true),
                ..Default::default()
            },
            true,
        )
        .unwrap();
        assert!(!required.contains("DEFAULT NULL"));
        let generated = mysql_patch(
            "int DEFAULT NULL",
            &FieldPatch {
                generated: Some(true),
                expression: Some("1 + 2".into()),
                ..Default::default()
            },
            true,
        )
        .unwrap();
        assert!(!generated.contains("DEFAULT"));
        assert!(generated.contains("GENERATED ALWAYS AS (1 + 2)"));
        let boolean = mysql_patch(
            "boolean",
            &FieldPatch {
                default: Some(DefaultEdit {
                    kind: "value".into(),
                    value: "true".into(),
                }),
                ..Default::default()
            },
            true,
        )
        .unwrap();
        assert!(boolean.contains("DEFAULT '1'"));
    }
    #[test]
    fn rejects_invalid_types_scales_and_escaping_generated_expressions() {
        assert!(sql_type(
            &TypeEdit {
                name: "int); DROP TABLE x".into(),
                length: "".into(),
                decimals: "".into(),
                unsigned: false,
                zerofill: false,
                values: vec![]
            },
            true,
            true
        )
        .is_err());
        assert!(mysql_patch(
            "int",
            &FieldPatch {
                generated: Some(true),
                expression: Some("1) , DROP COLUMN secret, ADD x INT AS (1".into()),
                ..Default::default()
            },
            true
        )
        .is_err());
    }
}
