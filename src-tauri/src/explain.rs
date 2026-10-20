//! Query plans (Navicat's "Explain"). The statement is validated and wrapped here so the
//! webview can only ask for a plan, never smuggle a second statement past EXPLAIN, and so
//! ANALYZE of a write always runs inside a transaction that is rolled back.
use super::*;

/// Blanks comments, string literals and quoted identifiers so keyword and `;` checks
/// only see SQL structure. The result is for inspection, not for running.
pub(crate) fn mask_sql(sql: &str, driver: &Driver) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let mut out = String::with_capacity(sql.len());
    let mut i = 0;
    let mysql = matches!(driver, Driver::Mysql);
    while i < chars.len() {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        let blank_until = |end: usize, out: &mut String| {
            out.extend(std::iter::repeat_n(' ', end - i));
            end
        };
        if (c == '-' && next == Some('-')) || (mysql && c == '#') {
            let end = (i..chars.len())
                .find(|&j| chars[j] == '\n')
                .unwrap_or(chars.len());
            i = blank_until(end, &mut out);
        } else if c == '/' && next == Some('*') {
            let end = (i + 2..chars.len().saturating_sub(1))
                .find(|&j| chars[j] == '*' && chars[j + 1] == '/')
                .map_or(chars.len(), |j| j + 2);
            i = blank_until(end, &mut out);
        } else if c == '\''
            || c == '"'
            || (c == '`' && !matches!(driver, Driver::Postgres))
            || (c == '[' && matches!(driver, Driver::Sqlite))
        {
            let close = if c == '[' { ']' } else { c };
            let backslash = mysql && c != '`';
            let mut j = i + 1;
            while j < chars.len() {
                if backslash && chars[j] == '\\' {
                    j += 2;
                    continue;
                }
                if chars[j] == close {
                    if close != ']' && chars.get(j + 1) == Some(&close) {
                        j += 2;
                        continue;
                    }
                    break;
                }
                j += 1;
            }
            let end = (j + 1).min(chars.len());
            i = blank_until(end, &mut out);
        } else if c == '$' && matches!(driver, Driver::Postgres) {
            // Dollar quotes: $$…$$ or $tag$…$tag$. $1 is a parameter, not a quote.
            let tag_end = (i + 1..chars.len())
                .find(|&j| !(chars[j].is_alphanumeric() || chars[j] == '_'))
                .unwrap_or(chars.len());
            let starts_tag = next.is_none_or(|n| !n.is_ascii_digit());
            if starts_tag && chars.get(tag_end) == Some(&'$') {
                let tag: String = chars[i..=tag_end].iter().collect();
                let body: String = chars[tag_end + 1..].iter().collect();
                let end = body.find(&tag).map_or(chars.len(), |pos| {
                    tag_end + 1 + body[..pos].chars().count() + tag.chars().count()
                });
                i = blank_until(end, &mut out);
            } else {
                out.push(c);
                i += 1;
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}
fn words(masked: &str) -> impl Iterator<Item = String> + '_ {
    masked
        .split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '$'))
        .filter(|w| !w.is_empty())
        .map(str::to_ascii_uppercase)
}
/// The leading keyword, skipping opening parentheses of `(SELECT …) UNION …`.
fn first_keyword(masked: &str) -> String {
    let rest = masked.trim_start_matches(|c: char| c.is_whitespace() || c == '(');
    rest.chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_uppercase()
}
/// A statement that changes nothing when executed: SELECT/WITH/VALUES/TABLE without any
/// data-changing keyword (data-modifying CTEs, SELECT … INTO, FOR UPDATE locks).
pub(crate) fn is_read_only(statement: &str, driver: &Driver) -> bool {
    // REPLACE() is also a string function, so only a leading REPLACE (not listed) is a write.
    let masked = mask_sql(statement, driver);
    ["SELECT", "WITH", "VALUES", "TABLE"].contains(&first_keyword(&masked).as_str())
        && !words(&masked)
            .any(|w| ["INSERT", "UPDATE", "DELETE", "MERGE", "INTO"].contains(&w.as_str()))
}
/// Trims the statement and its trailing semicolons, and rejects anything but exactly one
/// explainable statement. EXPLAIN itself never runs these statements; only ANALYZE does.
pub(crate) fn explainable(statement: &str, driver: &Driver) -> DbResult<String> {
    let mut text = statement.trim();
    while let Some(rest) = text.strip_suffix(';') {
        text = rest.trim_end();
    }
    if text.is_empty() {
        return Err("There is no statement to explain.".into());
    }
    if text.len() > 1_000_000 {
        return Err("Query exceeds the 1 MB limit".into());
    }
    let masked = mask_sql(text, driver);
    if masked.contains(';') {
        return Err("Explain one statement at a time. Select a single statement or place the cursor inside it.".into());
    }
    let keyword = first_keyword(&masked);
    let allowed: &[&str] = match driver {
        Driver::Postgres => &[
            "SELECT", "WITH", "VALUES", "TABLE", "INSERT", "UPDATE", "DELETE", "MERGE",
        ],
        Driver::Mysql => &[
            "SELECT", "WITH", "VALUES", "TABLE", "INSERT", "UPDATE", "DELETE", "REPLACE",
        ],
        Driver::Sqlite => &[
            "SELECT", "WITH", "VALUES", "INSERT", "UPDATE", "DELETE", "REPLACE",
        ],
    };
    if ["EXPLAIN", "ANALYZE", "DESCRIBE", "DESC"].contains(&keyword.as_str()) {
        return Err("Remove EXPLAIN/ANALYZE from the statement; DBde adds it.".into());
    }
    if !allowed.contains(&keyword.as_str()) {
        return Err(format!(
            "Only {} statements can be explained.",
            allowed.join(", ")
        ));
    }
    Ok(text.into())
}
#[derive(Clone, Copy, PartialEq, Debug)]
pub(crate) enum PlanKind {
    PgJson,
    PgAnalyze,
    MyTable,
    MyJson,
    MariaAnalyze,
    MyAnalyzeTree,
    LiteQueryPlan,
}
pub(crate) fn explain_sql(kind: PlanKind, statement: &str) -> String {
    let prefix = match kind {
        PlanKind::PgJson => "EXPLAIN (FORMAT JSON)",
        PlanKind::PgAnalyze => "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)",
        PlanKind::MyTable => "EXPLAIN",
        PlanKind::MyJson => "EXPLAIN FORMAT=JSON",
        PlanKind::MariaAnalyze => "ANALYZE FORMAT=JSON",
        PlanKind::MyAnalyzeTree => "EXPLAIN ANALYZE",
        PlanKind::LiteQueryPlan => "EXPLAIN QUERY PLAN",
    };
    format!("{prefix} {statement}")
}
/// Parses "8.0.36-0ubuntu…" / "10.4.28-MariaDB" into (major, minor, patch).
pub(crate) fn server_version(text: &str) -> (u32, u32, u32) {
    let mut parts = text
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .map(|s| s.parse().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}
/// The MySQL statement used for ANALYZE, or why this server cannot analyze.
pub(crate) fn mysql_analyze_kind(version: &str) -> DbResult<PlanKind> {
    if version.to_ascii_lowercase().contains("mariadb") {
        // MariaDB has had ANALYZE FORMAT=JSON since 10.1.
        return if server_version(version) >= (10, 1, 0) {
            Ok(PlanKind::MariaAnalyze)
        } else {
            Err("ANALYZE needs MariaDB 10.1 or later.".into())
        };
    }
    if server_version(version) >= (8, 0, 18) {
        Ok(PlanKind::MyAnalyzeTree)
    } else {
        Err("EXPLAIN ANALYZE needs MySQL 8.0.18 or later.".into())
    }
}
#[derive(Serialize, Debug)]
pub(crate) struct ExplainOutput {
    /// "json" (raw holds the plan document), "tree" (raw holds MySQL's text tree) or
    /// "table" (columns/rows hold the plan).
    format: &'static str,
    /// The EXPLAIN statement whose output is reported.
    sql: String,
    raw: String,
    /// Tabular plan: MySQL's classic EXPLAIN or SQLite's EXPLAIN QUERY PLAN.
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    analyzed: bool,
    /// ANALYZE ran inside a transaction (or savepoint) that was rolled back.
    rolled_back: bool,
    server_version: String,
    execution_ms: f64,
}
// MySQL text documents and PostgreSQL json values both arrive in the first cell.
fn first_text(result: &QueryResult) -> String {
    match result.rows.first().and_then(|row| row.first()) {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Null) | None => String::new(),
        Some(value) => serde_json::to_string_pretty(value).unwrap_or_default(),
    }
}
async fn run(conn: &Connection, session_id: Option<&str>, sql: &str) -> DbResult<QueryResult> {
    match session_id {
        Some(id) if !matches!(conn.pool, Pool::Lite(_)) => session_query(conn, id, sql).await,
        _ => raw_pool_query(&conn.pool, sql).await,
    }
}
pub(crate) async fn explain(
    conn: &Connection,
    session_id: Option<&str>,
    statement: &str,
    analyze: bool,
    allow_write: bool,
) -> DbResult<ExplainOutput> {
    let driver = conn.config.driver.clone();
    let statement = explainable(statement, &driver)?;
    let read_only = is_read_only(&statement, &driver);
    let start = Instant::now();
    let mut output = ExplainOutput {
        format: "json",
        sql: String::new(),
        raw: String::new(),
        columns: Vec::new(),
        rows: Vec::new(),
        analyzed: analyze,
        rolled_back: false,
        server_version: String::new(),
        execution_ms: 0.0,
    };
    match driver {
        Driver::Postgres => {
            if !analyze {
                output.sql = explain_sql(PlanKind::PgJson, &statement);
                output.raw = first_text(&run(conn, session_id, &output.sql).await?);
            } else {
                if !read_only && !allow_write {
                    return Err("EXPLAIN ANALYZE executes this statement. Confirm to run it inside a transaction that is rolled back.".into());
                }
                let Some(session_id) = session_id else {
                    return Err("EXPLAIN ANALYZE needs a query tab session.".into());
                };
                output.sql = explain_sql(PlanKind::PgAnalyze, &statement);
                // An open transaction must survive: undo only our work with a savepoint.
                let state = session_query(
                    conn,
                    session_id,
                    "SELECT transaction_timestamp() <> statement_timestamp()",
                )
                .await
                .map_err(|e| {
                    format!("Cannot inspect this tab's transaction ({e}). Run ROLLBACK first.")
                })?;
                let in_transaction =
                    state.rows.first().and_then(|r| r.first()) == Some(&json!(true));
                // Undo statements run one per call: a script without rows is described
                // afterwards, and a multi-statement Parse error would abort the transaction.
                let (script, undo): (String, &[&str]) = if in_transaction {
                    (
                        format!("SAVEPOINT dbde_explain; {}; ROLLBACK TO SAVEPOINT dbde_explain; RELEASE SAVEPOINT dbde_explain", output.sql),
                        &["ROLLBACK TO SAVEPOINT dbde_explain", "RELEASE SAVEPOINT dbde_explain"],
                    )
                } else {
                    (format!("BEGIN; {}; ROLLBACK", output.sql), &["ROLLBACK"])
                };
                match session_query(conn, session_id, &script).await {
                    Ok(result) => output.raw = first_text(&result),
                    Err(e) => {
                        // The failed statement left the block aborted; undo before reporting.
                        for statement in undo {
                            let _ = session_query(conn, session_id, statement).await;
                        }
                        return Err(e);
                    }
                }
                output.rolled_back = true;
            }
        }
        Driver::Mysql => {
            let version = run(conn, session_id, "SELECT VERSION()").await?;
            output.server_version = first_text(&version);
            if analyze {
                if !read_only {
                    return Err("ANALYZE is limited to SELECT on MySQL/MariaDB: writes cannot be reliably rolled back (DDL and non-transactional engines commit implicitly).".into());
                }
                let kind = mysql_analyze_kind(&output.server_version)?;
                output.sql = explain_sql(kind, &statement);
                output.raw = first_text(&run(conn, session_id, &output.sql).await?);
                output.format = if kind == PlanKind::MyAnalyzeTree {
                    "tree"
                } else {
                    "json"
                };
            } else {
                let table_sql = explain_sql(PlanKind::MyTable, &statement);
                let table = run(conn, session_id, &table_sql).await?;
                output.columns = table.columns;
                output.rows = table.rows;
                output.sql = explain_sql(PlanKind::MyJson, &statement);
                // FORMAT=JSON exists from MySQL 5.6 and MariaDB 10.1; older servers keep the grid.
                match run(conn, session_id, &output.sql).await {
                    Ok(json) => output.raw = first_text(&json),
                    Err(_) => {
                        output.sql = table_sql;
                        output.format = "table";
                    }
                }
            }
        }
        Driver::Sqlite => {
            if analyze {
                return Err(
                    "SQLite has no EXPLAIN ANALYZE; showing the query plan needs no option.".into(),
                );
            }
            output.sql = explain_sql(PlanKind::LiteQueryPlan, &statement);
            let plan = run(conn, None, &output.sql).await?;
            output.format = "table";
            output.columns = plan.columns;
            output.rows = plan.rows;
        }
    }
    output.execution_ms = start.elapsed().as_secs_f64() * 1000.0;
    Ok(output)
}
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub(crate) async fn dbde_explain_query(
    connection_id: String,
    query: String,
    database: Option<String>,
    session_id: Option<String>,
    analyze: Option<bool>,
    allow_write: Option<bool>,
    timeout_secs: Option<u64>,
    state: State<'_, AppState>,
) -> DbResult<ExplainOutput> {
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
    let work = explain(
        &conn,
        session_id.as_deref(),
        &query,
        analyze.unwrap_or(false),
        allow_write.unwrap_or(false),
    );
    match tokio::time::timeout(Duration::from_secs(seconds), work).await {
        Ok(result) => result,
        Err(_) => {
            // Same recovery as the editor: cancel on the server; the dropped session
            // connection rolls back anything ANALYZE started.
            if let Some(session_id) = &session_id {
                if let Some(slot) = session_slot(&conn, session_id).await {
                    let server_id = slot.server_id.lock().ok().and_then(|mut id| id.take());
                    if let Some(server_id) = server_id {
                        let _ = timed(cancel_server_query(&conn, server_id)).await;
                    }
                }
            }
            Err(format!("Explain timed out after {seconds} seconds and was cancelled. This tab's session was reset, so any open transaction was rolled back."))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn lite() -> Connection {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        Connection {
            tunnel: None,
            pool: Pool::Lite(pool),
            config: crate::tests::config(Driver::Sqlite),
            databases: Arc::new(Mutex::new(HashMap::new())),
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }
    #[test]
    fn masks_comments_strings_and_dollar_quotes() {
        let pg = Driver::Postgres;
        assert_eq!(
            mask_sql("SELECT ';' -- ;\n, $$;$$, $tag$ ; $tag$, $1", &pg)
                .matches(';')
                .count(),
            0
        );
        assert!(mask_sql("SELECT `a;b`, 'it\\'s;' # ;", &Driver::Mysql)
            .chars()
            .all(|c| c != ';'));
        assert!(!mask_sql("SELECT [a;b] /* ; */", &Driver::Sqlite).contains(';'));
        assert!(mask_sql("SELECT 1; SELECT 2", &pg).contains(';'));
    }
    #[test]
    fn accepts_exactly_one_explainable_statement() {
        let pg = Driver::Postgres;
        assert_eq!(
            explainable("  SELECT ';' FROM t;;  \n", &pg).unwrap(),
            "SELECT ';' FROM t"
        );
        assert!(explainable("SELECT 1; DELETE FROM t", &pg)
            .unwrap_err()
            .contains("one statement"));
        assert!(explainable("EXPLAIN SELECT 1", &pg).is_err());
        assert!(explainable("ANALYZE DELETE FROM t", &Driver::Mysql).is_err());
        assert!(explainable("DROP TABLE t", &pg).is_err());
        assert!(explainable("CALL p()", &Driver::Mysql).is_err());
        assert!(explainable("customers", &Driver::Mysql).is_err());
        assert!(explainable("(SELECT 1) UNION (SELECT 2)", &pg).is_ok());
        assert!(explainable("MERGE INTO t USING s ON true WHEN MATCHED THEN DELETE", &pg).is_ok());
        assert!(explainable("REPLACE INTO t VALUES (1)", &Driver::Mysql).is_ok());
        assert!(explainable(" ;; ", &pg).is_err());
    }
    #[test]
    fn read_only_detection_is_conservative() {
        let pg = Driver::Postgres;
        assert!(is_read_only(
            "SELECT replace(name, 'a', 'b') FROM t WHERE note = 'DELETE'",
            &pg
        ));
        assert!(is_read_only("WITH x AS (SELECT 1) SELECT * FROM x", &pg));
        assert!(!is_read_only(
            "WITH gone AS (DELETE FROM t RETURNING *) SELECT * FROM gone",
            &pg
        ));
        assert!(!is_read_only("SELECT * INTO copy FROM t", &pg));
        assert!(!is_read_only("SELECT * FROM t FOR UPDATE", &pg));
        assert!(!is_read_only("UPDATE t SET x = 1", &pg));
        assert!(!is_read_only(
            "SELECT 1 INTO OUTFILE '/tmp/x'",
            &Driver::Mysql
        ));
        assert!(is_read_only("SELECT \"delete\" FROM t", &pg));
    }
    #[test]
    fn builds_driver_specific_explain_sql() {
        assert_eq!(
            explain_sql(PlanKind::PgJson, "SELECT 1"),
            "EXPLAIN (FORMAT JSON) SELECT 1"
        );
        assert_eq!(
            explain_sql(PlanKind::PgAnalyze, "SELECT 1"),
            "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1"
        );
        assert_eq!(
            explain_sql(PlanKind::MyJson, "SELECT 1"),
            "EXPLAIN FORMAT=JSON SELECT 1"
        );
        assert_eq!(
            explain_sql(PlanKind::LiteQueryPlan, "SELECT 1"),
            "EXPLAIN QUERY PLAN SELECT 1"
        );
        assert_eq!(
            mysql_analyze_kind("10.4.28-MariaDB"),
            Ok(PlanKind::MariaAnalyze)
        );
        assert_eq!(mysql_analyze_kind("8.0.18"), Ok(PlanKind::MyAnalyzeTree));
        assert_eq!(
            mysql_analyze_kind("8.4.2-commercial"),
            Ok(PlanKind::MyAnalyzeTree)
        );
        assert!(mysql_analyze_kind("8.0.17").is_err());
        assert!(mysql_analyze_kind("5.7.44-log").is_err());
        assert!(mysql_analyze_kind("10.0.38-MariaDB").is_err());
    }
    #[tokio::test]
    async fn sqlite_query_plan_never_runs_the_statement() {
        let conn = lite().await;
        raw_pool_query(&conn.pool, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); CREATE INDEX t_name ON t(name); INSERT INTO t VALUES (1, 'a')")
            .await
            .unwrap();
        let plan = explain(
            &conn,
            None,
            "SELECT * FROM t WHERE name = 'a';",
            false,
            false,
        )
        .await
        .unwrap();
        assert_eq!(plan.format, "table");
        assert_eq!(plan.columns, vec!["id", "parent", "notused", "detail"]);
        assert!(plan.rows[0][3].as_str().unwrap().contains("USING"));
        let delete = explain(&conn, None, "DELETE FROM t WHERE name = 'a'", false, false)
            .await
            .unwrap();
        assert!(!delete.rows.is_empty());
        let left = query(&conn.pool, "SELECT COUNT(*) FROM t").await.unwrap();
        assert_eq!(left.rows, vec![vec![json!(1)]]);
        assert!(explain(&conn, None, "SELECT 1", true, false).await.is_err());
        assert!(
            explain(&conn, None, "DELETE FROM t; SELECT 1", false, false)
                .await
                .is_err()
        );
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_PG_URL; creates only session-local temporary tables"]
    async fn postgres_explain_and_analyze_roll_back_writes() {
        let conn = crate::tests::server_connection("DBDE_TEST_PG_URL", Driver::Postgres).await;
        session_query(&conn, "tab", "CREATE TEMPORARY TABLE dbde_plan (id int primary key, n int); INSERT INTO dbde_plan SELECT g, g FROM generate_series(1, 100) g")
            .await
            .unwrap();
        let plain = explain(
            &conn,
            Some("tab"),
            "SELECT * FROM dbde_plan WHERE n > 5",
            false,
            false,
        )
        .await
        .unwrap();
        let doc: Value = serde_json::from_str(&plain.raw).unwrap();
        assert_eq!(doc[0]["Plan"]["Node Type"], "Seq Scan");
        assert!(
            explain(&conn, Some("tab"), "DELETE FROM dbde_plan", true, false)
                .await
                .is_err()
        );
        let analyzed = explain(&conn, Some("tab"), "DELETE FROM dbde_plan", true, true)
            .await
            .unwrap();
        assert!(analyzed.rolled_back);
        let doc: Value = serde_json::from_str(&analyzed.raw).unwrap();
        assert!(doc[0]["Execution Time"].is_number());
        let count = "SELECT COUNT(*) FROM dbde_plan";
        assert_eq!(
            session_query(&conn, "tab", count).await.unwrap().rows,
            vec![vec![json!(100)]]
        );
        // Inside the user's own transaction only the savepoint is undone.
        session_query(&conn, "tab", "BEGIN").await.unwrap();
        session_query(&conn, "tab", "DELETE FROM dbde_plan WHERE id = 1")
            .await
            .unwrap();
        explain(&conn, Some("tab"), "UPDATE dbde_plan SET n = 0", true, true)
            .await
            .unwrap();
        assert!(explain(
            &conn,
            Some("tab"),
            "UPDATE dbde_plan SET n = 1 / 0",
            true,
            true
        )
        .await
        .is_err());
        assert_eq!(
            session_query(&conn, "tab", count).await.unwrap().rows,
            vec![vec![json!(99)]]
        );
        assert_eq!(
            session_query(&conn, "tab", "SELECT COUNT(*) FROM dbde_plan WHERE n = 0")
                .await
                .unwrap()
                .rows,
            vec![vec![json!(0)]]
        );
        session_query(&conn, "tab", "ROLLBACK").await.unwrap();
        assert_eq!(
            session_query(&conn, "tab", count).await.unwrap().rows,
            vec![vec![json!(100)]]
        );
    }
    #[tokio::test]
    #[ignore = "Requires DBDE_TEST_MYSQL_URL; creates only session-local temporary tables"]
    async fn mysql_explain_formats_and_refuses_write_analyze() {
        let conn = crate::tests::server_connection("DBDE_TEST_MYSQL_URL", Driver::Mysql).await;
        session_query(&conn, "tab", "CREATE TEMPORARY TABLE dbde_plan (id int primary key, n int); INSERT INTO dbde_plan VALUES (1, 1), (2, 2)")
            .await
            .unwrap();
        let plain = explain(
            &conn,
            Some("tab"),
            "SELECT * FROM dbde_plan WHERE n > 1",
            false,
            false,
        )
        .await
        .unwrap();
        assert_eq!(plain.format, "json");
        assert!(plain.raw.contains("query_block"));
        assert!(plain.columns.iter().any(|c| c == "type"));
        let analyzed = explain(
            &conn,
            Some("tab"),
            "SELECT * FROM dbde_plan WHERE n > 1",
            true,
            false,
        )
        .await
        .unwrap();
        assert!(analyzed.raw.contains("r_rows") || analyzed.format == "tree");
        assert!(
            explain(&conn, Some("tab"), "DELETE FROM dbde_plan", true, true)
                .await
                .unwrap_err()
                .contains("limited to SELECT")
        );
        explain(&conn, Some("tab"), "DELETE FROM dbde_plan", false, false)
            .await
            .unwrap();
        assert_eq!(
            session_query(&conn, "tab", "SELECT COUNT(*) FROM dbde_plan")
                .await
                .unwrap()
                .rows,
            vec![vec![json!(2)]]
        );
    }
}
