# Wealthfolio Connect in source builds

Connect is optional when building Wealthfolio from source. Desktop and Docker
builds can use the same public authentication settings as the official app.

The auth URL and publishable key identify Wealthfolio's authentication service;
they are public application settings, not personal subscription credentials. Use
the values below rather than keys from your own Supabase project. Never replace
the publishable key with a secret or service-role key: these settings are
embedded in the frontend bundle. Sign in with your Wealthfolio account; paid
features require an eligible Connect subscription.

Both auth settings must be present at build time. If either is missing, Connect
is disabled and Settings shows "Wealthfolio Connect is not configured for this
build." The feature flag checks the build-time environment variables before the
authentication code can use its fallback values. Placeholder values do not
provide a working connection.

## Desktop

Follow the [source-build setup](../README.md#building-from-source), then replace
the Connect entries in the repository root `.env` with:

```dotenv
CONNECT_AUTH_URL=https://auth.wealthfolio.app
CONNECT_AUTH_PUBLISHABLE_KEY=sb_publishable_ZSZbXNtWtnh9i2nqJ2UL4A_NV8ZVutd
CONNECT_API_URL=https://api.wealthfolio.app
CONNECT_OAUTH_CALLBACK_URL=https://connect.wealthfolio.app/deeplink
```

The callback URL returns desktop OAuth sign-ins to the app.

Official packages receive `CONNECT_STORAGE_ALLOWED_HOSTS` from a GitHub Actions
secret during CI. It is an internal destination-validation setting; people using
published packages do not configure it. Custom source builds with Connect must
export this setting into the Cargo build environment using the approved Connect
transfer hostname(s), separated by commas. Do not include URL schemes, paths, or
ports. The setting is embedded in the backend, which validates signed transfer
URLs without exposing them in the interface. Build-time configuration does not
make the hostname secret in the distributed app.

When running `pnpm tauri dev` or building with `pnpm tauri build`, the frontend
and Rust backend read the root `.env` during their builds. To build without
Connect, leave both auth settings empty.

After changing these settings, restart development or rebuild the packaged app.
Setting authentication environment variables when launching an already-built app
does not enable Connect. The transfer destination setting can additionally be
overridden at runtime by custom server deployments.

## Cloud compatibility and backup behavior

Builds using direct snapshot transfers require the updated Connect API to be
deployed first, with its database migrations applied. Released apps continue to
use the existing binary snapshot routes; updated apps use the direct routes. See
the
[cloud rollout runbook](https://github.com/wealthfolio/wealthfolio-cloud/blob/develop/docs/connect-cloud-backups-rollout.md)
for migration, staging and supported-client checks before releasing a build.

Cloud backups remain off until the user enables them for a profile and saves a
recovery code. The selected backup device checks at startup and while the app is
running. Mobile also checks when the app resumes; it does not capture backups
while suspended. The web server owns its timer, so keeping a browser open is
unnecessary. Linked-device backup access uses the existing pairing lifecycle;
the recovery code provides access when no reachable device has the backup key.

Architecture impact: capture uses the existing profile-owned timer and secret
store. Export, encryption and upload release Connect lifecycle locks; account or
profile changes cancel obsolete captures. Capture progress and failures are
ephemeral local status, not additional cloud polling or persisted retry state.
Subscription expiry preserves the user's backup consent and checks eligibility
again after a relevant action or at the next daily check. Local database
encryption, sync enrollment and explicit backup opt-in stay separate boundaries.

Automatic checks save a new copy only when the profile's restorable data
changes. A logical fingerprint of the immutable export is stored in existing
encrypted metadata and compared with the latest point from this source/key.
Export timestamps, physical SQLite layout and resettable sync transport state do
not count as changes; preferences, addon data and future tables do. Old points
without a fingerprint receive a fresh capture. Missing history never means
unchanged, and history read failures remain visible. Explicit retry/setup
captures retain their due checks and bypass the unchanged optimization. Last
backup and last unchanged check are separate UI timestamps; no duplicate point
or cloud policy write is created for an unchanged check. Native pause/resume
keeps the in-memory daily deadline while revalidating source eligibility. An
unchanged policy avoids another export before that deadline; user actions and
changed policy revisions invalidate it. Process restart has no cached deadline
and checks again. Mobile has no suspended background jobs.

**Architecture impact:** due checks add a history read through the existing
backup client. Matching data skips compression, storage PUT and completion.
Existing profile admission, lifecycle cancellation, scheduler, secret-store
boundaries and cloud index remain authoritative. The fingerprint uses the
existing authenticated metadata field; there is no migration, new secret key or
persisted retry state. Gzip level 3 reduces bytes with the existing format;
SHA-256 verification stays mandatory. Native/mobile timing and sleep/resume
still need the release checks.

A local compression benchmark can be run after exporting a disposable portable
database; its contents must never be logged or uploaded by the benchmark:

```bash
CONNECT_BACKUP_BENCHMARK_EXPORT=/private/disposable-export.db \
  cargo test --locked --release -p wealthfolio-device-sync \
  demo_compression_benchmark -- --ignored --nocapture
```

It compares levels 1, 3, 6 and 9, checks decode compatibility, and reports only
sizes and timings. The export/fingerprint measurement is available in
`wealthfolio-storage-sqlite` as `demo_capture_export_benchmark`, with
`CONNECT_BACKUP_BENCHMARK_DATABASE` pointing to a disposable plaintext demo
database.

## Docker

From the repository root, build your image with both authentication settings and
an approved Connect transfer configuration file. The file contains the comma-
separated hostnames only; keep it outside the build context.

```bash
docker build -t wealthfolio-local:connect \
  --secret id=connect-storage-hosts,src=/private/connect-storage-hosts \
  --build-arg CONNECT_AUTH_URL=https://auth.wealthfolio.app \
  --build-arg CONNECT_AUTH_PUBLISHABLE_KEY=sb_publishable_ZSZbXNtWtnh9i2nqJ2UL4A_NV8ZVutd \
  .
```

Use `wealthfolio-local:connect` as the image in your existing Docker or Compose
deployment, keeping your volume and runtime configuration. The Connect API
defaults to `https://api.wealthfolio.app`. For general deployment configuration,
see the [self-hosting guide](self-host/README.md).

Setting these variables only at container startup (`docker run -e` or Compose
`environment`) will not enable Connect in an already-built frontend; rebuild the
image with both arguments. Local `.env` files are excluded from the Docker build
context, so pass the arguments explicitly. To build without Connect, omit both
arguments and the transfer secret. Official Docker CI passes the transfer
configuration through a BuildKit secret mount rather than a build argument; it
is consumed only during the Rust build. Secret changes do not invalidate
Docker's cache. After changing the approved hosts, rebuild with
`docker buildx build --no-cache-filter backend` and the same arguments above.
Official CI refreshes this stage on every build.

For web sign-in flows that use redirects, the authentication service must allow
your deployment's callback URL (`https://your-host/auth/callback`). Supplying
the build arguments does not register a new redirect URL.
