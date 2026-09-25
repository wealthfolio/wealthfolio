# Android testing

Run commands from the repository root. The generated Android project is already
tracked; there is no need to run `tauri android init` for an existing checkout.

## macOS setup

Install Android Studio with SDK platform 36, platform tools, an emulator system
image, and NDK `28.2.13676358` (the version pinned by the Android project).

```sh
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME="$HOME/Library/Android/sdk"
export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
rustup target add aarch64-linux-android
pnpm install --frozen-lockfile
```

### Why the launcher configures ranlib

[Tauri's Android prerequisites](https://v2.tauri.app/start/prerequisites/#android)
cover the SDK, NDK, Java, Rust targets, and their environment variables; they do
not prescribe a custom ranlib launcher. Wealthfolio has an additional native
build requirement: [the workspace Cargo manifest](../Cargo.toml) enables
`bundled-sqlcipher-vendored-openssl` on `libsqlite3-sys` for database
encryption. This builds OpenSSL from source and requires Perl and the NDK
toolchain.

Without an explicit ranlib setting, our OpenSSL build can select
`aarch64-linux-android-ranlib`, which modern NDKs no longer provide, and fail
during `make install_dev` with `command not found`.
[Android's guidance for other build systems](https://developer.android.com/ndk/guides/other_build_systems)
configures `RANLIB` to use the NDK's `llvm-ranlib` for native dependency builds.

Our existing [pnpm Tauri launcher](../scripts/tauri.mjs) supplies that setting
through `TARGET_RANLIB` for Android commands, selecting the tool from `NDK_HOME`
on macOS, Linux, and Windows. This project-specific workaround makes
`pnpm tauri android dev` and `build` work without requiring each developer or CI
environment to export a separate ranlib variable. It applies only to Android
commands and preserves existing `RANLIB`, `TARGET_RANLIB`, and target-specific
`RANLIB_*` overrides.

The tracked Gradle build task also configures LLVM ranlib for Android Studio
builds. Direct Cargo or Tauri CLI invocations that bypass the pnpm launcher
still need an explicit ranlib setting, for example on macOS:

```sh
export RANLIB_aarch64_linux_android="$NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64/bin/llvm-ranlib"
```

## Run with live reload

Start an emulator from Android Studio's Device Manager, or connect a device with
USB debugging enabled and accept its debugging prompt.

```sh
adb devices -l
pnpm tauri android dev
```

To start an emulator from the terminal, list your configured virtual devices and
use one of the returned names:

```sh
emulator -list-avds
emulator -avd "YOUR_AVD_NAME"
```

Prefer a 16 KB system image to exercise native-library alignment;
`adb shell getconf PAGE_SIZE` should print `16384` on that image.

## Build an installable test APK

```sh
pnpm tauri android build --debug --apk --target aarch64
adb install -r apps/tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
adb shell am start -n com.teymz.wealthfolio/.MainActivity
```

This APK bundles the frontend and does not need a running Vite server. It uses
the checkout's configured service endpoints. Use test accounts and sample data.
The ARM64 target works with Apple Silicon ARM64 emulators and ARM64 devices; use
`x86_64` and its corresponding Rust target for an x86_64 emulator.

## Smoke tests

- Cold launch: no native crash or 16 KB compatibility warning; onboarding
  renders.
- Onboarding: create a test portfolio, select a currency, and reach the
  dashboard.
- Navigation: open accounts, holdings, activities, and settings; check Android
  Back, keyboard dismissal, and content around system bars.
- Persistence: restart the app and confirm test data and settings remain.
- Database encryption: enable it in General Settings, force-stop and reopen the
  app, and verify the same test data is readable. Export a portable backup,
  disable encryption, restart, and restore the export. Re-enable encryption to
  verify the retained key still works.
- Recovery: use an explicit portable export when moving to another device.
  Android automatic backup excludes the database and internal backups because
  their Keystore-protected key cannot accompany them. This also applies while
  database encryption is disabled.
- Files: import a sample CSV through the Android picker; export CSV and a
  database backup to Downloads. Restore that test backup and verify the data
  after restart. Also cancel each picker and check that the app remains usable.
- Connect: complete native browser sign-in and return to the app; repeat with
  cancellation. Verify session restoration after restarting the app.
- Device sync: pair with a test desktop instance, including the QR scanner's
  camera permission flow, then verify a sample update in both directions.

## Checks

```sh
pnpm test --run
pnpm type-check
cargo check -p wealthfolio-app -p wealthfolio-server
git diff --check
```

Inspect native crash reports with `adb logcat -b crash -d`. Avoid sharing raw
app logs or database files that contain account details or financial data.
