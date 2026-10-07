# Connect transfers and cloud backups

This document describes the app boundaries and their regression coverage. For
build commands and configuration, see
[Connect in source builds](../connect-source-builds.md). For cloud publication,
cleanup and migration details, see the
[cloud design](https://github.com/wealthfolio/wealthfolio-cloud/blob/develop/docs/connect-transfers-and-cloud-backups.md)
and
[rollout runbook](https://github.com/wealthfolio/wealthfolio-cloud/blob/develop/docs/connect-cloud-backups-rollout.md).
These cloud documents require repository access; they are not prerequisites for
building the public app.

## Public connection defaults

`config/connect.defaults.json` is the single source for the production API URL,
desktop hosted OAuth callback and exact approved transfer hosts. The frontend
imports the JSON; shared Rust configuration embeds the same file with
`include_str!`. The desktop and server retain their existing API override paths.
The web OAuth redirect stays on the deployment's own `/auth/callback`.

Transfer hosts resolve in this order: process environment, compiled environment,
then public defaults. An explicit host override replaces the list; it does not
extend it. An explicitly empty override disables transfers with a configuration
error. URLs still require HTTPS, exact hostname matching and approved headers,
without redirects. Never derive the allowlist from a received transfer URL.

Official CI resolves a missing/empty GitHub secret to the public defaults
through `check_connect_build.py --github-env`, then passes that value to later
build steps. A non-empty secret remains an intentional override; changing it
takes precedence over editing the defaults. Docker's optional BuildKit mount
overrides the defaults; the backend build copies the shared configuration file.
Changes to the JSON run frontend, Rust and mobile compilation checks.

**Architecture impact:** source builds no longer require a private CI value to
use direct transfers. Configuration remains local to the build/runtime, with no
network discovery. These defaults do not enable authentication, select a
subscription or grant storage access. Auth configuration, account/profile
admission, signed capabilities and encryption remain required. No migration,
worker, persisted state or retry mechanism is introduced.

## Capture lifecycle and ownership

Cloud backups are explicitly enabled for a profile after the user saves a
recovery code. One selected source captures the complete profile when due,
roughly every 24 hours while available. Quotes, manual prices, preferences and
addon data remain included, even when the contents match an earlier backup. A
successful publication schedules the next capture 24 hours later. An unavailable
source captures when it next becomes available.

Capture uses the existing profile-owned timer, portable export, blocking pool,
secret store, lifecycle cancellation and cloud publication policy. Export,
encryption and upload release Connect lifecycle locks; account or profile
changes cancel obsolete work. Progress and failures are ephemeral local status,
not additional cloud polling or persisted retry state. No logical fingerprint or
separate unchanged-check status is maintained.

Desktop checks at startup and while running. Mobile also checks on resume and
has no suspended background jobs. The web server owns the timer, independent of
the browser. Linked-device backup access uses pairing; recovery provides access
when no reachable device holds the backup key. Local database encryption, sync
enrollment and explicit backup consent stay separate.

Subscription expiry preserves consent and eligibility is checked again after a
relevant action or at the next daily check. The cloud recovery deadline is
preserved through both runtime adapters without client persistence or a separate
request. Renewal clears the deadline without changing source consent.

Optional snapshot-emptiness inspection runs on the existing blocking pool and
falls back to replacement consent when inspection is unavailable. Access-sharing
and non-destructive backup actions notify the due timer without cancelling a
running capture. Policy changes, destructive deletion, account/profile changes
and mobile suspension revoke admitted work. Deleting one old point preserves an
admitted upload.

## Compression and integrity

Gzip level 3 uses the existing backup format. The signed upload descriptor
includes `x-amz-checksum-sha256`, checked locally against the ciphertext before
PUT. Storage enforces the checksum. Cloud completion compares the checksum via
HEAD, with full streaming verification for older objects without one. Released
binary clients remain compatible.

A compression benchmark accepts a disposable portable database. Its contents
must never be logged or uploaded:

```bash
CONNECT_BACKUP_BENCHMARK_EXPORT=/private/disposable-export.db \
  cargo test --locked --release -p wealthfolio-device-sync \
  demo_compression_benchmark -- --ignored --nocapture
```

It compares levels 1, 3, 6 and 9, checks decode compatibility, and reports only
sizes and timings.

## Transfer and recovery review invariants

Changes to backup, snapshot, authentication or restore code must trace both the
Tauri and server callers against these boundaries. Exercise failures between
phases, including retries; a successful small upload does not cover them.

| Boundary                             | Required guarantee                                                                                                                                                                                         | Regression coverage                                                                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Export → prepare → upload → complete | Acquire a current profile-bound token immediately before preparation and each completion attempt. Payload requests never carry a Connect token.                                                            | `capture_phases_refresh_expired_credentials_and_keep_the_publication_ticket`, `snapshot_api_phases_and_retries_acquire_current_credentials`, transfer header restrictions                                                                       |
| Session or capture revocation        | Recheck cancellation after token refresh; revoked work cannot prepare or publish.                                                                                                                          | `revoked_capture_session_does_not_prepare_or_publish`, `snapshot_session_revocation_or_cancellation_during_refresh_prevents_publication`, `capture_generation_is_checked_before_and_after_an_in_flight_refresh`, server handler admission tests |
| Protected backup-key storage         | Every local master key is bound to its cloud key ID. Unbound development values require recovery; they cannot be relabelled or published.                                                                  | `unbound_keys_cannot_be_relabelled_or_shared`, `bound_keys_reject_a_different_cloud_key_id_without_relabeling`, expected source-wait tests                                                                                                      |
| Linked-device key application        | Lifecycle-triggered sharing snapshots and applies under the lifecycle lock, with network work outside it. Identity, master key and session must still match. Restore preview uses the same guarded helper. | `resolved_access_rejects_each_changed_credential_without_overwriting_it`, sign-out/access-sharing tests; both runtimes must compile                                                                                                             |
| Transfer destination configuration   | Missing configuration is distinct from an unapproved destination; neither sends payload bytes.                                                                                                             | `missing_destinations_have_a_distinct_configuration_error`, destination/header restrictions                                                                                                                                                     |
| Uncertain upload outcomes            | Reuse the publication ticket. A lost payload response or transient completion error must not force a new export.                                                                                           | Backup/snapshot completion tests and transfer retry tests                                                                                                                                                                                       |

**Architecture impact:** current-token callbacks use the existing token
lifecycle and account admission; no global authentication retry, new scheduler,
channel, state or migration is added. Both runtimes use the same tested
capture-generation check before and after refresh; pairing completion also
requires a current-token callback. The guarded restore-preview helper snapshots
and applies credentials under the existing lifecycle lock and releases it for
cloud I/O. The unbound master-key fallback and unused fixed-token capture entry
points are removed. Destination validation stays strict; identical payload HTTP
pools are shared, with the request-specific timeout and size bound retained.

Explicit key/policy management commands retain their existing lifecycle
serialization across control calls to protect compound secret/consent updates
and pending-key reconciliation. The lock-free local runtime-health read is
separate. Capture payload work and optional lifecycle-triggered key sharing
release the lifecycle lock for network I/O; management commands preserve this
serialization.

Recovery restores backup access without enabling uploads or changing the source.
An already opted-in source resumes through its existing scheduler. A device
without consent can choose to back up this device separately after recovery.

Related sync behavior must also be reviewed explicitly: enrollment can resume a
restored orphaned installation; pairing candidates exclude the current device;
restore retains installation identifiers but clears old credentials and requires
reconnection; snapshot restoration uses the known tables actually present in the
decrypted image rather than a plaintext cloud table list. The latter preserves
the existing empty-list fallback for released clients.

Before publishing, separately validate the deployed cloud contracts and a full
256 MiB transfer, desktop sleep/resume, physical mobile
opening/resume/suspension, and native restore followed by reconnect/pairing.
Unit tests, compilation and CI approval do not replace these release checks.
