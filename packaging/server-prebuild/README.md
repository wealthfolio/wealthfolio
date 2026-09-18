# Wealthfolio Server — Linux amd64 prebuild

Standalone HTTP server build for self-hosting (no Tauri, no desktop runtime).
Built on Ubuntu 22.04 (glibc 2.35) — runs on Debian 12+, Ubuntu 22.04+, and
derivatives. Install the system `ca-certificates` package for outbound HTTPS.
SQLCipher and its OpenSSL cryptography are bundled in the binary; runtime
OpenSSL development packages are not needed.

## Layout

- `wealthfolio-server` — server binary (install to `/usr/local/bin/`)
- `dist/` — frontend static assets (point `WF_STATIC_DIR` here)
- `wealthfolio.service.example` — sample systemd unit
- `LICENSE`

## Quick start

```bash
sudo install -m 755 wealthfolio-server /usr/local/bin/wealthfolio-server
sudo mkdir -p /opt/wealthfolio /opt/wealthfolio_data
sudo cp -r dist /opt/wealthfolio/dist

sudo tee /opt/wealthfolio/.env >/dev/null <<EOF
WF_LISTEN_ADDR=0.0.0.0:8080
WF_DB_PATH=/opt/wealthfolio_data/wealthfolio.db
WF_STATIC_DIR=/opt/wealthfolio/dist
WF_SECRET_KEY=$(openssl rand -base64 32)
WF_AUTH_PASSWORD_HASH=<argon2id hash, see docs/self-host>
# Required when auth is enabled AND you reach the server via a different
# scheme/host/port than the bind address (e.g. reverse proxy). Must match
# the URL in the browser's address bar exactly. Setting "*" is rejected.
WF_CORS_ALLOW_ORIGINS=http://<your-server-ip>:8080
EOF
sudo chmod 600 /opt/wealthfolio/.env

sudo cp wealthfolio.service.example /etc/systemd/system/wealthfolio.service
sudo systemctl enable --now wealthfolio
```

Full self-host docs:
<https://github.com/wealthfolio/wealthfolio/blob/main/docs/self-host/>

## Database encryption

Encryption is off by default. For a new database, set
`WF_DB_REQUIRE_ENCRYPTION=1` in `/opt/wealthfolio/.env` before first startup.
For an existing database, stop the service and follow the
[offline conversion procedure](https://github.com/wealthfolio/wealthfolio/blob/main/docs/self-host/README.md#database-encryption-optional)
before setting the flag. Removing the flag does not decrypt an existing file.

Keep the same `WF_SECRET_KEY` (or mounted `WF_SECRET_KEY_FILE`) across updates
and conversions. Encrypted original database snapshots require their original
master key; password-protected portable exports use a separate backup password.

## Backups and restore

Open **Settings → Backup & Export → Backup & Restore** to save managed
snapshots, export a selected snapshot or inspect and restore a portable file.
Protected exports default to `.wfbackup` and restore on another installation
using only their backup password. The destination keeps its own encryption
setting and key. Reconnect broker/device sync and custom providers afterward.

Keep the entire database directory persistent and writable by the systemd unit's
actual user, including `backups/` and private `scratch/`. Allow room for several
database-sized copies during import/export, in addition to retained backups.
Stop the service before raw file copies or offline encryption conversion; run
those commands with the same environment and identity as the service. Do not
overwrite the main database with a `.wfbackup` file.

The
[backup and recovery guide](https://github.com/wealthfolio/wealthfolio/blob/main/docs/self-host/backups.md)
covers both transfer directions, HTTPS/proxy limits, original snapshots, missing
keys and recovery when the server cannot start. It applies to releases
containing the shared Backup & Restore screen.
