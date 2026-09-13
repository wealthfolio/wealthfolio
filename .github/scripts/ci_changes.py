"""Classify NUL-delimited git paths for the PR check jobs."""
import sys


def classify(paths):
    required = dict(frontend=False, rust=False, formatting=False, android=False)
    for path in paths:
        if path.startswith((".github/workflows/", ".github/scripts/")):
            required.update(frontend=True, rust=True, formatting=True, android=True)
        elif path.startswith(("apps/tauri/", "apps/server/", "crates/", ".cargo/")) or path in (
            "Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "rustfmt.toml", ".rustfmt.toml",
        ):
            required["rust"] = True
            # Server-only code is not linked into the mobile app.
            if not path.startswith("apps/server/"):
                required["android"] = True
            if path.startswith("apps/tauri/tauri.conf"):
                required["frontend"] = True
        elif path in ("Dockerfile", ".dockerignore") or path.startswith("docker-compose"):
            required.update(frontend=True, rust=True, formatting=True)
        elif path.startswith("docs/") or path.lower().endswith((".md", ".mdx")):
            required["formatting"] = True
        else:
            required.update(frontend=True, formatting=True)
            if path in ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/frontend/package.json"):
                required["android"] = True
    return required


if __name__ == "__main__":
    paths = sys.stdin.buffer.read().decode("utf-8", errors="surrogateescape").split("\0")
    for name, value in classify(path for path in paths if path).items():
        print(f"{name}={str(value).lower()}")
