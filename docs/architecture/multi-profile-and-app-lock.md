# Profiles and application lock

Profiles separate portfolios and credentials within one Wealthfolio installation
on desktop, mobile, and self-hosted web. This document describes the feature's
architecture, access boundaries, and lifecycle. See
[credential storage](credential-storage.md) for platform stores and
[database encryption and backups](database-encryption-and-backups.md) for
encryption, export, and restore mechanics.

## Ownership and components

Each profile has a stable local UUID, name, bundled avatar ID, database, secret
namespace, and service context. Financial tables do not need a `profile_id`
column: existing repositories operate on the admitted profile's database. The
backend owns authorization and resource selection; the renderer receives a
revocable session, never a caller-selected database path or secret namespace.

| Component                                                                    | Responsibility                                                             |
| ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| [Core profiles](../../crates/core/src/profiles/mod.rs)                       | Shared types, avatar allowlist, scoped secret store                        |
| [Registry](../../crates/core/src/profiles/registry.rs)                       | Persistent metadata, legacy adoption, passwords, recovery, Connect binding |
| [Sessions](../../crates/core/src/profiles/sessions.rs)                       | Grants, revocation, idle expiry                                            |
| [Native profiles](../../apps/tauri/src/profiles.rs)                          | IPC admission and active-profile lifecycle                                 |
| [Native lifecycle](../../apps/tauri/src/profile_lifecycle.rs)                | OS session-lock and sleep notifications                                    |
| [Server profiles](../../apps/server/src/profiles.rs)                         | Per-profile runtimes, browser grants, HTTP and MCP routing                 |
| [Profile shell](../../apps/frontend/src/features/profiles/profile-shell.tsx) | Chooser, password management, recovery, startup transitions                |
| [Auth bridge](../../apps/frontend/src/features/profiles/auth-bridge.ts)      | OAuth ownership and scoped PKCE storage                                    |

Names, avatars, passwords, and Connect bindings are installation-local. They do
not synchronize with financial data or transfer through portable backups.
Different devices can use different local UUIDs for the same Connect user.

## Storage and legacy adoption

`pnpm tauri dev` uses the development application identity and ignores
`DATABASE_URL` from `.env` or the shell, including on first launch. Remove this
obsolete desktop development setting from older `.env` files and use
`WF_DATA_DIR` to select a profile directory. This changes the pre-profile
workflow of selecting an individual database through `.env`.

Desktop development can set `WF_DATA_DIR` in the root `.env` to an absolute path
for the profile registry and databases. When active, it also overrides legacy
database discovery. New databases remain under `profiles/<id>/app.db`; an
existing `app.db` directly under `WF_DATA_DIR` is adopted on first profile
initialization using the usual migration rules. An empty/unset value keeps
normal path resolution. Invalid or unwritable paths fail startup rather than
falling back to production data. Release, packaged (`custom-protocol`), and
mobile builds ignore `WF_DATA_DIR` and retain their normal Tauri app-data root
and existing legacy database behavior. This does not move existing data or
change OS keychain storage; use a fresh development folder rather than copying a
production registry with its profile IDs and saved paths.

Packaged desktop apps do not ship with an `.env` file and normally use their
app-data directory. For legacy compatibility, the production desktop identity
still consults `DATABASE_URL` if manually supplied through the process
environment or a runtime-discovered `.env`, provided `WF_DATA_DIR` is not
active. It is used only to locate an existing database during first profile
initialization. Once a registry exists, saved profile paths take precedence;
changing `DATABASE_URL` does not switch databases.

New profiles use this layout:

```text
application-data/
  profiles.json
  profiles.json.bak
  profiles/
    <profile-uuid>/
      app.db
      backups/
      scratch/
      addons/
```

The registry stores metadata and verified Connect bindings, but no passwords,
tokens, or encryption keys. Registry changes are serialized and written
atomically with a last-valid backup. Paths derive from validated UUIDs and
registered layouts. Backups, snapshot staging, imports, exports, add-on files,
and cleanup use the same owning profile as the database.

An existing installation becomes the default Personal profile without moving its
database or copying credentials. It retains its database key, backups, sync
enrollment, existing path override, and legacy secret namespace. Only that
profile can own the legacy namespace. New profiles receive UUID-based paths and
secret prefixes. Profile selection does not mutate process environment
variables.

The backend marks the adopted profile with `isLegacy`. Its UI preferences read
profile-scoped localStorage first, falling back to the original key only when
the scoped key is absent. Updates write only the scoped key; reading does not
copy or delete old preferences. New profiles never inherit these values.
Resetting a preference must write its default rather than remove its scoped key,
so an old value cannot reappear.

Initialization is idempotent. Missing legacy data must not attach leftover
credentials to a new empty database. Missing registry metadata alongside
existing profile directories is a recovery condition. Cleanup of a legacy
profile must not recursively delete the installation root containing other
profiles.

`ScopedSecretStore` fixes the namespace at construction, including legacy add-on
key fallbacks. Native profiles use the OS credential store. Web profiles share
one underlying encrypted vault so its write locking remains effective.

## Passwords and access recovery

A profile password protects access through Wealthfolio. It is independent of
optional database encryption and does not encrypt or derive the database key. An
unencrypted database remains readable outside the app. The trusted OS account or
server operator is outside this application-access boundary; a reload or context
teardown does not guarantee memory erasure.

| Material                       | Protection                                              |
| ------------------------------ | ------------------------------------------------------- |
| Profile password               | Salted Argon2id verifier in the profile secret store    |
| Recovery code                  | Domain-separated SHA-256 hash in the same lock record   |
| Failed attempts                | Persisted counter and cooldown in the lock record       |
| Native database key            | Independent random key in native credential storage     |
| Web database key               | Operator master-key derivation, scoped for new profiles |
| Connect and device credentials | Profile-scoped secret store                             |

Passwords accept 4–128 Unicode characters, including four-digit PINs, preserving
spaces and exact text. Existing six-digit PIN verifiers remain usable for unlock
and credential changes. New verifiers use Argon2id with 19 MiB memory, two
iterations, one lane, a random salt, and encoded parameters. Hosts run
verification outside the async executor.

After five failed attempts, verification imposes a 30-second cooldown;
subsequent cooldowns double up to 15 minutes. Successful verification clears
failures. Restarting or changing browser sessions does not reset persisted
attempts. Lock-record writes are read back before success is reported. Registry
`lockEnabled` is only a display hint: missing or unreadable protected records
must fail closed.

The registry explicitly marks newly created or first-adopted passwordless
profiles as `neverProtected`, allowing local plaintext startup without a working
native credential service. Older registry entries omit this field and still
consult the credential store. Before the first password write, both registry
copies lose this exemption; it is never restored, even after a failed write or
password removal. An existing `profiles.lock` file prevents a legacy database
from regaining the exemption if both registry files are lost. Credential writes
revoke sessions before attempting persistence, because a write or readback error
can follow a saved change.

### Setup, change, disable, and recovery

- Initial password setup requires an admitted profile session. The UI requires
  matching password confirmation and acknowledgement of the recovery code.
- Setup generates a random 128-bit recovery code, displayed in grouped
  hexadecimal form. Its plaintext is returned for that setup flow; only its hash
  is stored.
- Changing or disabling protection requires the current password or recovery
  code. Recovery replaces the password and rotates the recovery code.
- Credential changes revoke existing profile grants. They do not rekey the
  database, reset device sync, or sign out Connect.
- Neither the password nor the recovery code can recover a lost database key.
  Losing both access proofs provides no supported password-reset bypass.

Generic secret APIs cannot read or overwrite lock records, database keys, or
internal Connect credentials. Existing pairing identity operations use narrowly
scoped APIs. Passwords and pending login verifiers are not stored in
localStorage.

### Database recovery

Access recovery and database recovery are separate. After authorization, native
startup can issue a restricted recovery grant when the database fails to open.
Only that profile's status and recovery operations are admitted until a live
context exists. Successful database installation rotates the scope.

The database gate keeps retry and permitted backup recovery reachable without
revealing financial routes. A transport error does not establish corruption; a
locked or stale scope returns control to the profile shell. Restore remains
owned by the backend even if its view closes, and completion cannot reopen a
session revoked during maintenance.

Portable restore preserves the destination local profile and password, applying
existing reconnection and credential-clearing behavior only to that profile.
Legacy web databases retain their original key derivation; new web databases use
a versioned profile-specific derivation. Native keys needed by older encrypted
backups remain retained after encryption is disabled.

## Session admission and runtime lifecycle

`ProfileSummary` exposes ID, name, avatar ID, and lock indicator.
`ProfileSession` carries `profileId` and an opaque `scopeId`. Admission maps the
scope to the fixed profile and, on native, the database generation. Lock,
switch, credential changes, and native database rebuilds revoke or replace
scopes.

The financial renderer freezes its scope for the document lifetime. A new scope
requires a fresh application load; older async work cannot read a mutable global
and acquire the destination profile's authority. Adapters attach the scope to
IPC, HTTP, streaming, file, and add-on operations. Only classified shell/auth
operations work before unlock.

Commands capture their admitted context before awaiting or spawning work.
Already-admitted transactions stay with their original database; revocation does
not roll back committed work. Stale responses, events, streams, and temporary
approvals must not be delivered into another session. Database suspension,
maintenance gates, and file leases coordinate work with teardown. Filesystem
helpers receive an admitted root path rather than consulting a current profile.

### Native

Registry initialization runs after Tauri setup so missing or corrupt registry
files show a startup recovery screen instead of aborting the process. Before a
registry is available, the shell can read startup status, retry initialization,
and open the configured data folder. Financial commands remain unavailable.
Retry preserves existing data and uses the registry's normal backup restoration.
An explicit, confirmed fresh start archives unreadable registry files under
`profile-registry-backups/<id>/` and initializes an empty registry before
entering normal profile setup. It refuses usable registries or ownership
conflicts, never adopts orphaned databases or credentials, and leaves existing
data files in place. Neither recovery path reconstructs profiles from
directories.

The native profile shell subscribes before its initial state read and refreshes
on `app:ready`, session changes, and database changes. Native readiness does not
poll. Web retains its two-second profile-session polling because it has no
native session-change notifications; it does not use the native database gate.

The database gate reads status after subscribing to `database-state-changed`.
The backend maintenance guard notifies when retry, restore, recovery, or
encryption maintenance begins and after its flag is cleared, including failures.
Its listener remains mounted while financial screens are hidden. The profile
shell also listens so a database rebuild can renew a stale session even if the
database gate was unmounted. Existing session admission and reload behavior
isolate the rebuilt runtime; notifications do not grant access or duplicate
backend state.

One profile is active at a time. Lock or switch immediately covers financial UI
and revokes admission, then stops interactive work, workers, device sync, and
embedded MCP through the existing database lifecycle. Portfolio refresh tasks
are owned by that profile, including their awaited calculation phase. Teardown
cancels and joins them before closing the writer; late refresh requests are
rejected. The writer still drains submitted transactions, and database ownership
checks still account for blocking work. The writer and database ownership are
released before another profile opens. Ownership failure leaves the app
inaccessible rather than activating a second context.

Unlock rebuilds the service context. Full document navigation clears financial
queries, add-on/provider state, and ordinary pairing state. Critical database
maintenance remains app-owned and pinned to its original runtime. Internal file
transfers use admitted commands; native capabilities restrict direct app-data
access while preserving picker-granted external files.

Protected sessions expire after five minutes without user activity. Switching
apps, backgrounding, or a delayed timer tick does not immediately lock the
profile. Desktop OS session-lock and sleep notifications revoke only
password-protected sessions, using the protection state established by backend
credential verification. Unprotected sessions remain open through idle, sleep,
and OS lock. Polling and background sync do not extend the idle deadline. React
renders the lock screen; there is no separate native overlay or cover
acknowledgement protocol. Android sets `FLAG_SECURE` while backgrounded and
clears it when the activity resumes. Native lifecycle behavior needs platform
testing.

Windows uses power suspend/resume callbacks alongside session-lock polling.
Linux listens to logind's `PrepareForSleep` signal and holds a delay inhibitor
until access is revoked; it reacquires that handle on resume. If logind denies
the inhibitor, the listener still revokes on resume. Linux sleep/session-lock
integration requires logind; missing sleep subscriptions are logged.

### Self-hosted web

A root manager owns the registry, shared vault, runtime lookup, and browser
grants. Each profile has an existing `Arc<AppState>` service graph, writer,
event bus, and workers. Browsers using the same profile share that runtime.
Configured connected profiles start at server startup; others open on demand.

Instance authentication and profile access are distinct. Authenticated cookies'
stable `sid` values own grants; no-auth mode uses a unique opaque HttpOnly
browser cookie. Tabs sharing an owner share lock/switch state. Other browsers
remain independent. Profile lock does not log out instance authentication or
stop server sync workers.

The web shell closes its financial view when an active profile-state poll fails,
including after a ten-second request timeout. This reuses the normal lock flow
and clears cached financial queries. If the backend cannot be reached, the view
stays closed and Retry completes backend locking after reconnection. Lock
requests also time out after ten seconds so Retry remains available. This
connectivity rule applies to all open web profiles; backend idle expiry remains
independent of browser polling.

Middleware validates the browser owner and `x-wf-profile-scope`, then injects
the fixed runtime into request extensions. SSE uses the cookie plus a non-secret
scope selector; the selector alone grants no access. Grant mutations enforce
same-origin checks. Revocation closes affected streams and rejects stale
delivery. Legacy unscoped API access is limited to a single unprotected default
profile.

Offline database maintenance accepts `--profile <uuid>`; omission selects the
default profile. Operator database encryption remains separate from browser
lock.

## Startup and switching

| Entry                                | Behavior                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------- |
| Cold launch, one unprotected profile | Backend auto-admission, then opening surface and portfolio                  |
| Cold launch, one protected profile   | Chooser with that profile selected; click to enter password                 |
| Cold launch, multiple profiles       | Chooser after authoritative status resolves                                 |
| Switch profile                       | Cover and teardown, chooser, optional password, destination dashboard       |
| Manual or automatic lock             | Retain selected profile in the chooser; click to continue or enter password |
| Resume same profile                  | Preserve route through document reload                                      |
| Create profile                       | Open its dashboard; existing onboarding handles first setup                 |
| Database or initial settings failure | Explicit error with retry and permitted recovery/switch actions             |
| Connect restoration or outage        | Local portfolio stays usable; Connect reports its own status                |

The profile menu remains available for a single unprotected profile, including
profile settings (with optional password setup) and Add profile, which opens
creation directly. With multiple profiles, Switch profile opens the picker. The
Lock action appears only when password protection is enabled. Removing a
password reopens the profile without a chooser. Switching is disabled while
teardown is pending or failed. Status reads are serialized and older transition
results discarded. Browser-tab scope replacement follows the same fresh-document
rule: a different profile goes to the dashboard; a replacement scope for the
same profile retains its route. A native process restart follows cold-launch
policy rather than document-reload route continuity.

The provider sequence is:

```text
AuthGate (web) → ProfileShell → NativeDatabaseGate → SettingsProvider
              → WealthfolioConnectProvider → financial providers/routes
```

The pre-React splash, shared `StartupScreen`, database gate, and initial
settings gate provide a consistent opening presentation. Settings apply theme,
font, direction, and language before revealing routes. Later refreshes keep
routes mounted. The Connect capability check selects its provider before
children mount; network restoration does not gate the local portfolio.

A short-lived per-tab sessionStorage hint carries transition intent and public
profile metadata across reload. It expires after five minutes, validates bundled
avatar IDs, and never contains authority, passwords, keys, callback codes, or
financial routes. Backend status remains authoritative if the hint is absent,
invalid, or disagrees. Reload requests coalesce, including OAuth deferral.

## Avatars

Avatars are bundled assets available offline, selected by stable IDs rather than
uploaded files or remote URLs. The registry stores only `avatarId`; the renderer
maps it to artwork. Names and avatars are visible before unlock and must not be
used as authorization or Connect identity.

The
[avatar renderer](../../apps/frontend/src/features/profiles/profile-avatar.tsx)
defines Sketch, Line, Pixel art, 3D, and Abstract groups. The
[picker](../../apps/frontend/src/features/profiles/profile-avatar-picker.tsx)
filters these groups and exposes selected state through labeled buttons. Unknown
renderer IDs fall back to the first line portrait; backend create/update and
registry validation require an ID in the core allowlist.

Artwork lives in [bundled atlases](../../apps/frontend/public/avatars).
[Persona](../../apps/frontend/src/features/profiles/persona-avatars.tsx) and
[line portrait](../../apps/frontend/src/features/profiles/line-portrait-avatars.tsx)
metadata select atlas cells or crop coordinates. CSS overlays animate eyes,
gaze, blinking, and sculpture movement; abstract faces use a separate patch
atlas.
[Avatar CSS](../../apps/frontend/src/features/profiles/profile-avatar.css)
respects reduced-motion preferences. Decorative artwork is hidden from assistive
technology while controls supply labels and focus states.

When adding an avatar, update the frontend mapping/group, bundled assets, and
core allowlist together. Keep persisted IDs stable. Rendering fallback does not
make removing IDs from the backend allowlist safe: old registries still contain
them. Avatar tests cover rendering, picker behavior, and frontend/backend
parity.

## Connect, OAuth, synchronization, and MCP

Each profile owns Connect credentials, verified issuer/user/team binding, broker
mappings, enrollment nonce, device identity, sync keys, cursors, and outbox.
Lock/switch retain credentials and enrollment rather than invoking Supabase
sign-out. Local unlock works offline; an inability to verify a migrated binding
pauses cloud work without blocking local access.

Candidate credentials are verified before binding. Serialized identity
reservation prevents the same issuer/user ID from attaching to multiple local
profiles. Binding uses user ID rather than email and survives sign-out. A
different account or team requires explicit confirmation. The cloud sync scope
is `(teamId, userId)`; profiles are local and never sent as cloud identities.

Automatic cloud admission re-fetches the verified user/team binding, even when
its access token has not changed. This applies to foreground requests and queued
broker sync. The adopted legacy profile establishes its initial binding from its
server-verified existing session, or its first verified login if signed out,
without clearing broker links or device enrollment. The legacy format did not
record an owner, so that first identity becomes its baseline. Unbound nonlegacy
profiles and changed membership still require explicit reconnection. A user/team
preflight is not atomic with the subsequent cloud request. Preventing membership
changes between those requests requires a cloud API contract that checks the
expected user/team on the operation itself; the current API does not provide
that guarantee.

Temporary Connect transition contention returns HTTP 503, not the HTTP 423 used
for revoked profile authority. The frontend retains its valid local session and
can retry after the transition completes.

The confirmation preview does not persist candidate credentials or change the
binding. A rotated candidate refresh token is kept only in process memory, with
a ten-minute validity window, so confirmation can retry after a human delay.
Confirmation revalidates the candidate against the cloud. Duplicate local
account reservations remain forbidden, including confirmed requests. Ordinary
sign-out keeps the last binding so reconnecting the same account retains
enrollment and switching to another account cannot reuse its keys or cursors.
Unbound nonlegacy profiles with existing cloud credentials or enrollment still
require confirmation and cleanup. The legacy migration exception does not bypass
the post-restore reconnect gate or its credential cleanup.

A confirmed change excludes in-flight profile commands, reserves broker sync,
and serializes login/logout/token refresh. Pairing key writes must match the
current device ID and enrollment nonce; stale UI callbacks cannot recreate an
identity cleared by rebinding. Background engine startup is paused and the
previous worker is stopped and joined. Cleanup clears local enrollment and sync
keys, any pending restore operation, outbox/cursors and broker mappings.
Accounts, holdings, activities, database encryption keys, the local password and
unrelated secrets remain. Broker mappings and sync control state are cleared in
one SQLite writer transaction. No cloud reset or deletion is invoked. Device
sync must be set up again explicitly; retained portfolio data may later be
synced to the new account after that setup.

Cleanup failures leave cloud access gated off and do not store candidate
credentials. The old binding remains until cleanup succeeds. A failed credential
write after successful rebinding leaves reconnect required; retrying the
verified new account can safely complete login.

Supabase keeps its existing login and code-exchange behavior with profile/flow
scoped backend PKCE storage. One pending login is allowed per native
installation or web browser owner, bound to its initiating profile and issuer
with a ten-minute TTL. Switching cancels it; automatic mobile lock can preserve
it until unlock. The shell retains native callback ownership while financial
providers unmount, captures the callback before reloading, and resumes exchange
only for the original flow. Flow correlation rejects late, expired, or replayed
callbacks. Web redirects resolve through the browser's pending flow and remove
callback parameters.

Pairing retains existing frontend crypto and backend snapshot orchestration.
Operations carry the originating scope; ordinary pairing state is discarded on
lock/switch. On the receiving device, the profile's device-sync runtime owns
restoration as one in-memory operation shared by pairing, recurring sync checks
and retries; the UI only displays it. Consent covers one replacement attempt;
the replacement runs as one writer transaction, after which the usual portfolio
update recalculates the restored data. Native lock/switch lets a started restore
transaction finish and cancels the rest; after a restart, committed bootstrap
state decides whether a new attempt is needed. No new remote profile identifier
or device-sync wire format is introduced. Local profile operations never reset a
cloud team or copy keys between household members.

Native MCP closes on lock and reopens against the active context. Web `/mcp`
retains independent PAT authorization. `X-WF-Profile-Id` selects a profile;
omission selects the default. PATs and MCP sessions are validated for that
profile, and browser locking does not revoke independent PAT authorization.

## Scope and verification boundaries

Biometrics, a new web-user ownership system, and cloud household enrollment
changes are outside this feature. This app targets the separately implemented
cloud user-scoped sync adaptation: enrollment, pairing, cursors and snapshots
belong to `(teamId, userId)`. Deploy that cloud adaptation before relying on
separation between members of the same team. No cloud code is changed by this
app feature.

Regression coverage belongs with the core registry/session tests, native
lifecycle tests, server profile integration tests, frontend profile/startup
tests, and
[isolated profile browser suite](../../e2e/README.md#profile-startup-and-switching).
Key invariants are independent databases and credentials, persisted cooldowns,
recovery rotation, stale-scope rejection, pinned delayed writes, callback
ownership, per-browser grants, and destination appearance/route handling.

Release verification must also exercise real native lock/suspend and React
lock-screen paint, OAuth background/return, external-file permissions, encrypted
and missing-key recovery, legacy encrypted backups, and lock/switch during
encryption or restore. Restoring into B must leave A's database, keys, and
Connect credentials unchanged. Browser and unit tests alone do not establish
these guarantees. The previously reported intermittent native white window still
needs a runtime reproduction before its exact cause or resolution can be
asserted.

For Windows and Linux sleep regression checks, unlock a protected profile,
suspend without locking the OS session, and resume within one minute. Confirm
the chooser replaces financial content and the old scope is rejected. Repeat
with an unprotected profile and confirm it stays open. Test OS session locking
separately; it does not establish that sleep notifications work. On Linux also
check the resume fallback when logind denies a delay inhibitor.

### Avatar artwork and startup

Avatar IDs, crop coordinates, eye layers, and atlas paths live in
`apps/frontend/src/features/profiles/avatar-catalog.ts`. `ProfileAvatar` renders
that catalog; `animated={false}` preserves the artwork while disabling movement.
Before React loads, the HTML splash displays the golden logo on a cold launch.
After profile selection, the existing short-lived presentation hint instead
shows the same rounded avatar frame and golden logo used by React’s loading
screen, using shared CSS. The HTML placeholder disappears when React fills the
root. Matching size and position avoid an avatar swap or animation restart. No
React bundle or avatar atlas is needed for the HTML placeholder; it uses the
existing logo asset.

Avatars use the original atlases directly. There are no generated avatar
snapshots, startup markup files, or avatar-generation commands.
