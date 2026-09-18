# Wealthfolio on Unraid

Wealthfolio runs as a standard Docker container managed through Unraid's Docker
tab.

The Community Apps (CA) template is maintained in a dedicated repository so the
CA scanner picks it up cleanly and doesn't see two competing copies:

👉
**[github.com/wealthfolio/wealthfolio-unraid](https://github.com/wealthfolio/wealthfolio-unraid)**

📘 **Full setup guide:**
[wealthfolio.app/docs/guide/self-hosting](https://wealthfolio.app/docs/guide/self-hosting)

## Getting started

### From Community Apps (one-click)

**Apps** tab → search for **Wealthfolio** → **Install** → fill in
`WF_SECRET_KEY`, `WF_AUTH_PASSWORD_HASH`, `WF_CORS_ALLOW_ORIGINS` → **Apply**.

### Manual sideload

If CA hasn't picked up the latest template yet, sideload it directly. SSH into
Unraid (or use the WebTerminal) and run:

```bash
mkdir -p /boot/config/plugins/dockerMan/templates-user
curl -fsSL \
  https://raw.githubusercontent.com/wealthfolio/wealthfolio-unraid/main/templates/wealthfolio.xml \
  -o /boot/config/plugins/dockerMan/templates-user/my-wealthfolio.xml
```

Then **Docker → Add Container → Template → User templates → wealthfolio**.

See the website guide for required values, the password hash recipe, reverse
proxy setup, backups, and troubleshooting.

## Database encryption

Optional and off by default — see
[Database encryption](../README.md#database-encryption-optional) in the
self-hosting README for the full flow.

One Unraid-specific caveat: because this template runs the container as
`99:100`, the offline conversion command must be given the same `--user=99:100`,
or the converted database and its private scratch directory end up owned by a
user the server cannot read. The Console button also won't work for it — it
execs into a running container, and the conversion requires the container to be
stopped.

## Backups and recovery

For portable exports, appdata archive differences, restore between server and
device, and recovery after failure, see [Backups and recovery](../backups.md).
Keep `backups/` and `scratch/` inside the persistent appdata mapping and
writable by `99:100`. Stop the container before raw appdata copies. A
password-protected portable export is independent of the server key; an
encrypted original snapshot or appdata archive still needs that original key.

## Permissions

The image runs as a non-root user (UID 1000) by default. The Unraid template
overrides this via `--user=99:100` in `<ExtraParams>` so the container matches
Unraid's standard `nobody:users` appdata ownership — fresh installs work without
any host-side `chown`.

**Upgrading from an older image** (pre-`v3.4.0`): existing data was written as
`root:root`. Run once on the Unraid host:

```bash
chown -R 99:100 /mnt/user/appdata/wealthfolio
```
