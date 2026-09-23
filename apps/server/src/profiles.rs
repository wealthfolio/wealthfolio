//! Instance authentication owns browser grants; each financial request receives
//! a fixed AppState through extensions. Browser locks do not stop server workers.
use crate::{
    auth::BackupSession,
    config::Config,
    main_lib::{build_profile_state, AppState},
};
use anyhow::Context;
use axum::{
    body::Body,
    extract::{Path, State},
    http::{Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::post,
    Extension, Json, Router,
};
use futures::StreamExt;
use serde_json::{json, Value};
use std::{collections::HashMap, sync::Arc};
use tokio::sync::Mutex;
use uuid::Uuid;
use wealthfolio_core::profiles::{ProfileRegistry, ProfileSession, PROFILE_SCOPE_HEADER};

type Result<T> = std::result::Result<T, (StatusCode, String)>;
fn failure(error: impl ToString) -> (StatusCode, String) {
    (StatusCode::LOCKED, error.to_string())
}

/// Original browser grant, retained so a waiting login can revalidate before mutation.
#[derive(Clone)]
pub(crate) struct ProfileAccess {
    pub owner: String,
    pub session: ProfileSession,
}

pub(crate) fn connect_guard(
    state: &AppState,
) -> std::result::Result<tokio::sync::OwnedRwLockReadGuard<()>, String> {
    state
        .connect_transition
        .clone()
        .try_read_owned()
        .map_err(|_| "Connect account change is in progress. Try again.".to_string())
}

/// Applied by Connect/device-sync routers, after universal profile admission.
pub async fn admit_connect(
    Extension(state): Extension<Arc<AppState>>,
    request: Request<Body>,
    next: Next,
) -> Result<Response> {
    let _guard = connect_guard(&state).map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?;
    Ok(next.run(request).await)
}

pub struct WebProfiles {
    pub registry: Arc<ProfileRegistry>,
    config: Config,
    deletion: Mutex<()>,
    auth: Option<Arc<crate::auth::AuthManager>>,
    pub(crate) oidc: Option<Arc<crate::oidc::OidcManager>>,
    runtimes: Mutex<HashMap<Uuid, Arc<AppState>>>,
    mcp: Mutex<HashMap<Uuid, Router>>,
    visited: std::sync::Mutex<std::collections::HashSet<String>>,
}
impl WebProfiles {
    pub async fn open(config: &Config) -> anyhow::Result<Arc<Self>> {
        let db = std::path::PathBuf::from(&config.db_path);
        let directory = db
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| std::path::Path::new("."));
        let store = crate::secrets::build_secret_store(
            std::env::var("WF_SECRET_FILE")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(|_| directory.join("secrets.json")),
            Some(config.secrets_encryption_key),
            Some(&config.raw_secret_key),
        )
        .map_err(anyhow::Error::new)?;
        if !db.exists()
            && !directory.join("profiles.json").exists()
            && !directory.join("profiles.json.bak").exists()
        {
            use wealthfolio_core::secrets::SecretStore;
            let has_credentials = [
                wealthfolio_core::secrets::CLOUD_REFRESH_TOKEN_KEY,
                wealthfolio_core::secrets::SYNC_IDENTITY_KEY,
            ]
            .iter()
            .try_fold(false, |found, key| {
                store.get_secret(key).map(|value| found || value.is_some())
            })?;
            anyhow::ensure!(!has_credentials, "The default database is missing. Restore its file before starting; existing credentials were preserved.");
        }
        let registry_directory = std::path::absolute(directory)?;
        let registry = Arc::new(
            ProfileRegistry::open(directory.to_path_buf(), db, Arc::new(store)).with_context(
                || {
                    format!(
                    "Cannot open the profile registry in {} (profiles.json and profiles.json.bak). \
                     Stop the service and automatic restarts. Check the data mount, permissions, \
                     and whether another instance is running. If registry files are missing or \
                     damaged, preserve the complete data directory before restoring a matching \
                     registry backup. Do not delete profile directories or credentials. \
                     Recovery guide: docs/self-host/backups.md#profile-registry-startup-failures",
                    registry_directory.display()
                )
                },
            )?,
        );
        registry.set_legacy_addons_root(std::path::PathBuf::from(&config.addons_root))?;
        for id in registry.pending_deletions()? {
            if registry.finish_delete(id).is_err() {
                tracing::warn!("Profile deletion cleanup needs a retry.");
            }
        }
        let auth = crate::auth::AuthState::from_config(config).await?;
        Ok(Arc::new(Self {
            registry,
            config: config.clone(),
            auth: auth.auth,
            oidc: auth.oidc,
            deletion: Mutex::new(()),
            runtimes: Mutex::new(HashMap::new()),
            mcp: Mutex::new(HashMap::new()),
            visited: std::sync::Mutex::new(Default::default()),
        }))
    }

    async fn delete(
        self: &Arc<Self>,
        owner: String,
        selected: Option<Uuid>,
        id: Uuid,
        confirmation: String,
        proof: Option<String>,
    ) -> Result<()> {
        let _deletion = self.deletion.lock().await;
        if !self.registry.is_deleting(id) {
            let session = self
                .registry
                .sessions
                .admit(&owner, selected.ok_or_else(|| failure("PROFILE_LOCKED"))?)
                .map_err(failure)?;
            if session.profile_id != id {
                return Err(failure("PROFILE_STALE"));
            }
            let registry = self.registry.clone();
            tokio::task::spawn_blocking(move || {
                registry.begin_delete(id, &confirmation, proof.as_deref())
            })
            .await
            .map_err(failure)?
            .map_err(failure)?;
        }
        self.visited.lock().map_err(failure)?.insert(owner);
        self.mcp.lock().await.remove(&id);
        let runtime = self.runtimes.lock().await.remove(&id);
        if let Some(runtime) = runtime {
            let _lifecycle = runtime.profile_lifecycle.lock().await;
            let workers = std::mem::take(&mut *runtime.workers.lock().map_err(failure)?);
            for worker in workers {
                worker.abort();
                let _ = worker.await;
            }
            runtime.device_sync_runtime.clear_restore().await;
            runtime
                .device_sync_runtime
                .ensure_background_stopped()
                .await;
            runtime.writer.shutdown().await;
            if let Some(task) = runtime.writer_task.lock().await.take() {
                task.join().await;
            }
            let mcp_sessions = runtime.mcp_sessions.clone();
            close_mcp_sessions(&mcp_sessions).await?;
            let owner = Arc::downgrade(&runtime._database_owner);
            drop(_lifecycle);
            drop(runtime);
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
            while owner.strong_count() > 0 {
                // An HTTP initialize already in flight may finish after the first close.
                close_mcp_sessions(&mcp_sessions).await?;
                if tokio::time::Instant::now() >= deadline {
                    return Err(failure("Profile deletion is pending. Background work is finishing; retry deletion or restart the server."));
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        }
        let registry = self.registry.clone();
        tokio::task::spawn_blocking(move || {
            let paths = registry.deletion_paths(id).map_err(failure)?;
            if paths.database.exists() {
                // Also check retries: an earlier timed-out runtime may still own it.
                let owner = wealthfolio_storage_sqlite::db::DatabaseOwner::acquire(
                    paths.database.to_string_lossy().as_ref(),
                )
                .map_err(failure)?;
                drop(owner);
            }
            registry.finish_delete(id).map_err(failure)
        })
        .await
        .map_err(failure)?
    }

    pub fn new(default: Arc<AppState>, config: &Config) -> anyhow::Result<Arc<Self>> {
        let db = std::path::PathBuf::from(&config.db_path);
        let root = db
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| std::path::Path::new("."))
            .to_path_buf();
        let registry = Arc::new(ProfileRegistry::open(
            root,
            db,
            default.secret_store.clone(),
        )?);
        let default_id = registry.default_id()?;
        let auth = default.auth.clone();
        let oidc = default.oidc.clone();
        let _ = default.profile_binding.set((registry.clone(), default_id));
        crate::scheduler::start_background_workers(default.clone());
        let mut runtimes = HashMap::new();
        runtimes.insert(default_id, default);
        Ok(Arc::new(Self {
            registry,
            auth,
            oidc,
            config: config.clone(),
            deletion: Mutex::new(()),
            runtimes: Mutex::new(runtimes),
            mcp: Mutex::new(HashMap::new()),
            visited: std::sync::Mutex::new(Default::default()),
        }))
    }
    fn auto_open(&self, owner: &str) -> Result<Option<wealthfolio_core::profiles::ProfileSession>> {
        let revision = self
            .registry
            .sessions
            .unlock_revision(owner)
            .map_err(failure)?;
        let profiles = self.registry.list().map_err(failure)?;
        if profiles.len() != 1
            || profiles[0].lock_enabled
            || !self.visited.lock().map_err(failure)?.insert(owner.into())
        {
            return Ok(None);
        }
        let protected = self
            .registry
            .verify(profiles[0].id, None)
            .map_err(failure)?;
        self.registry
            .sessions
            .issue_if_current(owner, revision, profiles[0].id, protected)
            .map(Some)
            .map_err(failure)
    }

    pub(crate) fn auth_state(&self) -> crate::auth::AuthState {
        crate::auth::AuthState {
            auth: self.auth.clone(),
            oidc: self.oidc.clone(),
        }
    }

    pub async fn runtime(&self, id: Uuid) -> Result<Arc<AppState>> {
        let mut runtimes = self.runtimes.lock().await;
        let profile = self.registry.profile(id).map_err(failure)?;
        if let Some(runtime) = runtimes.get(&id) {
            return Ok(runtime.clone());
        }
        let paths = self.registry.paths(&profile);
        if profile.legacy_database.is_some() && !paths.database.is_file() {
            return Err(failure("The legacy profile database is missing. Restore its file before opening this profile; existing credentials were preserved."));
        }
        let mut config = self.config.clone();
        config.db_path = paths.database.to_string_lossy().into_owned();
        if profile.legacy_database.is_none() {
            config.addons_root = paths.root.to_string_lossy().into_owned();
            config.database_key =
                crate::auth::derive_profile_database_key(&config.raw_secret_key, id);
        }
        let runtime = build_profile_state(&config, self.registry.secret_store(&profile))
            .await
            .map_err(failure)?;
        let _ = runtime.profile_binding.set((self.registry.clone(), id));
        runtimes.insert(id, runtime.clone());
        crate::scheduler::start_background_workers(runtime.clone());
        Ok(runtime)
    }
    pub fn start_connected_profiles(self: &Arc<Self>) {
        let root = self.clone();
        tokio::spawn(async move {
            if let Ok(profiles) = root.registry.list() {
                for profile in profiles {
                    if root
                        .registry
                        .profile(profile.id)
                        .ok()
                        .and_then(|p| {
                            root.registry
                                .secret_store(&p)
                                .get_secret(wealthfolio_core::secrets::CLOUD_REFRESH_TOKEN_KEY)
                                .ok()
                                .flatten()
                        })
                        .is_some()
                    {
                        if let Err((_, error)) = root.runtime(profile.id).await {
                            tracing::warn!("Profile sync startup deferred: {error}");
                        }
                    }
                }
            }
        });
    }
}

async fn close_mcp_sessions(
    manager: &rmcp::transport::streamable_http_server::session::local::LocalSessionManager,
) -> Result<()> {
    use rmcp::transport::streamable_http_server::session::SessionManager;
    let sessions: Vec<_> = manager.sessions.read().await.keys().cloned().collect();
    for id in sessions {
        manager.close_session(&id).await.map_err(failure)?;
    }
    Ok(())
}

pub fn router<S: Clone + Send + Sync + 'static>(root: Arc<WebProfiles>) -> Router<S> {
    Router::new()
        .route("/profiles/{command}", post(command))
        .with_state(root)
}

fn text<'a>(body: &'a Value, key: &str) -> Result<&'a str> {
    body.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| failure(format!("Missing {key}")))
}
fn id(body: &Value) -> Result<Uuid> {
    Uuid::parse_str(text(body, "profileId")?).map_err(failure)
}
fn scope(headers: &axum::http::HeaderMap) -> Result<Uuid> {
    headers
        .get(PROFILE_SCOPE_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| Uuid::parse_str(s).ok())
        .ok_or_else(|| failure("PROFILE_LOCKED"))
}
// Accept only serialized HTTP(S) origins, never URLs with credentials or paths.
fn browser_origin(value: &str) -> Option<reqwest::Url> {
    let (_, authority) = value.split_once("://")?;
    if authority.is_empty()
        || authority.contains(['/', '?', '#', '@', '\\'])
        || value.chars().any(char::is_whitespace)
    {
        return None;
    }
    let origin = reqwest::Url::parse(value).ok()?;
    matches!(origin.scheme(), "http" | "https").then_some(origin)
}

fn allowed_profile_origin(headers: &axum::http::HeaderMap, configured: &[String]) -> bool {
    if headers
        .get("sec-fetch-site")
        .is_some_and(|v| v != "same-origin" && v != "none")
    {
        return false;
    }
    if headers.get_all("origin").iter().count() > 1 {
        return false;
    }
    let Some(value) = headers.get("origin") else {
        return true; // Preserve non-browser API clients that omit Origin.
    };
    let Some(origin) = value.to_str().ok().and_then(browser_origin) else {
        return false;
    };
    // Preserve direct access and TLS termination without trusting forwarded headers.
    let host_matches = headers.get_all("host").iter().count() == 1
        && headers
            .get("host")
            .and_then(|v| v.to_str().ok())
            .and_then(|host| browser_origin(&format!("{}://{host}", origin.scheme())))
            .is_some_and(|host| host.origin() == origin.origin());
    host_matches
        || configured.iter().any(|value| {
            // Wildcard CORS is not permission to mutate profile grants.
            browser_origin(value).is_some_and(|allowed| allowed.origin() == origin.origin())
        })
}

async fn command(
    State(root): State<Arc<WebProfiles>>,
    Extension(owner): Extension<BackupSession>,
    Path(command): Path<String>,
    headers: axum::http::HeaderMap,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    // JSON-only POST plus same-origin checks prevent cross-site grant mutations.
    if !allowed_profile_origin(&headers, &root.config.cors_allow) {
        return Err(failure("PROFILE_ORIGIN_REJECTED: Preserve the public Host header or configure its exact origin in WF_CORS_ALLOW_ORIGINS. Cross-site profile requests are not allowed."));
    }
    let registry = root.registry.clone();
    let admitted = || {
        registry
            .sessions
            .admit(&owner.0, scope(&headers)?)
            .map_err(failure)
    };
    match command.as_str() {
        "get_profile_state" => {
            let profiles = registry.list().map_err(failure)?;
            let mut session = registry.sessions.current(&owner.0).map_err(failure)?;
            if session.is_none() {
                session = root.auto_open(&owner.0)?;
            }
            Ok(Json(
                json!({"profiles":profiles,"pendingDeletions":registry.pending_profiles().map_err(failure)?,"session":session,"starting":false}),
            ))
        }
        "delete_profile" => {
            let id = id(&body)?;
            let selected = scope(&headers).ok();
            let confirmation = text(&body, "confirmation")?.to_string();
            let proof = body.get("proof").and_then(Value::as_str).map(str::to_owned);
            let root = root.clone();
            tokio::spawn(async move {
                root.delete(owner.0, selected, id, confirmation, proof)
                    .await
            })
            .await
            .map_err(failure)??;
            Ok(Json(Value::Null))
        }
        "create_profile" => {
            let name = text(&body, "name")?.to_string();
            let avatar = text(&body, "avatarId")?.to_string();
            let password = body
                .get("password")
                .and_then(Value::as_str)
                .map(|value| zeroize::Zeroizing::new(value.to_string()));
            let (profile, recovery_code) = tokio::task::spawn_blocking(move || {
                registry.create_with_password(
                    &name,
                    &avatar,
                    password.as_deref().map(String::as_str),
                )
            })
            .await
            .map_err(failure)?
            .map_err(failure)?;
            let mut result = json!(profile);
            result["recoveryCode"] = json!(recovery_code);
            Ok(Json(result))
        }
        "unlock_profile" => {
            root.visited
                .lock()
                .map_err(failure)?
                .insert(owner.0.clone());
            let revision = registry
                .sessions
                .unlock_revision(&owner.0)
                .map_err(failure)?;
            let id = id(&body)?;
            let proof = body
                .get("proof")
                .and_then(Value::as_str)
                .map(str::to_string);
            let verify = registry.clone();
            let protected =
                tokio::task::spawn_blocking(move || verify.verify(id, proof.as_deref()))
                    .await
                    .map_err(failure)?
                    .map_err(failure)?;
            root.runtime(id).await?;
            registry.auth_flows.select(&owner.0, id).map_err(failure)?;
            let session = registry
                .sessions
                .issue_if_current(&owner.0, revision, id, protected)
                .map_err(failure)?;
            Ok(Json(json!(session)))
        }
        "lock_profile" => {
            root.visited
                .lock()
                .map_err(failure)?
                .insert(owner.0.clone());
            registry.auth_flows.cancel(&owner.0).map_err(failure)?;
            registry.sessions.revoke(&owner.0).map_err(failure)?;
            Ok(Json(Value::Null))
        }
        "profile_activity" => {
            let session = admitted()?;
            registry
                .sessions
                .activity(&owner.0, session.scope_id)
                .map_err(failure)?;
            Ok(Json(Value::Null))
        }
        "update_profile" => {
            let session = admitted()?;
            let name = text(&body, "name")?.to_string();
            let avatar = text(&body, "avatarId")?.to_string();
            tokio::task::spawn_blocking(move || {
                registry.update(session.profile_id, &name, &avatar)
            })
            .await
            .map_err(failure)?
            .map_err(failure)?;
            Ok(Json(Value::Null))
        }
        "set_profile_password" | "recover_profile_password" => {
            let recovery = command == "recover_profile_password";
            let id = if recovery {
                id(&body)?
            } else {
                admitted()?.profile_id
            };
            let proof = body
                .get(if recovery { "recoveryCode" } else { "proof" })
                .and_then(Value::as_str)
                .map(str::to_string);
            let password = body
                .get("password")
                .and_then(Value::as_str)
                .map(str::to_string);
            let code = tokio::task::spawn_blocking(move || {
                if recovery && !registry.verify(id, proof.as_deref())? {
                    return Err(wealthfolio_core::profiles::ProfileError::Locked);
                }
                registry.set_password(id, proof.as_deref(), password.as_deref())
            })
            .await
            .map_err(failure)?
            .map_err(failure)?;
            Ok(Json(json!(code)))
        }
        "profile_auth_storage" => {
            let session = admitted()?;
            let flows = &registry.auth_flows;
            let expected = body
                .get("flowId")
                .and_then(Value::as_str)
                .and_then(|s| Uuid::parse_str(s).ok());
            let result = match text(&body, "operation")? {
                "set" => json!(flows
                    .set_with_id(
                        &owner.0,
                        session.profile_id,
                        text(&body, "key")?,
                        text(&body, "value")?,
                        expected.unwrap_or_else(Uuid::new_v4)
                    )
                    .map_err(failure)?),
                "validate" => json!(expected.is_some_and(|id| flows
                    .is_current(&owner.0, session.profile_id, id)
                    .unwrap_or(false))),
                "get" => json!(flows
                    .get_scoped(&owner.0, session.profile_id, text(&body, "key")?, expected)
                    .map_err(failure)?),
                "remove" => {
                    flows
                        .remove(&owner.0, session.profile_id, expected)
                        .map_err(failure)?;
                    Value::Null
                }
                "callback" => Value::Null,
                _ => return Err(failure("Invalid authentication operation")),
            };
            Ok(Json(result))
        }
        "get_profile_sync_identity" | "update_profile_sync_identity" => {
            let session = admitted()?;
            let runtime = root.runtime(session.profile_id).await?;
            let _admission = connect_guard(&runtime)
                .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?;
            let profile = registry.profile(session.profile_id).map_err(failure)?;
            let store = registry.secret_store(&profile);
            let key = wealthfolio_core::secrets::SYNC_IDENTITY_KEY;
            if command == "get_profile_sync_identity" {
                return Ok(Json(json!(store.get_secret(key).map_err(failure)?)));
            }
            let identity = body
                .get("identity")
                .and_then(Value::as_str)
                .ok_or_else(|| failure("Use device sync reset to remove enrollment."))?;
            wealthfolio_core::secrets::update_existing_sync_identity(store.as_ref(), identity)
                .map_err(failure)?;
            Ok(Json(Value::Null))
        }
        _ => Err((StatusCode::NOT_FOUND, "Unknown profile operation".into())),
    }
}

pub async fn admit(
    State(root): State<Arc<WebProfiles>>,
    mut request: Request<Body>,
    next: Next,
) -> Result<Response> {
    let owner = request
        .extensions()
        .get::<BackupSession>()
        .ok_or_else(|| failure("PROFILE_LOCKED"))?
        .0
        .clone();
    let selected = if request.headers().contains_key(PROFILE_SCOPE_HEADER) {
        Some(scope(request.headers())?)
    } else if let Some(value) = request.uri().query().and_then(|q| {
        q.split('&')
            .find_map(|part| part.strip_prefix("profileScope="))
    }) {
        Some(Uuid::parse_str(value).map_err(failure)?)
    } else {
        None
    };
    let session = if let Some(selected) = selected {
        root.registry
            .sessions
            .admit(&owner, selected)
            .map_err(failure)?
    } else {
        let profiles = root.registry.list().map_err(failure)?;
        if profiles.len() != 1 || profiles[0].lock_enabled {
            return Err(failure("PROFILE_LOCKED"));
        }
        match root.registry.sessions.current(&owner).map_err(failure)? {
            Some(session) => session,
            None => root
                .auto_open(&owner)?
                .ok_or_else(|| failure("PROFILE_LOCKED"))?,
        }
    };
    let selected = session.scope_id;
    let state = root.runtime(session.profile_id).await?;
    request.extensions_mut().insert(state);
    request.extensions_mut().insert(root.clone());
    // A download ticket belongs to this unlock, not just the browser cookie.
    request
        .extensions_mut()
        .insert(BackupSession(format!("{owner}:{selected}")));
    request.extensions_mut().insert(ProfileAccess {
        owner: owner.clone(),
        session,
    });
    let response = next.run(request).await;
    root.registry
        .sessions
        .admit(&owner, selected)
        .map_err(failure)?;
    let (parts, body) = response.into_parts();
    // Recheck each chunk, and wake idle SSE/AI bodies on revocation.
    let stream = futures::stream::unfold(
        (body.into_data_stream(), root, owner, selected),
        |(mut stream, root, owner, selected)| async move {
            loop {
                if root.registry.sessions.admit(&owner, selected).is_err() {
                    return None;
                }
                tokio::select! {
                    data = stream.next() => {
                        if root.registry.sessions.admit(&owner,selected).is_err() { return None; }
                        return data.map(|data| (data,(stream,root,owner,selected)));
                    }
                    _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}
                }
            }
        },
    );
    Ok(Response::from_parts(parts, Body::from_stream(stream)))
}

pub async fn mcp(State(root): State<Arc<WebProfiles>>, request: Request<Body>) -> Response {
    use tower::ServiceExt;
    let id = match request
        .headers()
        .get(wealthfolio_core::profiles::PROFILE_ID_HEADER)
    {
        Some(value) => match value.to_str().ok().and_then(|s| Uuid::parse_str(s).ok()) {
            Some(id) => id,
            None => return StatusCode::BAD_REQUEST.into_response(),
        },
        None => match root.registry.default_id() {
            Ok(id) => id,
            Err(e) => return failure(e).into_response(),
        },
    };
    if let Err(error) = root.registry.profile(id) {
        return failure(error).into_response();
    }
    let mut routers = root.mcp.lock().await;
    let router = if let Some(router) = routers.get(&id) {
        router.clone()
    } else {
        let state = match root.runtime(id).await {
            Ok(state) => state,
            Err(e) => return e.into_response(),
        };
        let router = crate::mcp::router(state, &root.config);
        routers.insert(id, router.clone());
        router
    };
    drop(routers);
    router
        .oneshot(request)
        .await
        .unwrap_or_else(|never| match never {})
}

pub async fn instance_logout(
    State(root): State<Arc<WebProfiles>>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if request.uri().path().ends_with("/auth/logout")
        || request.uri().path().ends_with("/auth/oidc/logout")
    {
        if let Some(auth) = &root.auth {
            if let Ok(token) = crate::auth::extract_token(&request) {
                if let Ok(claims) = auth.validate_token(&token) {
                    use sha2::Digest;
                    let owner = if claims.sid.is_empty() {
                        format!("{:x}", sha2::Sha256::digest(token.as_bytes()))
                    } else {
                        claims.sid
                    };
                    let _ = root.registry.sessions.revoke(&owner);
                    let _ = root.registry.auth_flows.cancel(&owner);
                }
            }
        }
    }
    next.run(request).await
}

/// Offline selection retains registry ownership through the entire operation.
pub(crate) fn offline_database(
    default: String,
    master: &[u8],
    selected: Option<Uuid>,
) -> anyhow::Result<(String, [u8; 32], Option<ProfileRegistry>)> {
    let db = std::path::PathBuf::from(&default);
    let root = db
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    if !root.join("profiles.json").exists() && !root.join("profiles.json.bak").exists() {
        anyhow::ensure!(selected.is_none(), "No profile registry exists");
        return Ok((default, crate::auth::derive_database_key(master), None));
    }
    let (_, vault_key) = crate::auth::derive_keys(master);
    let store = crate::secrets::build_secret_store(
        std::env::var("WF_SECRET_FILE")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| root.join("secrets.json")),
        Some(vault_key),
        Some(master),
    )
    .map_err(anyhow::Error::new)?;
    let registry = ProfileRegistry::open(root.to_path_buf(), db.clone(), Arc::new(store))?;
    let id = selected.unwrap_or(registry.default_id()?);
    let profile = registry.profile(id)?;
    let path = registry
        .paths(&profile)
        .database
        .to_string_lossy()
        .into_owned();
    let mut key = crate::auth::derive_database_key(master);
    if profile.legacy_database.is_none() {
        key = crate::auth::derive_profile_database_key(master, id);
    }
    Ok((path, key, Some(registry)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profile_origin_policy_handles_direct_and_proxied_requests() {
        use axum::http::{HeaderMap, HeaderValue};
        let allowed = vec![
            "https://portfolio.example.com".into(),
            "https://portfolio.example.com:8443".into(),
            "http://192.168.1.10:8088".into(),
        ];
        for (origin, host, expected) in [
            ("http://localhost:1420", "localhost:1420", true),
            ("http://192.168.1.10:8088", "192.168.1.10:8088", true),
            ("http://[::1]:8088", "[::1]:8088", true),
            (
                "https://portfolio.example.com",
                "portfolio.example.com",
                true,
            ),
            ("https://portfolio.example.com", "wealthfolio:8088", true),
            (
                "https://portfolio.example.com:443",
                "wealthfolio:8088",
                true,
            ),
            ("https://PORTFOLIO.example.com", "wealthfolio:8088", true),
            (
                "https://portfolio.example.com:8443",
                "portfolio.example.com",
                true,
            ),
            ("http://portfolio.example.com", "wealthfolio:8088", false),
            (
                "https://portfolio.example.com:8444",
                "wealthfolio:8088",
                false,
            ),
            ("https://other.example.com", "wealthfolio:8088", false),
            (
                "https://portfolio.example.com.evil.test",
                "wealthfolio:8088",
                false,
            ),
            ("https://evil.test", "wealthfolio:8088", false),
            ("null", "wealthfolio:8088", false),
            (
                "https://portfolio.example.com/path",
                "portfolio.example.com",
                false,
            ),
            (
                "https://user@portfolio.example.com",
                "portfolio.example.com",
                false,
            ),
            (
                "ftp://portfolio.example.com",
                "portfolio.example.com",
                false,
            ),
            (
                "https://portfolio.example.com?x",
                "portfolio.example.com",
                false,
            ),
            (
                "https://portfolio.example.com#x",
                "portfolio.example.com",
                false,
            ),
            (
                "https://portfolio.example.com https://evil.test",
                "portfolio.example.com",
                false,
            ),
        ] {
            let mut headers = HeaderMap::new();
            headers.insert("origin", HeaderValue::from_str(origin).unwrap());
            headers.insert("host", HeaderValue::from_str(host).unwrap());
            assert_eq!(
                allowed_profile_origin(&headers, &allowed),
                expected,
                "{origin} via {host}"
            );
            headers.insert("sec-fetch-site", HeaderValue::from_static("same-origin"));
            assert_eq!(allowed_profile_origin(&headers, &allowed), expected);
            for site in ["same-site", "cross-site"] {
                headers.insert("sec-fetch-site", HeaderValue::from_static(site));
                assert!(!allowed_profile_origin(&headers, &allowed));
            }
        }
        let mut headers = HeaderMap::new();
        assert!(allowed_profile_origin(&headers, &[]));
        headers.insert("sec-fetch-site", HeaderValue::from_static("cross-site"));
        assert!(!allowed_profile_origin(&headers, &allowed));
        headers.remove("sec-fetch-site");
        headers.insert(
            "origin",
            HeaderValue::from_static("https://portfolio.example.com"),
        );
        headers.insert("host", HeaderValue::from_static("wealthfolio:8088"));
        assert!(!allowed_profile_origin(&headers, &["*".into()]));
        assert!(!allowed_profile_origin(&headers, &[]));
        headers.append("origin", HeaderValue::from_static("https://evil.test"));
        assert!(!allowed_profile_origin(&headers, &allowed));
    }

    #[test]
    fn grant_mutations_reject_cross_origin_and_sibling_sites() {
        let mut headers = axum::http::HeaderMap::new();
        assert!(allowed_profile_origin(&headers, &[]));
        headers.insert("host", "wealthfolio.test".parse().unwrap());
        headers.insert("origin", "https://wealthfolio.test".parse().unwrap());
        assert!(allowed_profile_origin(&headers, &[]));
        headers.insert("origin", "https://other.test".parse().unwrap());
        assert!(!allowed_profile_origin(&headers, &[]));
        headers.remove("origin");
        headers.insert("sec-fetch-site", "same-site".parse().unwrap());
        assert!(!allowed_profile_origin(&headers, &[]));
    }
}
