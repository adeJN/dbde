use super::*;

async fn execute_plan(pool: &Pool, statements: &[String]) -> DbResult<()> {
    if statements.is_empty()
        || statements.len() > 400
        || statements.iter().map(String::len).sum::<usize>() > 1_000_000
    {
        return Err("Invalid table creation plan".into());
    }
    if !statements[0].starts_with("CREATE TABLE ")
        || statements.iter().skip(1).any(|sql| {
            ![
                "CREATE INDEX ",
                "CREATE UNIQUE INDEX ",
                "COMMENT ON TABLE ",
                "COMMENT ON COLUMN ",
            ]
            .iter()
            .any(|prefix| sql.starts_with(prefix))
        })
    {
        return Err("The table creation plan contains an unsupported statement".into());
    }
    match pool {
        // MySQL DDL implicitly commits: all fields, indexes and constraints must
        // belong to a single CREATE TABLE so no partial follow-up work is possible.
        Pool::My(pool) => {
            if statements.len() != 1 {
                return Err("MySQL table creation must use one statement".into());
            }
            sqlx::query(&statements[0])
                .execute(pool)
                .await
                .map_err(err)?;
        }
        Pool::Pg(pool) => {
            let mut tx = pool.begin().await.map_err(err)?;
            for statement in statements {
                sqlx::query(statement)
                    .execute(&mut *tx)
                    .await
                    .map_err(err)?;
            }
            tx.commit().await.map_err(err)?;
        }
        Pool::Lite(pool) => {
            let mut tx = pool.begin().await.map_err(err)?;
            for statement in statements {
                sqlx::query(statement)
                    .execute(&mut *tx)
                    .await
                    .map_err(err)?;
            }
            tx.commit().await.map_err(err)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn dbde_create_table(
    connection_id: String,
    database: String,
    statements: Vec<String>,
    state: State<'_, AppState>,
) -> DbResult<()> {
    timed(async {
        let conn = database_connection(&state, &connection_id, Some(&database)).await?;
        execute_plan(&conn.pool, &statements).await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn designer_creates_atomically_and_never_overwrites() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        let wrapped = Pool::Lite(pool.clone());
        execute_plan(
            &wrapped,
            &[
                "CREATE TABLE records (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);"
                    .into(),
                "CREATE UNIQUE INDEX records_name ON records(name);".into(),
            ],
        )
        .await
        .unwrap();
        sqlx::query("INSERT INTO records(name) VALUES ('Ada')")
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            execute_plan(&wrapped, &["CREATE TABLE records(id INTEGER);".into()])
                .await
                .is_err()
        );
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM records")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
        assert!(execute_plan(
            &wrapped,
            &[
                "CREATE TABLE failed(id INTEGER);".into(),
                "CREATE INDEX invalid ON failed(missing);".into()
            ]
        )
        .await
        .is_err());
        let exists: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name = 'failed'")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(exists, 0);
        assert!(execute_plan(&wrapped, &["DROP TABLE records;".into()])
            .await
            .is_err());
    }
}
