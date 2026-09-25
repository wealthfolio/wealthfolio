# CI checks and test artifacts

## Pull requests

PRs run checks selected from the complete diff, including both sides of renamed
files. Mobile jobs only run `cargo check`; they never build APKs or Xcode
archives.

| Check                                                                                  | Selected for                                                   |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Formatting                                                                             | Frontend, docs, and relevant configuration changes             |
| Translation parity                                                                     | Frontend changes                                               |
| Frontend lint, package types, unit tests, production build, browser regressions        | Frontend/package changes                                       |
| Rust formatting, Clippy, workspace tests, AI fixture tests, server release compilation | Rust/dependency changes                                        |
| Android ARM64 compilation                                                              | Shared Rust, Tauri, mobile dependencies, Android configuration |
| iOS device and simulator compilation                                                   | Shared Rust, Tauri, mobile dependencies, iOS configuration     |
| Build Status                                                                           | Every PR; all selected jobs must succeed                       |

Docs and ordinary frontend changes skip mobile checks. Server-only Rust changes
also skip them. Platform-specific files select their platform; mixed changes
combine requirements. CI workflow/script changes select all PR checks.

CI helper tests include a real HTTP check that the smoke client retains the
browser cookie between backup export and download. The independent **Docker**
workflow also builds and smoke-tests AMD64 and ARM64 images on PRs touching the
server, storage, profile/secret handling, Rust dependency inputs, Docker build
files, or CI scripts. PR runs never publish images.

The frontend job builds package declarations once and checks frontend types in
the production build. Existing HTTP/TLS and native/server secret-store workflows
remain independent, with their existing path filters and platform coverage.

Compile checks need native toolchains and can still be expensive on a cold
cache. They do not validate linking, packaging, or device behavior. Run **Build
Mobile** before merging risky native, dependency, or packaging changes when that
coverage is needed.

## Full mobile builds

**Build Mobile** runs only when manually launched from Actions. It runs the
reusable Android release APK build, plus iOS device compilation and a full
unsigned debug simulator archive. It uploads test artifacts for seven days and
creates no GitHub release. These are build validations, not store publication.
The simulator archive does not run on physical iPhones.

The cache-warming workflow runs on selected `main` pushes, weekly, or manually.

## Validate a release without publishing

Push the changes to a branch, then manually run both **Release** and **Docker**
from **Actions → Run workflow**, selecting that branch. You can also use the CLI
(replace `your-branch` with the branch containing these workflow changes):

```sh
gh workflow run release.yml --ref your-branch
gh workflow run docker-publish.yml --ref your-branch
gh run list --workflow release.yml --branch your-branch --limit 5
gh run list --workflow docker-publish.yml --branch your-branch --limit 5
gh run watch RUN_ID --exit-status
```

Watch each run ID. **Release** validates all six desktop targets plus the Linux
server tarball, including the Debian 13 smoke test. Signing and macOS
notarization still run, so the repository's usual release secrets are required.
Successful manual runs retain desktop packages and the server tarball/checksum
as Actions artifacts for seven days. **Docker** builds and smoke-tests both
architectures; its publish job is expected to be skipped.

For refs containing these updated workflows, manual runs never
create a tag or GitHub release and never push registry images. Only matching
tag **pushes** publish with these workflow versions.

**Do not select an older release tag for validation.** GitHub runs the workflow
version stored at the selected ref. Tags created before these guards retain the
old workflows, which can publish Docker images or upload and replace release
assets even when launched manually. Use the updated branch, or `main` after
these changes are merged.

These validation runs exercise builds, signing, packaging, and smoke tests; they
do not verify GitHub release uploads or Docker registry publication permissions.
For PR validation, also check **PR Check** and any selected compatibility
workflows. Mobile packages can be validated separately using **Build Mobile**.

To run the focused regression checks locally:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s .github/scripts -p 'test_*.py'
docker build -t wealthfolio-smoke:local .
python3 .github/scripts/encryption_smoke.py --image wealthfolio-smoke:local
```

For an extracted Linux AMD64 server package, use
`python3 .github/scripts/encryption_smoke.py --package /absolute/path/to/package`.
Both smoke modes require Docker and use disposable containers and data volumes.
They check portable export/restore, persistence, encryption conversion, and
wrong-key rejection when a profile database is opened. A healthy HTTP listener
alone does not prove a database key is valid because profiles open lazily.

## Downloadable test packages

Once merged into the default branch, select a workflow under **Actions → Run
workflow**, choose the branch, and download from the completed run's
**Artifacts** section. Downloads include the source commit in their artifact
names and expire after seven days. These workflows create no tag or GitHub
release.

| Manual workflow                    | Artifact                                                    |
| ---------------------------------- | ----------------------------------------------------------- |
| Build Android APK                  | Release-mode ARM64 APK, signed with a temporary test key    |
| Build Linux Packages               | Release-mode x64 AppImage and `.deb`, built on Ubuntu 24.04 |
| Build Windows Installer (existing) | ARM64 or x64 NSIS installer                                 |
| Build Mobile                       | Android test APK and unsigned iOS simulator archive         |

Android APKs cannot update store installs or APKs from another run because each
run uses a different test signing key. Use a test device or emulator;
uninstalling an existing install deletes its local app data. The key is not
uploaded. These APKs are for sideload testing, not store distribution.

Linux test packages disable updater artifact signing and require a compatible
system with the runtime libraries. Android and Linux use the repository's
existing Connect variables and require no production signing secrets.
