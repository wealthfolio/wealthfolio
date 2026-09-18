# Self-Hosting Wealthfolio

Wealthfolio ships an official Docker image so you can run the web edition on
your own hardware.

For more documentation, including platform setup, configuration, reverse
proxies, and troubleshooting, see the
**[full self-hosting guides on the Wealthfolio website](https://wealthfolio.app/docs/guide/self-hosting/)**.

This guide covers shared deployment configuration. Platform-specific pointers
are below; artifacts such as the Unraid Community Apps template live in their
own repositories.

## Image

Multi-arch (`linux/amd64`, `linux/arm64`), published on every `v*.*.*` tag:

| Registry   | Image                                         |
| ---------- | --------------------------------------------- |
| Docker Hub | `wealthfolio/wealthfolio:latest` _(primary)_  |
| Docker Hub | `afadil/wealthfolio:latest` _(legacy mirror)_ |
| GHCR       | `ghcr.io/wealthfolio/wealthfolio:latest`      |

```bash
docker pull wealthfolio/wealthfolio:latest
```

Existing deployments that pin `afadil/wealthfolio:latest` keep working — both
Docker Hub repos receive the same multi-arch build from CI. New deployments
should prefer `wealthfolio/wealthfolio`.

## Master-key configuration

Configure exactly one nonempty master-key input. Existing `WF_SECRET_KEY`
deployments continue to work without changes.

| Variable             | Purpose                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `WF_SECRET_KEY`      | Master-key value: a base64-encoded 32-byte key is recommended.                                                                         |
| `WF_SECRET_KEY_FILE` | Path to a UTF-8 file containing the same key value.                                                                                    |
| `WF_SECRET_FILE`     | Path to the **encrypted vault**, default `/data/secrets.json` in the supplied Compose configuration. This is not the master-key input. |

The key file is read once at startup. LF and CRLF endings are accepted. Empty
environment values count as unset; configuring both inputs, neither input, or an
unreadable/invalid key file prevents startup. Switching inputs must reuse the
existing key, otherwise stored credentials cannot be decrypted.

### Docker Compose with a key file

Create the key file on the host before deployment. Protect it from other users
and make it readable by the container's actual runtime user. Keep it outside the
image, repository, and data-volume backups.

Save the following as `compose.secret-key.yml` alongside `compose.yml`,
replacing `/protected/wealthfolio-key` with the existing host file's absolute
path:

```yaml
services:
  wealthfolio:
    environment:
      WF_SECRET_KEY: ""
      WF_SECRET_KEY_FILE: /run/secrets/wealthfolio_key
    volumes:
      - type: bind
        source: /protected/wealthfolio-key
        target: /run/secrets/wealthfolio_key
        read_only: true
        bind:
          create_host_path: false
```

From the repository root:

```bash
docker compose --env-file .env.docker -f compose.yml -f compose.secret-key.yml up -d
```

Keep the existing authentication and CORS configuration in `.env.docker`.
Setting `WF_SECRET_KEY_FILE` alone does not mount the file: its value must name
the path **inside the container**. The override above leaves the master-key
value empty and mounts the key read-only; the existing `/data` volume remains
available for the database and encrypted vault.

For plain `docker run`, add these options to your existing command and omit
`-e WF_SECRET_KEY=...`:

```bash
--mount type=bind,source=/protected/wealthfolio-key,target=/run/secrets/wealthfolio_key,readonly \
-e WF_SECRET_KEY_FILE=/run/secrets/wealthfolio_key
```

Native servers use a host path instead; see the
[server README](../../apps/server/README.md#file-based-master-key).

## Permissions and existing deployments

The image defaults to UID/GID **1000:1000**. An explicit user override changes
that identity; for example, the [Unraid template](unraid/README.md#permissions)
uses **99:100**. Use the actual runtime identity when setting file access.

Docker named volumes work with the default image user. For new bind-mounted data
directories, grant that user the access needed for the database and vault. Older
deployments created by a root-running image may need an ownership repair if the
current runtime user cannot access their data. This is independent of whether
the master key comes from an environment variable or a file.

Existing vault ownership, modes, ACLs, symlinks, and individual file mounts are
preserved. There is no startup requirement to change vault permissions. A
writable vault in a non-writable directory remains supported; creating a new
vault requires a writable parent directory. The database and other application
files retain their own directory-access requirements.

## Backups and upgrades

For the shared Backups screen, password-protected exports, transfers between
server and devices, and failure recovery, see
[Backups and recovery](backups.md). Live database encryption, saved snapshots
and portable backup passwords are separate protections; that guide explains
which key each requires.

Back up the database and encrypted vault, and retain the matching master key in
a separately protected recovery location. Check that the backup process can read
the required files. A lost master key cannot be recovered from the vault.

Use one server process per vault. Stop the old instance before starting its
replacement when both use the same vault; overlapping rolling updates can lose
credential changes. Vault writes retain their in-place behavior and are not
crash-atomic.

See [credential storage architecture](../architecture/credential-storage.md) for
the storage and compatibility details.

## Database encryption (optional)

Database encryption is **off by default**. When enabled, SQLCipher encrypts the
database using a key derived from the master key supplied through
`WF_SECRET_KEY` or `WF_SECRET_KEY_FILE`. Keep that same key when converting or
restarting.

**Changing `WF_DB_REQUIRE_ENCRYPTION` does not convert an existing database.**
It controls creation of a new database and checks the encryption state at
startup:

| Database before startup     | Flag unset or `0`                                          | Flag set to `1`                                  |
| --------------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| No database yet             | Creates a plaintext database                               | Creates an encrypted database                    |
| Existing plaintext database | Starts normally                                            | Refuses to start; run `db encrypt` offline first |
| Existing encrypted database | Refuses to start; set the flag or run `db decrypt` offline | Starts with the matching master key              |

To change an existing database, stop the server and use
`wealthfolio-server db encrypt` or `wealthfolio-server db decrypt`. Then set the
startup flag to match the result and restart.

For every Compose command below, use the same project, `--env-file`, and `-f`
options as your normal deployment. For example, if you normally use
`docker compose --env-file .env.docker`, use that prefix for maintenance too.

### New installation (no database yet)

Before the first startup, set this in the environment file used by the shipped
Compose configuration (for example, `.env.docker`):

```dotenv
WF_DB_REQUIRE_ENCRYPTION=1
```

The shipped `compose.yml` passes this value into the container and defaults to
`0` when it is unset or empty. Use `--env-file .env.docker` with your Compose
commands if that is your environment file. Keep your existing authentication,
master key, ports, and data-volume configuration.

For a custom Compose file, ensure its service has this environment mapping:

```yaml
services:
  wealthfolio:
    environment:
      WF_DB_REQUIRE_ENCRYPTION: "${WF_DB_REQUIRE_ENCRYPTION:-0}"
```

With plain Docker, add `-e WF_DB_REQUIRE_ENCRYPTION=1` to your normal
`docker run` command before the image name.

Start the deployment normally. The database is created encrypted from its first
write; no conversion command is needed. Confirm the result in **Settings →
General → Database Encryption**, which reports the file's actual state. If the
data volume already contains a plaintext database, follow the
existing-installation steps instead.

### Enable encryption on an existing installation

**1. Stop the server and close external SQLite tools.** Conversion replaces the
database file. Wealthfolio holds an OS-backed `<database-path>.lock` ownership
lock for the server lifetime and throughout conversion, so maintenance against a
running instance is rejected before cleanup or migration. External SQLite tools
and older Wealthfolio versions do not honor this lock and must be stopped
manually. Keep the lock file in the shared data volume and do not delete it; the
OS releases the lock when its process exits, including after a crash. If the
database filename is a symbolic link, use the real database path for conversion;
maintenance refuses to replace the link itself.

```bash
docker compose stop wealthfolio
```

Plain Docker: `docker stop wealthfolio`.

**2. Back up the data directory.** Copy the whole directory rather than just the
`.db` file: if a `-wal` file sits beside it, the newest transactions live there
and copying the database alone loses them.

The command below uses the stopped `wealthfolio` container's actual volume,
including any Compose project prefix. If you renamed the container, replace
`wealthfolio` with its name. It assumes your data is mounted at `/data`.

```bash
docker run --rm --volumes-from wealthfolio:ro -v "$PWD":/backup alpine tar czf /backup/wealthfolio-backup.tar.gz -C /data .
```

This archive is your rollback point. `db encrypt` does take its own
pre-operation backup, but deletes it on success — that copy is an unencrypted
duplicate of everything you just encrypted, so it goes to a private scratch
directory and is removed as soon as the encrypted database verifies (and cleared
at the next start if a crash interrupts). Keep your own archive until the server
is back up and the data looks right.

**3. Convert the database.** With Compose:

```bash
docker compose run --rm wealthfolio wealthfolio-server db encrypt
```

Both `db encrypt` and `db decrypt` accept the same key sources as server
startup: set exactly one of `WF_SECRET_KEY` or `WF_SECRET_KEY_FILE` (empty
environment values count as unset). For a file-based key, reuse the same
secret-file mount and path in the maintenance container.

With plain Docker, run a one-shot container over the same volume and the same
`WF_SECRET_KEY` — the key is derived from it, so a different secret produces a
database the server cannot open:

```bash
docker run --rm -v wealthfolio-data:/data -e WF_SECRET_KEY='<your-secret>' wealthfolio/wealthfolio:latest wealthfolio-server db encrypt
```

Expect `Database at /data/wealthfolio.db is now encrypted`. The command refuses
to run when there is no database at `WF_DB_PATH` instead of creating an empty
one, so a mistyped path or an unmounted volume is a clear error rather than a
silently empty database. Allow space for at least three additional
database-sized copies, plus WAL and filesystem headroom, on the volume while it
runs. Before replacement, the command requires free space for a rollback copy
plus 16 MiB; this check does not reserve space against other processes.

**4. Set the container requirement and restart.** After conversion succeeds, set
`WF_DB_REQUIRE_ENCRYPTION=1` in your deployment's environment file. The shipped
Compose configuration forwards it to the container. Then recreate the service
using the same `--env-file` and other deployment options:

```bash
docker compose up -d wealthfolio
```

With plain Docker a variable cannot be added to an existing container: remove it
with `docker rm wealthfolio` and re-run your original `docker run` line with
`-e WF_DB_REQUIRE_ENCRYPTION=1` appended. Calling `docker start` on the old
container instead leaves the variable unset, and the server will refuse to boot
against the now-encrypted database.

### Platform notes

**Unraid.** The Community Apps template runs the container as `--user=99:100`
(`nobody:users`) rather than the image default of `1000:1000`. The one-shot
conversion container must use the **same** user and the same appdata path, or
the files it creates — the converted database and the private `scratch/`
directory, which is created owner-only — end up owned by a user the server
cannot read or write:

```bash
docker run --rm --user=99:100 -v /mnt/user/appdata/wealthfolio:/data -e WF_SECRET_KEY='<your-secret>' wealthfolio/wealthfolio:latest wealthfolio-server db encrypt
```

Add `WF_DB_REQUIRE_ENCRYPTION` as a Variable in **Docker → wealthfolio → Edit**
afterwards. Note that Unraid's Console button execs into a _running_ container,
which is exactly what the conversion refuses to work against — run the command
above from the Unraid terminal instead, with the container stopped.

Raw appdata archives copy the database as-is; an encrypted archive needs the
original master key. Stop the container before making a file-level archive and
keep the key separately protected. To transfer data without that installation
key, create a
[password-protected portable export](backups.md#save-a-backup-and-export-it).

**Installs without Docker** (for example the Proxmox LXC from
community-scripts): the same two steps apply, minus the container. Stop the
service, run `wealthfolio-server db encrypt` directly as the same user the
service runs as, add `WF_DB_REQUIRE_ENCRYPTION=1` to the unit's environment (or
its `EnvironmentFile`), and start it again.

Builds from source now link SQLCipher against a vendored OpenSSL, which needs
`perl` and a C toolchain present at build time — worth knowing if you maintain
your own build script, since a missing `perl` fails the build rather than
degrading gracefully.

### Disable encryption on an existing installation

**1. Stop the server and close external SQLite tools.**

```bash
docker compose stop wealthfolio
```

**2. Back up the complete data directory** using the backup procedure above.
Keep the current master key; decryption requires it.

**3. Decrypt the database using the same volume and key configuration.**

```bash
docker compose run --rm wealthfolio wealthfolio-server db decrypt
```

Wait for the command to succeed before changing the startup configuration. The
maintenance command can decrypt while the service configuration still has
`WF_DB_REQUIRE_ENCRYPTION=1`; that flag governs server startup.

**4. Set `WF_DB_REQUIRE_ENCRYPTION=0` in your deployment's environment file.**
If a custom Compose file or overlay hardcodes the flag to `"1"`, update that
mapping too. Then recreate the service using the same deployment options:

```bash
docker compose up -d wealthfolio
```

Confirm that **Settings → General → Database Encryption** reports encryption as
disabled. Removing the flag alone does not decrypt the file.

For plain Docker, stop the container and use the one-shot conversion command
above with `db decrypt` in place of `db encrypt`, preserving the same volume,
user, and master key. After success, recreate your server container using your
normal `docker run` command without `-e WF_DB_REQUIRE_ENCRYPTION=1`.

`db decrypt` keeps its encrypted pre-operation backup in `<data>/backups/`.
Previously encrypted backups remain encrypted and still require the original
master key. Keep the master key configured: the secrets vault still uses it even
when database encryption is disabled.

### If the server refuses to start

**It fails closed in both directions.** The server refuses to start if the
database is encrypted while `WF_DB_REQUIRE_ENCRYPTION` is unset, and if the
variable is set while the database is still plaintext. Neither state is silently
accepted: one would run a configuration you did not ask for, the other would
claim encryption the file does not have. In practice this error means you
completed one half of the change and not the other, and the message names the
command that finishes it.

Saved snapshots inherit the database's encryption at creation and retain it
after the live setting changes. An encrypted original requires its original
master key. **Export** creates a separate portable copy protected by its backup
password (or plaintext only when explicitly selected); see
[Backups and recovery](backups.md).

### Preserving the master key

**Master-key rotation is not currently supported.** Keep the same master-key
value across upgrades, restarts, and database encryption changes, whether
supplied through `WF_SECRET_KEY` or `WF_SECRET_KEY_FILE`.

The master key derives the session/JWT signing key, the `secrets.json`
encryption key, and the database key. Changing it does not automatically
re-encrypt the vault or database: existing credentials and encrypted data become
unreadable with the new key. The `db decrypt` and `db encrypt` commands convert
only the database; they do not rotate the vault key.

Keep a secure copy of the master key alongside your recovery plan. Restoring
`secrets.json` or an encrypted database backup requires the key that protected
that backup. Do not discard keys still needed by retained backups.

## Platform pointers

- [**Docker / Docker Compose**](https://wealthfolio.app/docs/guide/self-hosting):
  the canonical path. Full walkthrough on the website.
- [**Unraid**](./unraid/): install via Community Apps. The CA template is
  maintained at
  [`wealthfolio/wealthfolio-unraid`](https://github.com/wealthfolio/wealthfolio-unraid).
- [**Proxmox VE**](./proxmox/): LXC via community-scripts, Docker-in-LXC, or
  Docker VM.
