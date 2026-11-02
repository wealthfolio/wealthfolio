"""Classify NUL-delimited git paths for the PR check jobs."""
import sys


# The standalone browser harness loads the addon runtime and its shared UI,
# localization, styles, and build inputs; ordinary application pages are not used.
ADDON_SANDBOX_PREFIXES = (
    "apps/frontend/src/addons/", "apps/frontend/src/i18n/",
    "apps/frontend/src/themes/", "apps/frontend/scripts/",
    "packages/ui/", "packages/addon-sdk/", "packages/addon-dev-tools/",
    "e2e/addon-sandbox/",
)
ADDON_SANDBOX_FILES = {
    "apps/frontend/addon-sandbox.html", "apps/frontend/index.html",
    "apps/frontend/src/globals.css", "apps/frontend/src/lib/id.ts",
    "apps/frontend/src/lib/utils.ts", "apps/frontend/src/lib/asset-logo-registry.ts",
    "apps/frontend/src/lib/types.ts", "apps/frontend/package.json",
    "apps/frontend/vite.config.ts", "apps/frontend/vite.addon-sandbox.config.ts",
    "apps/frontend/tsconfig.json", "apps/frontend/tsconfig.node.json",
    "playwright.addon-sandbox.config.ts", "scripts/run-addon-sandbox-e2e.mjs",
    "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc",
    ".node-version", "tsconfig.base.json",
}


def classify(paths):
    required = dict(frontend=False, rust=False, formatting=False, android=False,
                    ios=False, addon_sandbox=False)
    for path in paths:
        if path.startswith((".github/workflows/", ".github/scripts/")) or path == "config/connect.defaults.json":
            required.update({name: True for name in required})
        elif path.startswith("docs/") or path.lower().endswith((".md", ".mdx")):
            required["formatting"] = True
        elif path.startswith(("apps/tauri/gen/android/", "apps/tauri/icons/android/")) or path in (
            "apps/tauri/tauri.android.conf.json", "apps/tauri/capabilities/android.json",
        ):
            required.update(rust=True, android=True)
        elif path.startswith(("apps/tauri/gen/apple/", "apps/tauri/icons/ios/")) or path in (
            "apps/tauri/Info.ios.plist", "apps/tauri/tauri.ios.conf.json",
            "apps/tauri/capabilities/ios.json", "apps/tauri/scripts/sync-ios-composer-icon.mjs",
        ):
            required.update(rust=True, ios=True)
        elif path.startswith(("apps/tauri/", "apps/server/", "crates/", ".cargo/")) or path in (
            "Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml", "rustfmt.toml", ".rustfmt.toml",
        ):
            required["rust"] = True
            # Server-only code is not linked into either mobile app.
            if not path.startswith("apps/server/"):
                required.update(android=True, ios=True)
            if path.startswith("apps/tauri/tauri.conf") or path == "apps/server/src/api.rs":
                required["frontend"] = True
        elif path in ("Dockerfile", ".dockerignore") or path.startswith("docker-compose"):
            required.update(frontend=True, rust=True, formatting=True)
        else:
            required.update(frontend=True, formatting=True)
            if path in ("package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "apps/frontend/package.json"):
                required.update(android=True, ios=True)
        if not path.lower().endswith((".md", ".mdx")) and (
            path.startswith(ADDON_SANDBOX_PREFIXES) or path in ADDON_SANDBOX_FILES
        ):
            required["addon_sandbox"] = True
    return required


if __name__ == "__main__":
    paths = sys.stdin.buffer.read().decode("utf-8", errors="surrogateescape").split("\0")
    for name, value in classify(path for path in paths if path).items():
        print(f"{name}={str(value).lower()}")
