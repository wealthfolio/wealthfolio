#!/usr/bin/env bash
# Run local CI checks before commit/push.
# Usage:
#   bash scripts/ci-check.sh           # fast checks (commit mode)
#   bash scripts/ci-check.sh --full    # full PR CI checks (push mode)

set -euo pipefail

FULL=false
if [[ "${1:-}" == "--full" ]]; then
  FULL=true
  shift
fi

if [[ "$#" -ne 0 ]]; then
  echo "Usage: scripts/ci-check.sh [--full]" >&2
  exit 2
fi

REPO_ROOT="$(git -C "$(dirname "${BASH_SOURCE[0]}")/.." rev-parse --show-toplevel)"
cd "$REPO_ROOT"

changed_files() {
  if [[ "$FULL" == "false" ]]; then
    git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true
    return
  fi

  local base=""
  if git rev-parse --verify --quiet "@{upstream}" >/dev/null; then
    base="$(git merge-base HEAD "@{upstream}")"
  elif git rev-parse --verify --quiet origin/main >/dev/null; then
    base="$(git merge-base HEAD origin/main)"
  elif git rev-parse --verify --quiet main >/dev/null; then
    base="$(git merge-base HEAD main)"
  fi

  if [[ -n "$base" ]]; then
    git diff --name-only --diff-filter=ACMR "$base"...HEAD 2>/dev/null || true
  else
    git diff --name-only --diff-filter=ACMR HEAD~1...HEAD 2>/dev/null || true
  fi
}

is_docs_only_file() {
  case "$1" in
    *.md|*.mdx|*.txt|LICENSE|CLA.md|TRADEMARKS.md|docs/*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

CHANGED="$(changed_files)"

if [[ -z "$CHANGED" ]]; then
  exit 0
fi

RUN_RUST=false
RUN_FRONTEND=false
HAS_NON_DOC=false

while IFS= read -r file; do
  [[ -z "$file" ]] && continue

  if ! is_docs_only_file "$file"; then
    HAS_NON_DOC=true
  fi

  case "$file" in
    *.rs|Cargo.toml|Cargo.lock|rust-toolchain*|.cargo/*)
      RUN_RUST=true
      ;;
    crates/*/Cargo.toml|apps/*/Cargo.toml)
      RUN_RUST=true
      ;;
    *.ts|*.tsx|*.js|*.jsx|*.css|*.mjs|*.cjs|*.json)
      RUN_FRONTEND=true
      ;;
    package.json|pnpm-lock.yaml|pnpm-workspace.yaml|tsconfig*.json)
      RUN_FRONTEND=true
      ;;
    vite.config.*|eslint.config.*|prettier.config.*)
      RUN_FRONTEND=true
      ;;
    postcss.config.*|tailwind.config.*)
      RUN_FRONTEND=true
      ;;
    apps/frontend/*|packages/*/package.json)
      RUN_FRONTEND=true
      ;;
    .github/workflows/pr-check.yml|scripts/ci-check.sh)
      RUN_RUST=true
      RUN_FRONTEND=true
      ;;
  esac
done <<< "$CHANGED"

if [[ "$FULL" == "true" && "$HAS_NON_DOC" == "true" ]]; then
  RUN_RUST=true
  RUN_FRONTEND=true
fi

if [[ "$RUN_RUST" == "false" && "$RUN_FRONTEND" == "false" ]]; then
  exit 0
fi

ensure_tauri_dist() {
  if [[ ! -f dist/index.html ]]; then
    mkdir -p dist
    echo '<!DOCTYPE html><html><head></head><body></body></html>' > dist/index.html
  fi
}

if [[ "$RUN_RUST" == "true" ]]; then
  ensure_tauri_dist

  echo "=== cargo fmt ===" >&2
  cargo fmt --all -- --check

  echo "=== cargo clippy ===" >&2
  cargo clippy --workspace --all-targets --all-features -- -D warnings

  if [[ "$FULL" == "true" ]]; then
    echo "=== cargo test ===" >&2
    CONNECT_API_URL=http://test.local cargo test --workspace

    echo "=== cargo build (wealthfolio-server) ===" >&2
    cargo build -p wealthfolio-server --release
  fi
fi

if [[ "$RUN_FRONTEND" == "true" ]]; then
  echo "=== pnpm build:types ===" >&2
  pnpm run build:types

  echo "=== pnpm format:check ===" >&2
  pnpm format:check

  echo "=== pnpm lint ===" >&2
  pnpm lint

  echo "=== pnpm type-check ===" >&2
  pnpm type-check

  if [[ "$FULL" == "true" ]]; then
    echo "=== pnpm test ===" >&2
    pnpm test

    echo "=== pnpm build ===" >&2
    pnpm build
  fi
fi
