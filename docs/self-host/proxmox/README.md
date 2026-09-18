# Wealthfolio on Proxmox VE

Three sensible install paths on Proxmox: a native LXC via the
[community-scripts](https://community-scripts.github.io/ProxmoxVE/) project,
Docker inside an LXC, or Docker inside a VM. The LXC path matches Proxmox
conventions (no Docker-in-LXC). The current community installer downloads the
prebuilt Linux AMD64 server tarball; it no longer compiles the app locally
([#563](https://github.com/wealthfolio/wealthfolio/issues/563)). Docker
deployments also use prebuilt images.

📘 **Full setup guide:**
[wealthfolio.app/docs/guide/self-hosting](https://wealthfolio.app/docs/guide/self-hosting)

## Getting started: LXC (recommended)

Open a shell on the **Proxmox host** (not inside an existing container) and run:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/ct/wealthfolio.sh)"
```

The installer runs the server on port `8080`. Credentials are written to
`/root/wealthfolio.creds` inside the container. Server configuration, including
`WF_SECRET_KEY`, is in `/opt/wealthfolio/.env`; the systemd service reads that
file. Preserve it alongside backups of `/opt/wealthfolio_data/`.

The release archive contains `wealthfolio-server`, the `dist/` frontend, and a
systemd service example. The standalone prebuild is AMD64; Docker images also
support ARM64. Bundled SQLCipher/OpenSSL compilation happens in our release CI,
so this install path needs no OpenSSL build tools. Keep the normal system CA
certificates installed for outbound HTTPS.

Database encryption remains off by default. See the
[encryption procedure](../README.md#database-encryption-optional) for offline
conversion. Stop `wealthfolio.service`, use the same database path and master
key from `/opt/wealthfolio/.env` for the conversion, then update
`WF_DB_REQUIRE_ENCRYPTION` in that file and start the service. Never generate a
new master key during an upgrade or conversion.

## Backups and recovery

Use [the shared backup flow](../backups.md) for password-protected exports and
restores between this server and desktop/mobile. A portable export needs its
backup password, not the LXC's master key. Raw LXC/data-directory backups still
need the matching key when the database is encrypted.

Stop `wealthfolio.service` before file-level copies or offline conversion. Check
the installed unit's `User`, `WorkingDirectory` and `EnvironmentFile`;
maintenance must use that identity and configuration. Preserve
`/opt/wealthfolio_data/` and the existing `/opt/wealthfolio/.env` (or your
customized paths), keeping secret copies protected. A shell command does not
inherit systemd environment settings. The shared guide includes recovery when
the service cannot start and temporary disk requirements for offline restore.

## Getting started: Docker

If you already run a Docker host (LXC or VM) on Proxmox, just deploy the
container there like any other service. See the website guide above for the full
Compose walkthrough.
