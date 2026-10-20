use super::*;
use russh::{
    client,
    keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKey},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
pub(crate) struct SshOptions {
    pub enabled: bool,
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    pub auth: String,
    pub private_key: String,
    pub fingerprint: String,
    #[serde(skip_serializing)]
    pub password: Option<String>,
}
impl Default for SshOptions {
    fn default() -> Self {
        Self {
            enabled: false,
            host: String::new(),
            port: Some(22),
            username: String::new(),
            auth: "password".into(),
            private_key: String::new(),
            fingerprint: String::new(),
            password: None,
        }
    }
}
impl SshOptions {
    pub fn same_endpoint(&self, other: &Self) -> bool {
        self.enabled == other.enabled
            && (!self.enabled
                || (self.host.trim() == other.host.trim()
                    && self.port.unwrap_or(22) == other.port.unwrap_or(22)
                    && self.username == other.username
                    && self.auth == other.auth
                    && self.private_key == other.private_key
                    && self.fingerprint.trim() == other.fingerprint.trim()))
    }
    pub fn validate(&self, config: &ConnectionConfig) -> DbResult<()> {
        if !self.enabled {
            return Ok(());
        }
        if matches!(config.driver, Driver::Sqlite) {
            return Err("SSH tunnels require MySQL/MariaDB or PostgreSQL.".into());
        }
        if self.host.trim().is_empty() || self.username.trim().is_empty() || self.port == Some(0) {
            return Err("Provide the SSH host, port (1–65535) and username.".into());
        }
        if !["", "password", "private_key"].contains(&self.auth.as_str()) {
            return Err("Unsupported SSH authentication method.".into());
        }
        if self.auth == "private_key" && self.private_key.trim().is_empty() {
            return Err("Provide an absolute path to the SSH private key.".into());
        }
        if self.auth == "private_key" && !std::path::Path::new(&self.private_key).is_absolute() {
            return Err("SSH private key path must be absolute.".into());
        }
        let fp = self.fingerprint.trim();
        if !fp.is_empty()
            && !(fp.starts_with("SHA256:")
                && fp.len() == 50
                && fp[7..]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/'))
        {
            return Err("Use a SHA256 SSH host key fingerprint.".into());
        }
        if !config.options.socket_path.is_empty() {
            return Err("Clear the local MySQL socket path before enabling SSH.".into());
        }
        #[cfg(not(unix))]
        if config.ssl_mode == "verify-full" {
            return Err("SSH with database hostname verification is currently supported on macOS/Linux. Do not weaken SSL settings to bypass this limitation.".into());
        }
        Ok(())
    }
}

struct HostVerifier {
    host: String,
    port: u16,
    fingerprint: String,
}
impl client::Handler for HostVerifier {
    type Error = russh::Error;
    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        if !self.fingerprint.is_empty() {
            return Ok(key.fingerprint(HashAlg::Sha256).to_string() == self.fingerprint);
        }
        Ok(keys::check_known_hosts(&self.host, self.port, key).unwrap_or(false))
    }
}

// Dropping the last owner cancels the listener and all forwarding channels.
// Detached windows share this owner; closing the original window cannot kill their tunnel.
pub(crate) struct Tunnel {
    task: tokio::task::JoinHandle<()>,
    #[cfg(unix)]
    directory: PathBuf,
    #[cfg(unix)]
    socket: PathBuf,
    #[cfg(not(unix))]
    port: u16,
}
impl Drop for Tunnel {
    fn drop(&mut self) {
        self.task.abort();
        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&self.socket);
            let _ = std::fs::remove_dir(&self.directory);
        }
    }
}
impl Tunnel {
    pub fn pg_options(
        &self,
        options: sqlx::postgres::PgConnectOptions,
    ) -> sqlx::postgres::PgConnectOptions {
        #[cfg(unix)]
        {
            options.socket(&self.directory)
        }
        #[cfg(not(unix))]
        {
            options.host("127.0.0.1").port(self.port)
        }
    }
    pub fn my_options(
        &self,
        options: sqlx::mysql::MySqlConnectOptions,
    ) -> sqlx::mysql::MySqlConnectOptions {
        #[cfg(unix)]
        {
            options.socket(&self.socket)
        }
        #[cfg(not(unix))]
        {
            options.host("127.0.0.1").port(self.port)
        }
    }
}

pub(crate) async fn open(
    config: &ConnectionConfig,
    state: &AppState,
) -> DbResult<Option<Arc<Tunnel>>> {
    let ssh = &config.options.ssh;
    if !ssh.enabled {
        return Ok(None);
    }
    ssh.validate(config)?;
    let secret = if let Some(secret) = &ssh.password {
        secret.clone()
    } else {
        if !saved_profile_matches(state, config).await? {
            return Err("Enter the SSH password or key passphrase for this server.".into());
        }
        let id = config.id.clone();
        tokio::task::spawn_blocking(move || {
            match keyring::Entry::new("com.dbde.desktop.ssh", &id)
                .map_err(err)?
                .get_password()
            {
                Ok(secret) => Ok(secret),
                Err(keyring::Error::NoEntry) => Ok(String::new()),
                Err(e) => Err(format!("Cannot read SSH credential vault: {e}")),
            }
        })
        .await
        .map_err(err)??
    };
    let operation = async {
        let handler = HostVerifier {
            host: ssh.host.trim().into(),
            port: ssh.port.unwrap_or(22),
            fingerprint: ssh.fingerprint.trim().into(),
        };
        let settings = client::Config {
            keepalive_interval: Some(Duration::from_secs(30)),
            ..Default::default()
        };
        let mut session = client::connect(Arc::new(settings), (ssh.host.trim(), ssh.port.unwrap_or(22)), handler).await
            .map_err(|e| format!("SSH connection failed: {e}. Verify the server key in ~/.ssh/known_hosts or supply its trusted SHA256 fingerprint."))?;
        let result = if ssh.auth == "private_key" {
            let path = ssh.private_key.clone();
            let passphrase = secret.clone();
            let key = tokio::task::spawn_blocking(move || {
                keys::load_secret_key(
                    path,
                    if passphrase.is_empty() {
                        None
                    } else {
                        Some(&passphrase)
                    },
                )
            })
            .await
            .map_err(err)?
            .map_err(|e| format!("Cannot load SSH private key: {e}"))?;
            let hash = session
                .best_supported_rsa_hash()
                .await
                .map_err(err)?
                .flatten();
            session
                .authenticate_publickey(
                    &ssh.username,
                    PrivateKeyWithHashAlg::new(Arc::new(key), hash),
                )
                .await
                .map_err(err)?
        } else {
            session
                .authenticate_password(&ssh.username, &secret)
                .await
                .map_err(err)?
        };
        if !result.success() {
            return Err(
                "SSH authentication failed. Check the SSH username and password/private key."
                    .into(),
            );
        }
        // Confirm forwarding is allowed and destination is reachable before opening the DB pool.
        let probe = session
            .channel_open_direct_tcpip(&config.host, u32::from(config.port), "127.0.0.1", 0)
            .await
            .map_err(|e| {
                format!("SSH cannot reach the database destination or forwarding is disabled: {e}")
            })?;
        probe.close().await.map_err(err)?;
        #[cfg(unix)]
        let (listener, directory, socket) = {
            use std::os::unix::fs::DirBuilderExt;
            // Keep paths below macOS's 104-byte Unix socket limit, with a private random directory.
            let directory = PathBuf::from("/tmp").join(format!("dbde-{}", uuid::Uuid::new_v4()));
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&directory)
                .map_err(err)?;
            let socket = directory.join(if matches!(config.driver, Driver::Postgres) {
                format!(".s.PGSQL.{}", config.port)
            } else {
                "mysql.sock".into()
            });
            match tokio::net::UnixListener::bind(&socket) {
                Ok(listener) => (listener, directory, socket),
                Err(e) => {
                    let _ = std::fs::remove_dir(&directory);
                    return Err(err(e));
                }
            }
        };
        #[cfg(not(unix))]
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(err)?;
        #[cfg(not(unix))]
        let port = listener.local_addr().map_err(err)?.port();
        let host = config.host.clone();
        let port_target = config.port;
        let task = tokio::spawn(async move {
            let session = Arc::new(session);
            let mut channels = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((mut local, _)) = accepted else { break; };
                        let session = session.clone();
                        let host = host.clone();
                        channels.spawn(async move {
                            let channel = tokio::time::timeout(Duration::from_secs(30), session.channel_open_direct_tcpip(host, u32::from(port_target), "127.0.0.1", 0)).await;
                            if let Ok(Ok(channel)) = channel {
                                let mut remote = channel.into_stream();
                                let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
                            }
                        });
                    }
                    _ = channels.join_next(), if !channels.is_empty() => {}
                }
            }
        });
        Ok(Some(Arc::new(Tunnel {
            task,
            #[cfg(unix)]
            directory,
            #[cfg(unix)]
            socket,
            #[cfg(not(unix))]
            port,
        })))
    };
    tokio::time::timeout(config.options.timeout(), operation)
        .await
        .map_err(|_| "SSH connection timed out.".to_string())?
        .map_err(|e: String| safe_error(e, &secret))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_route_and_never_serializes_secrets() {
        let mut config = crate::tests::config(Driver::Mysql);
        config.options.ssh = SshOptions {
            enabled: true,
            host: "ssh.example.test".into(),
            username: "user".into(),
            password: Some("ssh-secret".into()),
            ..Default::default()
        };
        assert!(validate(&config).is_ok());
        assert!(!serde_json::to_string(&config)
            .unwrap()
            .contains("ssh-secret"));
        let mut changed = config.clone();
        changed.options.ssh.host = "elsewhere".into();
        assert!(!same_server(&config, &changed));
        changed = config.clone();
        changed.options.ssh.fingerprint = "SHA256:bad".into();
        assert!(validate(&changed).is_err());
        changed = config.clone();
        changed.options.socket_path = "/tmp/mysql.sock".into();
        assert!(validate(&changed).is_err());
        changed = config.clone();
        changed.driver = Driver::Sqlite;
        assert!(validate(&changed).is_err());
    }
    #[tokio::test]
    async fn verifies_pinned_keys_and_rejects_mismatch() {
        let key = PublicKey::from_openssh(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJdD7y3aLq454yWBdwLWbieU1ebz9/cu7/QEXn9OIeZJ",
        )
        .unwrap();
        let public = &key;
        let mut handler = HostVerifier {
            host: "unused".into(),
            port: 22,
            fingerprint: public.fingerprint(HashAlg::Sha256).to_string(),
        };
        use russh::client::Handler;
        assert!(handler.check_server_key(public).await.unwrap());
        handler.fingerprint = format!("SHA256:{}", "A".repeat(43));
        assert!(!handler.check_server_key(public).await.unwrap());
    }
    #[cfg(unix)]
    #[derive(Clone)]
    struct EchoServer {
        client_key: PublicKey,
    }
    #[cfg(unix)]
    impl russh::server::Server for EchoServer {
        type Handler = Self;
        fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
            self.clone()
        }
    }
    #[cfg(unix)]
    impl russh::server::Handler for EchoServer {
        type Error = russh::Error;
        async fn auth_password(
            &mut self,
            user: &str,
            password: &str,
        ) -> Result<russh::server::Auth, Self::Error> {
            Ok(if user == "tester" && password == "test-secret" {
                russh::server::Auth::Accept
            } else {
                russh::server::Auth::reject()
            })
        }
        async fn auth_publickey(
            &mut self,
            user: &str,
            key: &PublicKey,
        ) -> Result<russh::server::Auth, Self::Error> {
            Ok(if user == "tester" && key == &self.client_key {
                russh::server::Auth::Accept
            } else {
                russh::server::Auth::reject()
            })
        }
        async fn channel_open_direct_tcpip(
            &mut self,
            channel: russh::Channel<russh::server::Msg>,
            host: &str,
            port: u32,
            _: &str,
            _: u32,
            _: &mut russh::server::Session,
        ) -> Result<bool, Self::Error> {
            if host != "remote-db.internal" || port != 3306 {
                return Ok(false);
            }
            tokio::spawn(async move {
                use tokio::io::{AsyncReadExt, AsyncWriteExt};
                let mut stream = channel.into_stream();
                let mut buffer = [0; 128];
                while let Ok(n) = stream.read(&mut buffer).await {
                    if n == 0 {
                        break;
                    }
                    if stream.write_all(&buffer[..n]).await.is_err() {
                        break;
                    }
                }
            });
            Ok(true)
        }
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn forwards_multiple_channels_with_password_and_key_and_cleans_up() {
        use russh::server::Server;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let host_key =
            keys::PrivateKey::random(&mut rand_core::OsRng, keys::Algorithm::Ed25519).unwrap();
        let client_key =
            keys::PrivateKey::random(&mut rand_core::OsRng, keys::Algorithm::Ed25519).unwrap();
        let fingerprint = host_key
            .public_key()
            .fingerprint(HashAlg::Sha256)
            .to_string();
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut server = EchoServer {
            client_key: client_key.public_key().clone(),
        };
        let settings = Arc::new(russh::server::Config {
            keys: vec![host_key],
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            ..Default::default()
        });
        let server_task = tokio::spawn(async move {
            server.run_on_socket(settings, &listener).await.unwrap();
        });
        let state = AppState {
            connections: Mutex::new(HashMap::new()),
            profiles: Mutex::new(()),
            profile_path: PathBuf::from("/unused"),
        };
        let mut config = crate::tests::config(Driver::Mysql);
        config.host = "remote-db.internal".into();
        config.port = 3306;
        config.options.ssh = SshOptions {
            enabled: true,
            host: "127.0.0.1".into(),
            port: Some(port),
            username: "tester".into(),
            fingerprint,
            password: Some("test-secret".into()),
            ..Default::default()
        };
        let tunnel = open(&config, &state).await.unwrap().unwrap();
        let directory = tunnel.directory.clone();
        let shared = tunnel.clone();
        drop(tunnel); // models moving a tab then closing the original connection
        for message in [b"first".as_slice(), b"second".as_slice()] {
            let mut stream = tokio::net::UnixStream::connect(&shared.socket)
                .await
                .unwrap();
            stream.write_all(message).await.unwrap();
            let mut response = vec![0; message.len()];
            tokio::time::timeout(Duration::from_secs(2), stream.read_exact(&mut response))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(response, message);
        }
        drop(shared);
        assert!(!directory.exists());
        config.options.ssh.password = Some("incorrect".into());
        assert!(open(&config, &state)
            .await
            .err()
            .unwrap()
            .contains("authentication failed"));
        config.options.ssh.password = Some("test-secret".into());
        let correct_fingerprint = config.options.ssh.fingerprint.clone();
        config.options.ssh.fingerprint = format!("SHA256:{}", "A".repeat(43));
        assert!(open(&config, &state).await.is_err());
        config.options.ssh.fingerprint = correct_fingerprint;
        let key_path =
            PathBuf::from("/tmp").join(format!("dbde-test-key-{}", uuid::Uuid::new_v4()));
        let encrypted = client_key
            .encrypt(&mut rand_core::OsRng, "key-passphrase")
            .unwrap();
        std::fs::write(
            &key_path,
            encrypted
                .to_openssh(keys::ssh_key::LineEnding::LF)
                .unwrap()
                .as_bytes(),
        )
        .unwrap();
        config.options.ssh.auth = "private_key".into();
        config.options.ssh.private_key = key_path.to_string_lossy().into();
        config.options.ssh.password = Some("key-passphrase".into());
        let result = open(&config, &state).await;
        std::fs::remove_file(key_path).unwrap();
        assert!(result.is_ok(), "key authentication failed");
        drop(result);
        server_task.abort();
    }
}
