Wealthfolio Server

Overview
- This crate runs the HTTP API (Axum) and serves static files for the web build.
- It uses the shared `src-core` for all business logic, repositories, and migrations.

Run locally (Rust only)
- From the repo root:
  - `cargo run --manifest-path apps/server/Cargo.toml`

Docker image
- Pull the latest published server image with `docker pull wealthfolio/wealthfolio:latest`.
- Use that tag (or your locally built image) in the Docker run examples inside the root `README.md`.

Key environment variables
- `WF_LISTEN_ADDR`: Bind address, default `0.0.0.0:8088`.
- `WF_DB_PATH`: Path to the SQLite database file (or a directory; if a directory is provided, `app.db` is used inside it). Example: `./db/app.db`.
- `WF_CORS_ALLOW_ORIGINS`: Comma-separated list of allowed origins for CORS. Example: `http://localhost:1420`.
- `WF_REQUEST_TIMEOUT_MS`: Request timeout in milliseconds. Default `30000`.
- `WF_STATIC_DIR`: Directory to serve static assets from (the web build output). Default `dist`.
- `WF_SECRET_KEY`: Required 32-byte key used to encrypt secrets at rest and sign JWTs. Must decode to exactly 32 bytes.
  Can be provided as:
  - Base64-encoded string (recommended): Generate with `openssl rand -base64 32` or `head -c 32 /dev/urandom | base64`
  - 32-byte ASCII string: Must be exactly 32 characters (less secure if contains only printable characters)
  Example: `WF_SECRET_KEY=$(openssl rand -base64 32)`.
- `WF_AUTH_PASSWORD_HASH`: Enables password-only authentication for web mode when set to an Argon2id PHC string.
  Generate via online tools like [argon2.online](https://argon2.online/) or the CLI (`argon2-utils` package):
  ```bash
  printf 'your-password' | argon2 yoursalt16chars! -id -e
  ```
  The first argument is the **salt** (use 16+ characters); the password is read from stdin.
  Use `printf` instead of `echo -n` to avoid hidden newline issues.
  For Docker Compose `.env`/`--env-file`, single-quote the value or double every `$`;
  for YAML inline values, double every `$` in the hash (`$$argon2id$$...`).
  When unset, authentication is not configured. The server refuses to start on non-loopback
  addresses without authentication unless `WF_AUTH_REQUIRED=false` is set; for local no-auth use
  `WF_LISTEN_ADDR=127.0.0.1:8088`.
- `WF_AUTH_TOKEN_TTL_MINUTES`: Optional JWT access token lifetime (minutes). Defaults to `60`.
- OIDC / SSO (optional): authenticate via any OpenID Connect provider (Authentik, PocketID, Authelia, Keycloak, …). OIDC is an alternative to `WF_AUTH_PASSWORD_HASH`; either or both can be enabled, and a successful SSO login mints the same session cookie. OIDC is enabled when **both** of the first two are set:
  - `WF_OIDC_ISSUER_URL`: Provider base URL. Discovery hits `<issuer>/.well-known/openid-configuration` at startup.
  - `WF_OIDC_CLIENT_ID`: Client id registered with the IdP.
  - `WF_OIDC_CLIENT_SECRET`: Optional client secret (PKCE is always used; set this for confidential clients).
  - `WF_OIDC_REDIRECT_URL`: Required when OIDC is enabled. Must be registered in the IdP, e.g. `https://your.host/api/v1/auth/oidc/callback`.
  - `WF_OIDC_SCOPES`: Optional space-separated scopes. Default `openid email profile`.
  - `WF_OIDC_ALLOWED_EMAILS` / `WF_OIDC_ALLOWED_SUBS`: Comma-separated allowlists matched against the ID token's `email` / `sub` claims. With neither set, the server **refuses to start** unless `WF_OIDC_ALLOW_ANY=true` is also set — a missing allowlist must never silently grant every IdP user access. An `email` is only honored when the IdP asserts `email_verified=true`; `WF_OIDC_ALLOWED_SUBS` is the stronger control (the `sub` is stable and issuer-scoped) and is recommended on shared/multi-tenant IdPs.
  - `WF_OIDC_ALLOW_ANY`: **Optional**, default `false`. Set to `true` to allow **any** user the IdP authenticates when no allowlist is configured. Only safe on a dedicated single-user IdP; on a shared/multi-tenant IdP this grants everyone access. A warning is logged at startup when enabled.
  - `WF_OIDC_POST_LOGOUT_REDIRECT_URL`: **Optional**. When the IdP advertises an `end_session_endpoint`, sign-out performs RP-Initiated Logout (ends the IdP session too); otherwise logout is local-only. Set this to return to the app after IdP logout — it must be **registered** with the IdP (e.g. Keycloak's "Valid post logout redirect URIs"). If unset, the IdP shows its own logged-out page.
  - `WF_OIDC_RP_LOGOUT`: **Optional**, default `true`. Set to `false` to force local-only logout even when the IdP supports RP-Initiated Logout.
- `WF_SECRET_FILE`: Optional override for where encrypted secrets are stored. Defaults to `<data-root>/secrets.json`.

Notes
- The server also honors `DATABASE_URL`; when running in this workspace, `WF_DB_PATH` is preferred and propagated to `DATABASE_URL` internally so the core layer uses the expected path.
- Database migrations are embedded and applied automatically on startup.
- Secrets in web/server mode are stored in an encrypted JSON file derived from the database directory using `WF_SECRET_KEY`.
