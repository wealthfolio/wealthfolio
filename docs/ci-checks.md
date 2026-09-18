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

The frontend job builds package declarations once and checks frontend types in
the production build. Existing HTTP/TLS and native/server secret-store workflows
remain independent, with their existing path filters and platform coverage.

Compile checks need native toolchains and can still be expensive on a cold
cache. They do not validate linking, packaging, or device behavior. Run **Build
Mobile** before merging risky native, dependency, or packaging changes when that
coverage is needed.

## Full mobile builds

**Build Mobile** runs on `v*` release tags or manually from Actions. It runs the
reusable Android release APK build, plus iOS device compilation and a full
unsigned debug simulator archive. It uploads test artifacts for seven days and
creates no GitHub release. These are build validations, not store publication.
The simulator archive does not run on physical iPhones.

Existing desktop/server release and Docker workflows remain unchanged. The
existing cache-warming workflow runs on selected `main` pushes, weekly, or
manually; there is no general nightly test suite added here.

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
