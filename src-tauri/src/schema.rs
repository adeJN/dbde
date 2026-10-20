use super::*;
use rows::qualified;
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
pub(crate) struct IndexInfo {
    name: String,
    columns: Vec<String>,
    unique: bool,
    primary: bool,
}
async fn list_indexes(conn: &Connection, table: &TableInfo) -> DbResult<Vec<IndexInfo>> {
    match &conn.pool {
        Pool::Pg(p) => {
            let rows = sqlx::query("SELECT i.relname, ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true) FROM generate_subscripts(ix.indkey, 1) AS k ORDER BY k)::text[], ix.indisunique, ix.indisprimary FROM pg_index ix JOIN pg_class t ON t.oid = ix.indrelid JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE n.nspname = $1 AND t.relname = $2 ORDER BY ix.indisprimary DESC, i.relname")
                .bind(&table.schema).bind(&table.name).fetch_all(p).await.map_err(err)?;
            rows.iter()
                .map(|r| {
                    Ok(IndexInfo {
                        name: r.try_get(0).map_err(err)?,
                        columns: r.try_get(1).map_err(err)?,
                        unique: r.try_get(2).map_err(err)?,
                        primary: r.try_get(3).map_err(err)?,
                    })
                })
                .collect()
        }
        Pool::My(p) => {
            let rows = sqlx::query("SELECT CAST(index_name AS CHAR), CAST(COALESCE(column_name, '(expression)') AS CHAR), CAST(non_unique AS SIGNED) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? ORDER BY index_name = 'PRIMARY' DESC, index_name, seq_in_index")
                .bind(&table.name).fetch_all(p).await.map_err(err)?;
            let mut indexes: Vec<IndexInfo> = Vec::new();
            for r in &rows {
                let name: String = r.try_get(0).map_err(err)?;
                let column: String = r.try_get(1).map_err(err)?;
                let non_unique: i64 = r.try_get(2).map_err(err)?;
                match indexes.last_mut() {
                    Some(last) if last.name == name => last.columns.push(column),
                    _ => indexes.push(IndexInfo {
                        primary: name == "PRIMARY",
                        name,
                        columns: vec![column],
                        unique: non_unique == 0,
                    }),
                }
            }
            Ok(indexes)
        }
        Pool::Lite(p) => {
            let list = sqlx::query("SELECT name, \"unique\", origin FROM pragma_index_list(?) ORDER BY origin = 'pk' DESC, name")
                .bind(&table.name).fetch_all(p).await.map_err(err)?;
            let mut indexes = Vec::new();
            for r in &list {
                let name: String = r.try_get(0).map_err(err)?;
                let columns = sqlx::query_scalar::<_, Option<String>>(
                    "SELECT name FROM pragma_index_info(?) ORDER BY seqno",
                )
                .bind(&name)
                .fetch_all(p)
                .await
                .map_err(err)?
                .into_iter()
                .map(|c| c.unwrap_or_else(|| "(expression)".into()))
                .collect();
                indexes.push(IndexInfo {
                    columns,
                    unique: r.try_get::<i64, _>(1).map_err(err)? != 0,
                    primary: r.try_get::<String, _>(2).map_err(err)? == "pk",
                    name,
                });
            }
            Ok(indexes)
        }
    }
}
#[tauri::command]
pub(crate) async fn dbde_list_indexes(
    connection_id: String,
    database: Option<String>,
    table: TableInfo,
    state: State<'_, AppState>,
) -> DbResult<Vec<IndexInfo>> {
    timed(async {
        let conn = database_connection(&state, &connection_id, database.as_deref()).await?;
        list_indexes(&conn, &table).await
    })
    .await
}

// PostgreSQL has no SHOW CREATE TABLE, so the definition is assembled from the catalog.
const PG_RELATION: &str = "WITH t AS (SELECT c.oid, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2)";
pub(crate) async fn pg_ddl(
    pool: &sqlx::PgPool,
    table: &TableInfo,
    without_foreign_keys: bool,
) -> DbResult<String> {
    let target = qualified(table, &Driver::Postgres);
    let kind: Option<String> =
        sqlx::query_scalar(&format!("{PG_RELATION} SELECT relkind::text FROM t"))
            .bind(&table.schema)
            .bind(&table.name)
            .fetch_optional(pool)
            .await
            .map_err(err)?;
    let kind = kind.ok_or("Table not found")?;
    if kind == "v" || kind == "m" {
        let definition: String = sqlx::query_scalar(&format!(
            "{PG_RELATION} SELECT pg_get_viewdef(oid, true) FROM t"
        ))
        .bind(&table.schema)
        .bind(&table.name)
        .fetch_one(pool)
        .await
        .map_err(err)?;
        let keyword = if kind == "m" {
            "MATERIALIZED VIEW"
        } else {
            "VIEW"
        };
        return Ok(format!(
            "CREATE {keyword} {target} AS\n{}",
            definition.trim_end()
        ));
    }
    let mut lines: Vec<String> = sqlx::query_scalar(&format!("{PG_RELATION} SELECT quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod) || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END || CASE WHEN a.attidentity = 'a' THEN ' GENERATED ALWAYS AS IDENTITY' WHEN a.attidentity = 'd' THEN ' GENERATED BY DEFAULT AS IDENTITY' WHEN a.attgenerated <> '' THEN ' GENERATED ALWAYS AS (' || pg_get_expr(d.adbin, d.adrelid) || ')' || CASE WHEN a.attgenerated = 'v' THEN ' VIRTUAL' ELSE ' STORED' END ELSE COALESCE(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '') END FROM t JOIN pg_attribute a ON a.attrelid = t.oid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum"))
        .bind(&table.schema).bind(&table.name).fetch_all(pool).await.map_err(err)?;
    lines.extend(
        sqlx::query_scalar::<_, String>(&format!("{PG_RELATION} SELECT 'CONSTRAINT ' || quote_ident(c.conname) || ' ' || pg_get_constraintdef(c.oid, true) FROM t JOIN pg_constraint c ON c.conrelid = t.oid WHERE (NOT $3 OR c.contype <> 'f') ORDER BY c.contype = 'p' DESC, c.conname"))
            .bind(&table.schema).bind(&table.name).bind(without_foreign_keys).fetch_all(pool).await.map_err(err)?,
    );
    let indexes: Vec<String> = sqlx::query_scalar(&format!("{PG_RELATION} SELECT pg_get_indexdef(i.indexrelid) || ';' FROM t JOIN pg_index i ON i.indrelid = t.oid WHERE NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = i.indexrelid) ORDER BY 1"))
        .bind(&table.schema).bind(&table.name).fetch_all(pool).await.map_err(err)?;
    let sequences: Vec<String> = sqlx::query_scalar(&format!("{PG_RELATION} SELECT 'CREATE SEQUENCE ' || quote_ident(sn.nspname) || '.' || quote_ident(sc.relname) || ' AS ' || format_type(s.seqtypid, NULL) || ' INCREMENT BY ' || s.seqincrement || ' MINVALUE ' || s.seqmin || ' MAXVALUE ' || s.seqmax || ' START WITH ' || s.seqstart || ' CACHE ' || s.seqcache || CASE WHEN s.seqcycle THEN ' CYCLE;' ELSE ' NO CYCLE;' END FROM t JOIN pg_depend dep ON dep.refobjid = t.oid AND dep.deptype = 'a' AND dep.classid = 'pg_class'::regclass JOIN pg_class sc ON sc.oid = dep.objid AND sc.relkind = 'S' JOIN pg_namespace sn ON sn.oid = sc.relnamespace JOIN pg_sequence s ON s.seqrelid = sc.oid ORDER BY sc.relname"))
        .bind(&table.schema).bind(&table.name).fetch_all(pool).await.map_err(err)?;
    let ownership: Vec<String> = sqlx::query_scalar(&format!("{PG_RELATION} SELECT 'ALTER SEQUENCE ' || quote_ident(sn.nspname) || '.' || quote_ident(sc.relname) || ' OWNED BY ' || quote_ident(n.nspname) || '.' || quote_ident(c.relname) || '.' || quote_ident(a.attname) || ';' FROM t JOIN pg_class c ON c.oid = t.oid JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_depend dep ON dep.refobjid = t.oid AND dep.deptype = 'a' AND dep.classid = 'pg_class'::regclass JOIN pg_class sc ON sc.oid = dep.objid AND sc.relkind = 'S' JOIN pg_namespace sn ON sn.oid = sc.relnamespace JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = dep.refobjsubid ORDER BY sc.relname"))
        .bind(&table.schema).bind(&table.name).fetch_all(pool).await.map_err(err)?;
    let mut ddl = String::new();
    if !sequences.is_empty() {
        ddl.push_str(&sequences.join("\n"));
        ddl.push_str("\n\n");
    }
    ddl.push_str(&format!(
        "CREATE TABLE {target} (\n  {}\n);",
        lines.join(",\n  ")
    ));
    if !ownership.is_empty() {
        ddl.push_str("\n\n");
        ddl.push_str(&ownership.join("\n"));
    }
    for index in indexes {
        ddl.push_str("\n\n");
        ddl.push_str(&index);
    }
    Ok(ddl)
}
pub(crate) async fn table_ddl(
    conn: &Connection,
    table: &TableInfo,
    without_foreign_keys: bool,
) -> DbResult<String> {
    match &conn.pool {
        Pool::Pg(p) => pg_ddl(p, table, without_foreign_keys).await,
        Pool::My(p) => {
            let row = sqlx::raw_sql(&format!(
                "SHOW CREATE TABLE {}",
                qualified(table, &Driver::Mysql)
            ))
            .fetch_one(p)
            .await
            .map_err(err)?;
            let ddl: String = row.try_get(1).map_err(err)?;
            Ok(format!("{ddl};"))
        }
        Pool::Lite(p) => {
            let statements: Vec<String> = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type = 'table' DESC, type = 'view' DESC, name")
                .bind(&table.name).fetch_all(p).await.map_err(err)?;
            if statements.is_empty() {
                return Err("Table not found".into());
            }
            Ok(statements
                .iter()
                .map(|sql| format!("{sql};"))
                .collect::<Vec<_>>()
                .join("\n\n"))
        }
    }
}
#[tauri::command]
pub(crate) async fn dbde_table_ddl(
    connection_id: String,
    database: Option<String>,
    table: TableInfo,
    without_foreign_keys: Option<bool>,
    state: State<'_, AppState>,
) -> DbResult<String> {
    timed(async {
        let conn = database_connection(&state, &connection_id, database.as_deref()).await?;
        table_ddl(&conn, &table, without_foreign_keys.unwrap_or(false)).await
    })
    .await
}
// The webview never chooses a path: Rust shows the native save dialog and writes the file
// only where the user picked, so a compromised page cannot write anywhere it likes.
#[tauri::command]
pub(crate) async fn dbde_save_file(
    app: tauri::AppHandle,
    default_name: String,
    extension: String,
    contents: String,
) -> DbResult<Option<String>> {
    if default_name.contains(['/', '\\']) || default_name.len() > 200 {
        return Err("Invalid file name".into());
    }
    if !["csv", "sql", "json", "txt"].contains(&extension.as_str()) {
        return Err("Unsupported file type".into());
    }
    if contents.len() > 512 * 1024 * 1024 {
        return Err("The file exceeds 512 MB".into());
    }
    let picked = tokio::task::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_file_name(&default_name)
            .add_filter(extension.to_uppercase(), &[extension.as_str()])
            .blocking_save_file()
    })
    .await
    .map_err(err)?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let path = path.into_path().map_err(err)?;
    tokio::fs::write(&path, contents).await.map_err(err)?;
    Ok(Some(path.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn sqlite() -> Connection {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        Connection {
            tunnel: None,
            pool: Pool::Lite(pool),
            config: super::super::tests::config(Driver::Sqlite),
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    fn table(name: &str) -> TableInfo {
        TableInfo {
            name: name.into(),
            schema: "".into(),
            kind: "table".into(),
        }
    }
    #[tokio::test]
    async fn sqlite_indexes_and_ddl_describe_the_table() {
        let conn = sqlite().await;
        query(
            &conn.pool,
            "CREATE TABLE people (id INTEGER, email TEXT UNIQUE, name TEXT, PRIMARY KEY (id))",
        )
        .await
        .unwrap();
        query(
            &conn.pool,
            "CREATE INDEX people_name ON people (name, email)",
        )
        .await
        .unwrap();
        let indexes = list_indexes(&conn, &table("people")).await.unwrap();
        let named = indexes.iter().find(|i| i.name == "people_name").unwrap();
        assert_eq!(named.columns, vec!["name", "email"]);
        assert!(!named.unique && !named.primary);
        assert!(indexes.iter().any(|i| i.unique && i.columns == ["email"]));
        let ddl = table_ddl(&conn, &table("people"), false).await.unwrap();
        assert!(ddl.starts_with("CREATE TABLE people"));
        assert!(ddl.contains("CREATE INDEX people_name ON people (name, email);"));
        assert!(table_ddl(&conn, &table("missing"), false).await.is_err());
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_PG_URL; creates only session-local temporary tables"]
    async fn postgres_ddl_and_indexes_come_from_the_catalog() {
        let url = std::env::var("DBDE_TEST_PG_URL").unwrap();
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&url)
            .await
            .unwrap();
        let mut conn = sqlite().await;
        conn.pool = Pool::Pg(pool);
        conn.config.driver = Driver::Postgres;
        raw_pool_query(&conn.pool, "CREATE TEMPORARY TABLE ddl_test (id serial PRIMARY KEY, mood text NOT NULL DEFAULT 'ok', tags text[]); CREATE INDEX ddl_mood ON ddl_test (lower(mood))").await.unwrap();
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
        let t = TableInfo {
            name: "ddl_test".into(),
            schema,
            kind: "table".into(),
        };
        let ddl = table_ddl(&conn, &t, false).await.unwrap();
        assert!(
            ddl.contains("mood text NOT NULL DEFAULT 'ok'::text"),
            "{ddl}"
        );
        assert!(ddl.contains("tags text[]"), "{ddl}");
        assert!(ddl.contains("PRIMARY KEY (id)"), "{ddl}");
        assert!(ddl.contains("CREATE INDEX ddl_mood"), "{ddl}");
        let indexes = list_indexes(&conn, &t).await.unwrap();
        assert!(indexes[0].primary);
        assert!(indexes.iter().any(|i| i.columns == ["lower(mood)"]));
    }
}
