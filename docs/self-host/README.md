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

Back up the database and encrypted vault, and retain the matching master key in
a separately protected recovery location. Check that the backup process can read
the required files. A lost master key cannot be recovered from the vault.

Use one server process per vault. Stop the old instance before starting its
replacement when both use the same vault; overlapping rolling updates can lose
credential changes. Vault writes retain their in-place behavior and are not
crash-atomic.

See [credential storage architecture](../architecture/credential-storage.md) for
the storage and compatibility details.

## Platform pointers

- [**Docker / Docker Compose**](https://wealthfolio.app/docs/guide/self-hosting):
  the canonical path. Full walkthrough on the website.
- [**Unraid**](./unraid/): install via Community Apps. The CA template is
  maintained at
  [`wealthfolio/wealthfolio-unraid`](https://github.com/wealthfolio/wealthfolio-unraid).
- [**Proxmox VE**](./proxmox/): LXC via community-scripts, Docker-in-LXC, or
  Docker VM.
