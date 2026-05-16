# Self-Hosting Wealthfolio

Wealthfolio ships an official Docker image so you can run the web edition on
your own hardware. Full self-hosting guides live on the website:

📘
**[wealthfolio.app/docs/guide/self-hosting](https://wealthfolio.app/docs/guide/self-hosting)**

This directory only holds short pointers per platform — the per-platform
artifacts (such as the Unraid Community Apps template) live in their own
repositories.

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

## Permissions

The container runs as a non-root user (UID/GID **1000:1000**).

**Fresh install:** Docker named volumes work out of the box. For a bind mount,
make the host directory writable by UID 1000:

```bash
mkdir -p ./data && sudo chown -R 1000:1000 ./data
```

**Upgrading from an older image:** existing data is owned by `root` and must be
chowned once. Pick the line that matches your setup:

```bash
# named volume
docker run --rm -v <your-volume>:/data alpine chown -R 1000:1000 /data
# bind mount
sudo chown -R 1000:1000 /path/to/your/data
```

## Platform pointers

- [**Docker / Docker Compose**](https://wealthfolio.app/docs/guide/self-hosting):
  the canonical path. Full walkthrough on the website.
- [**Unraid**](./unraid/): install via Community Apps. The CA template is
  maintained at
  [`wealthfolio/wealthfolio-unraid`](https://github.com/wealthfolio/wealthfolio-unraid).
- [**Proxmox VE**](./proxmox/): LXC via community-scripts, Docker-in-LXC, or
  Docker VM.
