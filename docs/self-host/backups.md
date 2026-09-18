# Backups, portable exports and recovery

This guide covers saved snapshots, portable exports and recovery. For the
implementation and security boundaries, see the
[database encryption and backups architecture](../architecture/database-encryption-and-backups.md).

## Three separate protections

| Item                                             | Protection                                                               | What you need to restore it                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Live server database                             | Optional encryption derived from `WF_SECRET_KEY` or `WF_SECRET_KEY_FILE` | The original server master key and matching encryption configuration |
| Saved snapshot in `backups/`                     | The database encryption used when that snapshot was created              | The original installation key if encrypted                           |
| Password-protected portable export (`.wfbackup`) | A separate backup password chosen during export                          | The backup file and its password; no source installation key         |

Database encryption is off by default. `WF_DB_REQUIRE_ENCRYPTION=1` creates an
encrypted database only when none exists; it does **not** convert an existing
file. Follow the
[enable and disable procedure](README.md#database-encryption-optional) for an
existing deployment. Disabling encryption does not decrypt older snapshots. Keep
the server master key: the credential vault still uses it.

Desktop and mobile use their own OS-protected installation keys. A server key,
device key and portable backup password are different secrets. Export never
changes the live database's encryption or makes the backup password an app login
password. Wealthfolio cannot reset a lost backup password. Keep it in a password
manager, separately from the exported file.

## Automatic backups before database upgrades

When an existing database has pending Diesel migrations, Wealthfolio saves one
verified snapshot before running the whole batch. A release with several
migrations still creates one snapshot per attempt. Fresh installations and
databases already up to date do not create an automatic backup. Backup failure
stops the upgrade before any migration runs.

These snapshots appear as **Before database upgrade** in the backup list. Native
desktop and mobile store them under the app data directory's `backups/`, even
when desktop `DATABASE_URL` points elsewhere. Hosted servers use `backups/`
beside `WF_DB_PATH`; a bare `app.db` uses the current directory. Backups are
kept until manually deleted.

Failed upgrades retain their snapshot and report its location. Relaunch retries
the remaining migrations using Diesel's normal history tracking and can create
another snapshot. Earlier successful migrations can already be committed. Stop a
failing supervisor restart loop: repeated attempts can accumulate snapshots
until free space prevents another backup. There is no automatic rollback or
additional upgrade-state file.

Snapshots retain the encryption they had when created. In particular, an
automatic snapshot created before `db encrypt` remains **unencrypted** after
conversion. Maintenance logs identify its location and protection. Enabling
encryption does not encrypt or delete that historical snapshot.

Upgrades temporarily use SQLite `synchronous=FULL`; everyday pooled connections
continue using `NORMAL`. Upgrade startup takes additional time for copying,
verification and durable writes. The space preflight allows the logical database
size plus 16 MiB on the backup filesystem; migrations such as `VACUUM` can need
additional working space. Keep the app open while upgrading. Native startup
shows the existing opening screen while the backup runs.

Recovery uses the existing flows below. Portable restore validation also runs
migrations, so a deterministically broken migration can prevent restoration
until the application is fixed. Failed mobile startup does not add access to
private saved snapshots; keep portable exports outside the installation too.

## Save a backup and export it

1. Open **Settings → Backup & Export → Backup & Restore**.
2. Select **Back up now**. The completed snapshot appears in the list, showing
   its date, size, protection and reason. No password is required for this step.
3. Select **Export** on the snapshot you want. This exports that snapshot's
   data, not changes made afterward.
4. Keep **Password protected — Recommended** selected. Enter and confirm a
   backup password, or use **Generate passphrase**. Passwords accept spaces and
   Unicode; preserve them exactly. The minimum is 12 characters.
5. Save the `.wfbackup` outside the server/device. Desktop uses a save dialog,
   mobile uses native file handling, and web downloads through the browser.
   **Export ready** means the download was prepared; check that the file was
   actually saved and keep a copy somewhere independent of this installation.

The secondary **Unencrypted database** choice exports a portable `.db`. Anyone
with that file can read its financial data, even when the live database is
encrypted. Each new export defaults back to password protection.

Portable exports carry portfolio data and portable preferences, not the source
installation's credentials and sessions. Reconnect Wealthfolio Connect, device
sync and custom providers after restoring. Exporting does not remove credentials
from the running source installation.

**Advanced: original server snapshot → Save original snapshot** downloads the
original database without portable sanitization or a new backup password. It may
contain installation-specific data. An encrypted original needs its original
server secret, including when the list reports it as unavailable. Use this for
operator recovery; use **Export** for transfers between installations.

## Restore on desktop or mobile

Export on the source installation, then on the destination:

1. Open **Restore from file**, select the export and enter its exact backup
   password (`.wfbackup`), or leave it empty for a plaintext `.db`.
2. Select **Check backup** and review the portfolio summary and destination
   encryption policy.
3. Confirm **Replace portfolio and restore**. This replaces data, not merges it.
   The app saves a fresh snapshot before replacement.
4. Wait for the app to reopen, check your data and reconnect the services you
   use.

A saved snapshot's **Restore** action uses the retained installation key.
Portable exports use their separate backup password. The destination retains its
own encryption policy and key.

## Restore on a server (offline)

The web UI creates, lists, exports and deletes backups. Restore is an offline
command: stop the server/container and prevent automatic restarts first. There
are no web upload, restore, maintenance-status or recovery-retry endpoints.

Run as the server's normal user, with the same `WF_DB_PATH`, master-key source,
`WF_DB_REQUIRE_ENCRYPTION` and data mounts. The ownership lock rejects
restoration while another Wealthfolio process owns the database. Close external
SQLite tools as well. The command requires an existing readable destination; for
a fresh installation, start it once with the intended encryption policy, then
stop it.

For a plaintext portable export or original snapshot readable with this server's
key, inspect first, then confirm replacement:

```sh
wealthfolio-server db restore /backups/portfolio.db
wealthfolio-server db restore /backups/portfolio.db --yes
```

Without `--yes`, the command validates the file and prints a summary, then exits
without replacing the live database. For a protected export, supply the password
through standard input. Never put it in command arguments or an environment
variable. For example, with Bash's hidden input:

```bash
IFS= read -r -s -p 'Backup password: ' backup_password
printf '\n'
printf '%s' "$backup_password" | wealthfolio-server db restore /backups/portfolio.wfbackup --password-stdin
# After reviewing the summary, run the confirmed operation:
printf '%s' "$backup_password" | wealthfolio-server db restore /backups/portfolio.wfbackup --password-stdin --yes
unset backup_password
```

Run with shell tracing disabled. Standard input must be a pipe or redirected
file; terminal input is refused to avoid echoing passwords. All bytes are
preserved, including trailing whitespace. Use `printf '%s'`, not `echo`, to
avoid adding a newline to the password.

For Compose, stop the service and run a one-shot container with the same
project, env-file, overlays and service configuration. Mount the backup
read-only:

```bash
docker compose stop wealthfolio
IFS= read -r -s -p 'Backup password: ' backup_password
printf '\n'
# -T keeps stdin non-TTY. Restart only after a successful restore.
printf '%s' "$backup_password" | docker compose run --rm -T --no-deps \
  -v /absolute/backup-directory:/restore:ro wealthfolio \
  wealthfolio-server db restore /restore/portfolio.wfbackup --password-stdin --yes \
  && docker compose up -d wealthfolio
unset backup_password
```

Use your actual Compose service name. Restart only after the command succeeds,
then verify the restored portfolio. The command validates the backup, saves a
pre-restore snapshot, and installs it under the destination's existing
encryption policy. A portable export can come from a device or another server
without that source's installation key. An original encrypted snapshot requires
its original key; use a portable export when transferring between different
installations.

After a portable restore, reconnect Wealthfolio Connect, sync and custom
providers. Dismissing **Restored portfolio** does not re-enable sync or restore
credentials.

## Storage, proxies and deployment platforms

The parent of `WF_DB_PATH` is the data root. Keep that directory on persistent
storage, including `backups/` and the private `scratch/` directory. The server
account needs directory access to create, rename and remove files, not just
write access to the database file. Keep one Wealthfolio process per data
directory and close external SQLite tools before maintenance. Do not remove its
`.lock` file.

Conversion also verifies the database-directory sync on Unix. If that fails
after replacement, it attempts rollback and reports failure. If rollback cannot
be confirmed, the error identifies a retained managed recovery snapshot.
Enablement uses its destination key for this snapshot, even though the original
live database was plaintext; keep the configured master secret or device key.
Startup does not delete this snapshot. Enablement removes its recovery copy
after durable success or confirmed rollback; a failed attempt can leave an
encrypted snapshot in the list.

Import and export support files up to 2 GiB. This is a file limit, **not** a
total disk budget. Export/import staging, validation, conversion, the current
database, WAL, and pre-restore snapshots can require several full-sized copies
at once. Keep generous free space on the data volume. Snapshots and recovery
archives have no automatic retention policy. Delete only copies you no longer
need; do not remove active scratch files to make room. Large-file and
slow-device resource budgets still require release validation.

Before replacing the live database, Wealthfolio checks available space for a
rollback copy plus 16 MiB of headroom. Startup recovery checks space for its
original-file archive plus the same headroom. These checks use actual file sizes
after staging; they do not reserve disk space or predict the total earlier
staging cost. Concurrent writes, quotas or later service startup can still
exhaust space, so write failures remain errors.

Use HTTPS outside localhost for password-protected export. The browser must
access the API on the same origin. Preserve the external `Host` header and
forwarded protocol through the reverse proxy. Allow enough response time for
export generation and download; server restoration has no HTTP upload or proxy
timeout dependency.

| Deployment                      | Backup and recovery requirements                                                                                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker / Compose                | Persist the whole data directory, reuse the same master key and mounts, and run offline conversion as the same container user. Both image architectures use the same flow.                                                               |
| Unraid                          | Keep the appdata mapping and the template's `99:100` identity for maintenance. Stop the container before taking a raw appdata archive. An appdata archive is not a portable export.                                                      |
| Proxmox native LXC / systemd    | Preserve the configured data directory and environment/key files. The standalone release is Linux AMD64. Run maintenance as the unit's actual user with its environment; a login shell does not automatically inherit `EnvironmentFile`. |
| Proxmox Docker LXC or VM        | Apply the Docker requirements inside the Docker host, including persistent volumes and separate key preservation.                                                                                                                        |
| Coolify / other Docker managers | Persist the data volume and secret configuration across redeploys; avoid overlapping instances sharing the database. Use an offline maintenance job only while the app is stopped.                                                       |
| PikaPods / managed hosting      | Use in-app portable exports where the deployed version supports them. Provider snapshots follow the provider's recovery process; ask the provider about stopped-service conversion or key access if those controls are unavailable.      |

See [Unraid](unraid/README.md) and [Proxmox](proxmox/README.md) for the actual
template and installation paths. Container images and server tarballs bundle
SQLCipher/OpenSSL; operators do not compile them during a normal upgrade. Keep
the server image/binary updated to receive bundled cryptography fixes, and keep
the host's CA certificates installed for outbound HTTPS.

## When restore fails

Read the command's error and preserve any reported recovery snapshot. Correct
space, permissions, key or configuration errors before retrying. Do not replace
files underneath a running server. A failed operation may have rolled back to
the previous database; verify its contents before another restore.

### Server cannot start

There is no server web recovery screen. If startup fails:

1. Stop the service/container and prevent its supervisor from starting another
   instance. Preserve the **complete** current data directory and configuration
   in a separate recovery location, including `-wal`/`-shm` files and any
   existing recovery archives. Retain matching master keys separately.
2. Check the reported database path, mounts, permissions, master-key input and
   `WF_DB_REQUIRE_ENCRYPTION`. Correct a configuration mismatch using the
   [encryption guide](README.md#if-the-server-refuses-to-start).
3. For an operator restore from an original snapshot, use a known complete,
   self-contained database backup with its matching key and policy. With all
   writers stopped, preserve the old main/WAL/SHM set together, then install the
   backup at `WF_DB_PATH` with the service user's ownership. Never combine an
   old WAL with a replacement main database. Start one instance and verify the
   data.
4. If only a portable export is usable, leave the failed installation preserved.
   Start a separate fresh installation in a new data directory, set its intended
   encryption policy and master key, start it once, stop it, and use
   `db restore`. Do not copy a `.wfbackup` over the live `.db`: it is a portable
   container, not a directly openable installation database. Do not run restore
   against the preserved unreadable original.

A lost server master key cannot be recovered from an encrypted raw snapshot or
vault. A previously saved portable export can restore its snapshot data without
that key, but does not recover subsequent changes or source credentials.

On desktop/mobile, the startup recovery screen can inspect a portable export
when the local database cannot open. Recovery preserves the original main and
sidecar files in a `recovery-original-*` directory before installing the
candidate. Keep those archives until recovery has been verified. Local encrypted
snapshots alone do not protect against loss of the device's key.
