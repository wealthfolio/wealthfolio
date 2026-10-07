# Wealthfolio Connect in source builds

Connect is optional. Source builds can use the official public authentication
settings and the public production defaults in
[`config/connect.defaults.json`](../config/connect.defaults.json). No access to
Wealthfolio's private repositories, CI settings or storage credentials is
needed. Sign in with your Wealthfolio account; paid features require an eligible
Connect subscription.

The auth URL and publishable key are public application settings. Use the values
below rather than credentials from your own Supabase project. Never use a secret
or service-role key: these settings are embedded in the frontend.

Both auth settings must be present at build time. Otherwise Connect is disabled,
even though public API, callback and transfer-host defaults are available.

## Desktop

Follow the [source-build setup](../README.md#building-from-source), then set
these entries in the repository root `.env`:

```dotenv
CONNECT_AUTH_URL=https://auth.wealthfolio.app
CONNECT_AUTH_PUBLISHABLE_KEY=sb_publishable_ZSZbXNtWtnh9i2nqJ2UL4A_NV8ZVutd
```

Run `pnpm tauri dev` or build with `pnpm tauri build`. The API URL, desktop
OAuth callback and approved transfer hosts default to the shared production
settings; no storage-host export is required. To build without Connect, leave
both auth settings empty.

After changing build-time settings, restart development or rebuild the app.
Setting auth variables only when launching an already-built app does not enable
Connect.

## Docker

From the repository root:

```bash
docker build -t wealthfolio-local:connect \
  --build-arg CONNECT_AUTH_URL=https://auth.wealthfolio.app \
  --build-arg CONNECT_AUTH_PUBLISHABLE_KEY=sb_publishable_ZSZbXNtWtnh9i2nqJ2UL4A_NV8ZVutd \
  .
```

Use that image in your existing deployment, keeping your volumes and runtime
configuration. No transfer secret is required for a production source build. For
deployment configuration, see the [self-hosting guide](self-host/README.md).

Auth settings passed only to `docker run` or Compose cannot enable Connect in an
already-built frontend. Local `.env` files are excluded from the build context,
so pass both build arguments explicitly. To build without Connect, omit them.

For web OAuth sign-in, the auth service must allow your deployment's callback
URL (`https://your-host/auth/callback`). Build arguments do not register a new
redirect URL; the web callback uses your deployment's origin.

## Staging and custom overrides

`CONNECT_API_URL` and `CONNECT_OAUTH_CALLBACK_URL` override the production
settings. Desktop builds read them from root `.env`; the web server supports a
runtime `CONNECT_API_URL` override. Configure the matching auth service too.

For another approved transfer destination, export a comma-separated list of
exact hostnames before compiling Rust:

```bash
export CONNECT_STORAGE_ALLOWED_HOSTS=approved-storage.example.com
pnpm tauri build
```

Do not include schemes, paths or ports. The override replaces the production
allowlist. Putting it only in `.env` does not embed it in the shared Rust crate.
An explicitly blank override produces a configuration error. The server can also
override the compiled list through its process environment.

For Docker, pass a file containing hostnames through the optional BuildKit
mount:

```bash
docker build -t wealthfolio-local:custom \
  --secret id=connect-storage-hosts,src=/private/connect-storage-hosts \
  --build-arg CONNECT_AUTH_URL=https://auth.wealthfolio.app \
  --build-arg CONNECT_AUTH_PUBLISHABLE_KEY=sb_publishable_ZSZbXNtWtnh9i2nqJ2UL4A_NV8ZVutd \
  .
```

An empty file is rejected. BuildKit secret changes do not invalidate cached
layers; after changing hosts, use
`docker buildx build --no-cache-filter backend` with the same arguments.
Official CI supplies its override and refreshes this stage on every build.

## Cloud backups

Cloud backups remain off until you enable them for a profile and save a recovery
code. The selected device checks at startup and while running. Mobile also
checks on resume, with no suspended background jobs. For self-hosted web
deployments, the server creates backups without keeping the browser open.

Linked devices can receive encrypted backup access through pairing. Recovery
restores access when no reachable device holds the key; it does not enable
backups or move the backup source. After paid access ends, Settings shows the
recovery deadline. Download any saved copies you want to keep before that date.

For app architecture, compatibility boundaries and developer validation, see
[Connect transfers and cloud backups](architecture/connect-transfers-and-cloud-backups.md).
