use super::*;

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct ConnectionOptions {
    pub custom_database_list: bool,
    pub database_list: Vec<DatabaseEntry>,
    pub ssh: crate::ssh_tunnel::SshOptions,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connect_timeout_secs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_timeout_secs: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_limit: Option<usize>,
    pub charset: String,
    pub socket_path: String,
    pub ssl_ca: String,
    pub ssl_cert: String,
    pub ssl_key: String,
    pub initial_queries: String,
    pub auto_connect: bool,
    pub remarks: String,
}
#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct DatabaseEntry {
    pub name: String,
    #[serde(default)]
    pub auto_open: bool,
}
impl ConnectionOptions {
    pub fn timeout(&self) -> Duration {
        Duration::from_secs(self.connect_timeout_secs.unwrap_or(10))
    }
    pub fn validate(&self, config: &ConnectionConfig) -> DbResult<()> {
        if self.custom_database_list {
            let mut names = std::collections::HashSet::new();
            if matches!(config.driver, Driver::Sqlite)
                || self.database_list.is_empty()
                || self.database_list.len() > 256
            {
                return Err("Select 1–256 databases for the custom database list.".into());
            }
            for entry in &self.database_list {
                if entry.name.trim().is_empty()
                    || entry.name.chars().count() > 256
                    || entry.name.contains('\0')
                    || !names.insert(entry.name.trim())
                {
                    return Err("Custom database names must be nonempty and unique.".into());
                }
            }
        }
        self.ssh.validate(config)?;
        if !matches!(self.connect_timeout_secs, None | Some(1..=30)) {
            return Err("Connection timeout must be 1–30 seconds.".into());
        }
        if self
            .query_timeout_secs
            .is_some_and(|n| n == 0 || n > MAX_QUERY_TIMEOUT_SECS)
        {
            return Err("Query timeout must be 1–3600 seconds.".into());
        }
        if !matches!(self.session_limit, None | Some(1..=MAX_SESSIONS)) {
            return Err("Query session limit must be 1–16.".into());
        }
        if !["", "utf8mb4", "utf8", "latin1", "ascii"].contains(&self.charset.as_str()) {
            return Err("Unsupported client character set.".into());
        }
        if !self.socket_path.is_empty() && !matches!(config.driver, Driver::Mysql) {
            return Err("Socket files are supported for MySQL/MariaDB connections.".into());
        }
        if config.ssl_mode != "disable" && (self.ssl_cert.is_empty() != self.ssl_key.is_empty()) {
            return Err("Provide both the client certificate and client key.".into());
        }
        if self.initial_queries.len() > 128_000 || self.remarks.len() > 16_000 {
            return Err("Connection notes or initial queries are too long.".into());
        }
        Ok(())
    }
}
pub(crate) fn pg_pool(config: &ConnectionConfig) -> sqlx::postgres::PgPoolOptions {
    let initial = config.options.initial_queries.clone();
    sqlx::postgres::PgPoolOptions::new()
        .max_connections(3)
        .min_connections(0)
        .acquire_timeout(config.options.timeout())
        .idle_timeout(Duration::from_secs(60))
        .after_connect(move |conn, _| {
            let initial = initial.clone();
            Box::pin(async move {
                if !initial.trim().is_empty() {
                    conn.execute(initial.as_str()).await?;
                }
                Ok(())
            })
        })
}
pub(crate) fn my_pool(config: &ConnectionConfig) -> sqlx::mysql::MySqlPoolOptions {
    let initial = config.options.initial_queries.clone();
    sqlx::mysql::MySqlPoolOptions::new()
        .max_connections(3)
        .min_connections(0)
        .acquire_timeout(config.options.timeout())
        .idle_timeout(Duration::from_secs(60))
        .after_connect(move |conn, _| {
            let initial = initial.clone();
            Box::pin(async move {
                if !initial.trim().is_empty() {
                    conn.execute(initial.as_str()).await?;
                }
                Ok(())
            })
        })
}
pub(crate) fn lite_pool(config: &ConnectionConfig) -> sqlx::sqlite::SqlitePoolOptions {
    let initial = config.options.initial_queries.clone();
    sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .acquire_timeout(config.options.timeout())
        .after_connect(move |conn, _| {
            let initial = initial.clone();
            Box::pin(async move {
                if !initial.trim().is_empty() {
                    conn.execute(initial.as_str()).await?;
                }
                Ok(())
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn older_profiles_default_and_invalid_settings_are_rejected() {
        let config = crate::tests::config(Driver::Mysql);
        let mut stored = serde_json::to_value(&config).unwrap();
        stored.as_object_mut().unwrap().remove("options");
        let mut restored: ConnectionConfig = serde_json::from_value(stored).unwrap();
        assert_eq!(restored.options.timeout(), Duration::from_secs(10));
        assert!(serde_json::to_value(&restored.options)
            .unwrap()
            .get("query_timeout_secs")
            .is_none());
        assert!(validate(&restored).is_ok());
        restored.options.session_limit = Some(17);
        assert!(validate(&restored).is_err());
        restored.options.session_limit = Some(1);
        restored.options.query_timeout_secs = Some(0);
        assert!(validate(&restored).is_err());
        restored.options.query_timeout_secs = Some(60);
        restored.options.ssl_cert = "/client.pem".into();
        assert!(validate(&restored).is_err());
        restored.options.ssl_key = "/client.key".into();
        assert!(validate(&restored).is_ok());
    }
    #[test]
    fn custom_databases_validate_and_round_trip_auto_open_preferences() {
        let mut config = crate::tests::config(Driver::Mysql);
        config.options.custom_database_list = true;
        assert!(validate(&config).is_err());
        config.options.database_list = vec![
            DatabaseEntry {
                name: "app".into(),
                auto_open: true,
            },
            DatabaseEntry {
                name: "analytics".into(),
                auto_open: false,
            },
        ];
        assert!(validate(&config).is_ok());
        let restored: ConnectionConfig =
            serde_json::from_value(serde_json::to_value(&config).unwrap()).unwrap();
        assert!(restored.options.custom_database_list);
        assert!(restored.options.database_list[0].auto_open);
        assert!(!restored.options.database_list[1].auto_open);
        config.options.database_list[1].name = "app".into();
        assert!(validate(&config).is_err());
        config.options.database_list[1].name = "".into();
        assert!(validate(&config).is_err());
    }
    #[tokio::test]
    async fn initial_queries_apply_to_new_physical_connections() {
        let mut config = crate::tests::config(Driver::Sqlite);
        config.options.initial_queries =
            "PRAGMA cache_size = 777; PRAGMA foreign_keys = ON;".into();
        let pool = lite_pool(&config).connect("sqlite::memory:").await.unwrap();
        let result: i64 = sqlx::query_scalar("PRAGMA cache_size")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(result, 777);
        pool.close().await;
    }
}
