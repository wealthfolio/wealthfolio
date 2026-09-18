# Migration backup validation — 2026-09-14

Validation ran on macOS / Apple Silicon with locked dependencies and debug Rust
builds. All database fixtures were synthetic and temporary.

## Functional checks

- Eight focused storage tests cover fresh/current/scratch databases, two pending
  migrations, original schema/data, committed WAL contents, plaintext/encrypted
  snapshots, backup/preflight/verification failures, partial migration failure,
  retry preservation, ownership, missing/unreadable history, `FULL` during
  migrations, pooled `NORMAL`, and an overridden database path with a separate
  backup root.
- Native startup gate tests cover the opening screen, readiness gating, and a
  failed upgrade displaying the retained backup location.
- Server integration tests cover a bare `app.db` path, the plaintext migration
  snapshot retained and reported by `db encrypt`, and a later service failure
  leaving the completed schema upgrade intact.
- An isolated localhost server smoke test exercised fresh startup, an upgrade
  with two pending migrations, portable export/download and offline validation,
  and a subsequent launch. The 5,000 synthetic assets survived; exactly one
  migration snapshot retained the original schema and data. Fresh/current
  launches and portable validation created no additional snapshots.
- An independent code-review agent found no blocking issues in migration
  detection, snapshot publication, encryption, disk preflight, ownership during
  cancellation, startup ordering, or cleanup. It independently reran the eight
  focused storage tests successfully. This review is not proof against hardware
  failure or every platform lifecycle.
- An additional real-server matrix passed fresh/current startup, a two-migration
  upgrade and relaunch, backup-directory failure, a later migration failure and
  retry, and missing history. A `SIGKILL` while copying a roughly 136 MiB
  synthetic database left both migrations pending and no published snapshot.
  Relaunch removed abandoned staging, published one snapshot, and completed the
  migrations. Earlier snapshots remained byte-for-byte unchanged on retries.
- The production web build served by that server rendered onboarding and the
  backup settings page. The page showed exactly one saved backup, labeled
  "Before database upgrade", with the correct unencrypted status and size.
- An isolated macOS desktop executable passed seven process/database scenarios:
  fresh startup, current startup, two-migration upgrade and relaunch, backup
  failure, later migration failure and relaunch retry, missing history, and a
  `DATABASE_URL` override with staging cleanup in the actual app-data root. All
  5,000 synthetic assets survived the upgrade; the sole original snapshot
  retained the previous schema. Successful launches reached the frontend's
  initial portfolio hook, confirming that native initialization allowed normal
  frontend commands afterward. Failure launches retained the backup location in
  their startup errors. The executable came from a temporary source copy with
  only its application identifier/name and keychain prefix changed for
  isolation; migration and startup code were unchanged.
- Interactive macOS checks passed after the Mac was unlocked. Fresh startup
  rendered onboarding. A deliberately failing migration displayed its retained
  snapshot path in Error details; clicking "Try again" created a second unique
  snapshot without changing the first. After removing the synthetic conflict,
  another on-screen retry completed the upgrade and opened the portfolio. A
  briefly held SQLite lock made the opening screen observable during both retry
  and normal initial startup; portfolio controls remained gated until readiness.
  The native Settings menu navigated correctly after retry, and Backup & Export
  showed all three attempt snapshots with the correct label and protection.
  Normal quit released database ownership. Relaunch reached the portfolio,
  created no additional snapshot, and preserved all three snapshot hashes and
  5,000 assets. The isolated app was closed and its test data archived
  afterward.

## Observed timings

One sequential smoke run used an 8,282,112-byte logical database (7.9 MiB), with
5,000 synthetic manual assets and notes. The pending migrations corrected MICs
and created `asset_logos`; these timings do not represent a large table rebuild
or `VACUUM` upgrade.

| Operation                                                                 | Elapsed |
| ------------------------------------------------------------------------- | ------: |
| Fresh server startup                                                      | 0.624 s |
| Server startup with backup and two migrations                             | 0.438 s |
| Current database relaunch                                                 | 0.261 s |
| Plaintext portable export, including staged migration/validation          | 0.514 s |
| Password-protected portable export, including staged migration/validation | 0.801 s |
| Offline plaintext portable validation                                     | 0.552 s |
| Offline password-protected portable validation                            | 0.634 s |

Startup timing ends at the first successful health response (polled every 100
ms). Export and validation timings include their full API/CLI operations,
including reference database migrations using `FULL`. These are smoke timings,
not a controlled benchmark or an `OFF` versus `FULL` comparison. Filesystem
caches and concurrent builds can affect them. Mobile flash, large portfolios and
different migrations require separate measurements.

## Large database stress run

A later run used a 2,061,414,400-byte plaintext app database (1.92 GiB),
containing 5,000 synthetic application assets and an additional test ledger with
1,000,000 rows. Each ledger row included a 1,410-byte memo, a text amount, a
currency, an account identifier, and a date. This tests storage migration
behavior, not the application's performance with a million real activities.

Two extra migrations were embedded only in the temporary test source copy. The
first transaction rebuilt the ledger, converted amounts to integer minor units,
normalized currencies and memo text, created two indexes, and replaced the old
table. A CHECK constraint verified `synchronous = FULL` on the migration
connection. The second migration ran `VACUUM` outside a transaction using
Diesel's normal migration metadata. Two existing application migrations were
also pending. The production wrapper, snapshot code, runner, and startup paths
were unchanged; no stress migration was added to the repository.

Every migrated row's amount, currency, and memo matched the expected result. All
million rows and all 5,000 application assets survived. Indexes, Diesel history,
`integrity_check`, snapshot counts, original snapshot contents, and snapshot
SHA-256 hashes passed verification.

| Measurement                                     |   Server |           Desktop |
| ----------------------------------------------- | -------: | ----------------: |
| Verified backup publication                     |   13.5 s |            10.4 s |
| Rebuild statements, before transaction commit   |   30.4 s |            33.1 s |
| `VACUUM`                                        |   17.7 s |            62.4 s |
| Stress SQL batch, including the rebuild commit  |   53.2 s |           103.9 s |
| Startup to first healthy HTTP response          |   67.5 s |                 — |
| Observed native process RSS during the full run | 2.74 GiB | at least 3.79 GiB |

The desktop opening screen rendered during actual migration work, and the native
menu responded. The portfolio eventually rendered and a subsequent launch
created no additional snapshot. Desktop SQL timings come from timestamps written
by the migrations. End-to-end desktop UI latency is not reported: the temporary
observer stopped at 60 seconds, and background-window behavior and automation
reconnections made that measurement unreliable. Its memory sample is therefore a
lower bound, not a complete peak measurement. SQL and data verification covered
the completed run.

Interruption checks also passed:

- Server `SIGKILL` during the uncommitted rebuild, after roughly 296 MiB of WAL
  writes: the original ledger remained intact, neither stress migration was
  recorded, and retry completed in 60.6 seconds.
- Server `SIGKILL` during `VACUUM`: the committed rebuild remained recorded,
  `VACUUM` remained pending, and retry completed in 23.6 seconds.
- Desktop normal Quit during `VACUUM`: the database remained readable, the
  committed rebuild survived, and relaunch completed the remaining migration and
  rendered the portfolio.

Each interrupted attempt retained its original verified snapshot; each retry
created one additional unique snapshot. Original hashes were unchanged. Normal
relaunches after successful completion added none.

Resource use is a material finding. The server reached about 2.84 GiB RSS on a
retry. The desktop's observed database, WAL, and snapshot files together reached
at least 8,317,111,120 bytes (7.75 GiB), excluding any other temporary files.
Backup preflight estimates snapshot capacity only; it does not cover this
migration working space. The existing runner still uses `temp_store = MEMORY`;
this test did not isolate its contribution or compare `FULL` with `OFF`.

These were debug builds on a 32 GiB Apple Silicon Mac. Cache state, other host
work, and runtime differences can affect timings; these runs are not a
controlled desktop/server comparison. Large encrypted databases, memory-limited
containers, mobile devices, disk exhaustion, and physical power loss were not
tested in this stress run. The large synthetic databases were removed after
validation; test scripts, SQL, logs, and result summaries were retained
temporarily. Normal development binaries were rebuilt from the actual workspace
afterward.

## Memory investigation: controlled reproduction

Follow-up on September 14, 2026: the reproduced migration memory spike comes
from the existing `temp_store = MEMORY` setting, followed by retained process
memory after SQLite frees its allocations. The exercised database path did not
show accumulating live allocations across repeated operations. This finding does
not certify the entire desktop application as leak-free.

Before investigating, Cargo build output, downloaded crate archives, and this
task's disposable test directories were removed. Available disk space increased
from 82 GiB to 126 GiB. Dependency sources and installed toolchains were
retained. The unchanged SQLCipher static archive was preserved before cleaning
so this investigation did not require another full application build.

### Method and scope

A small temporary C probe linked that archive and exercised the same
`sqlcipher_export` backup operation, original stress migration SQL, migration
PRAGMAs, and cleanup operations. It used a separate connection for copying and
verification, a single transaction for the rebuild, and a separate `VACUUM`. It
then repeated `VACUUM` twice more on the same connection. The probe recorded
SQLite live allocation bytes and exact allocation high-water marks using
`sqlite3_status64`, connection cache usage, process RSS using Mach task info,
and allocator statistics using `malloc_zone_statistics`. RSS sampling during SQL
was approximately every 50 ms, so RSS peaks are sampled values.

Two fresh processes used identical copies of a synthetic 1,000,000-row ledger,
2,053,160,960 bytes before upgrading. The only migration-setting difference was
`temp_store = MEMORY` versus `temp_store = FILE`. Both retained
`synchronous = FULL`, WAL, the 64,000 KiB cache setting, all constraints, SQL,
and transaction boundaries. This fixture reproduces the prior large ledger but
omits the small application tables. It is a storage-engine isolation test, not
another full Tauri/Axum or Diesel startup measurement.

Runtime identity: macOS 26.5.1 arm64, 32 GiB RAM, SQLCipher 4.14.0 community,
SQLite 3.51.3, `TEMP_STORE=2`. The probe linked Homebrew OpenSSL 3.6.3. Data was
plaintext; encrypted-database performance was not measured. The retained
SQLCipher archive SHA-256 was
`74a7049f3d9d41f5c5aa28897abdae8ba10d8b1da54ac69bcf2f19c29ee983e6`.

### Results

| Measurement                                       |       MEMORY |       FILE |
| ------------------------------------------------- | -----------: | ---------: |
| Backup peak SQLite allocations                    |     4.87 MiB |   4.87 MiB |
| Million-row normalization UPDATE peak allocations | 2,046.55 MiB |  75.95 MiB |
| First VACUUM peak SQLite allocations              | 2,571.33 MiB | 154.43 MiB |
| Whole-probe sampled peak process RSS              | 2,707.73 MiB | 244.97 MiB |
| SQLite live allocations after connection close    |     49,840 B |   49,840 B |
| SQLite live allocations after SQLite shutdown     |          0 B |        0 B |
| Process RSS after migration connection close      | 2,703.83 MiB | 172.47 MiB |
| Allocator live bytes after that close             |     0.47 MiB |   0.47 MiB |
| Allocator reserved bytes after that close         |    4,708 MiB |    188 MiB |

The memory-backed normalization UPDATE returned to 75.85 MiB of SQLite live
allocations immediately after the statement. Each of the three memory-backed
VACUUM runs peaked at 2,571.33 MiB and returned to 75.86 MiB afterward. That
plateau and the return to the exact initialization baseline after connection
close distinguish temporary allocations from a leak in these operations.

High RSS persisted even with only 0.47 MiB of allocator-live memory. A
diagnostic `malloc_zone_pressure_relief(NULL, 0)` after close reported zero
bytes released and did not reduce RSS. No allocator workaround was added to the
application. RSS alone would have incorrectly suggested that SQLite still owned
gigabytes after completing the work.

The normalization UPDATE took 15.96 s with MEMORY and 17.56 s with FILE. The
first VACUUM took 11.94 s and 12.11 s respectively. Subsequent VACUUM runs took
7.94/7.82 s with MEMORY and 9.97/10.03 s with FILE. These are single-machine
observations, not a performance guarantee or a randomized benchmark.

### Root cause and smallest follow-up

The bundled source traces both allocations to temporary-storage policy:

- `sqlite3BtreeBeginTrans` passes `sqlite3TempInMemory(db)` into
  `sqlite3PagerBegin`. `openSubJournal` disables spilling when `subjInMemory` is
  true, keeping statement-rollback pages in RAM. The large UPDATE inside the
  rebuild transaction exercises this path. Changing only temporary-storage mode
  removed its roughly 2 GiB peak.
- `sqlite3RunVacuum` attaches an empty-filename temporary database.
  `sqlite3BtreeOpen` makes that an in-memory database when
  `sqlite3TempInMemory(db)` is true. A separate VFS observation confirmed an
  actual temporary-database file open during FILE-backed VACUUM and no such file
  open during MEMORY-backed VACUUM.
- `temp_store = DEFAULT` also means memory with this build's `TEMP_STORE=2`.
  Merely removing the explicit MEMORY setting would therefore not resolve the
  cause. The existing published `reclaim_storage` migration also contains
  VACUUM, so the mechanism is relevant beyond the synthetic migration.

SQLite documents
[statement journals and temporary databases](https://www.sqlite.org/tempfiles.html),
the
[compile-time/runtime temporary-storage interaction](https://www.sqlite.org/pragma.html#pragma_temp_store),
and the meaning of the
[allocation counters](https://www.sqlite.org/c3ref/c_status_malloc_count.html).

The measured minimal direction for plaintext databases is disk-backed migration
temporary storage, keeping FULL durability and the existing backup/transaction
design. Follow-up review of
[SQLCipher's security design](https://www.zetetic.net/sqlcipher/design/)
confirms that some transient files are not encrypted. Consequently, the
plaintext result does not justify globally switching encrypted databases to
FILE. SQLCipher's maintainers suggest
[exporting to an explicitly encrypted database as an alternative to VACUUM](https://discuss.zetetic.net/t/memory-usage-spikes-during-vacuum-on-ios-how-to-limit-max-memory/6046).
The app already has encrypted export, candidate verification, and replacement
machinery, but encrypted compaction's memory use and its integration with the
published VACUUM migration have not been validated. This would address
compaction; large statement-rollback allocations still require attention to
migration SQL.

No production setting was changed during this investigation. Also,
libsqlite3-sys 0.38.2's Android build adds `SQLITE_TEMP_STORE=3`, which forces
memory regardless of the runtime PRAGMA; a desktop one-line change is not a
verified Android fix.

Both probe runs completed successfully. Independent read-only validation checked
every row's amount, currency, memo, account, and date in both outputs and both
original snapshots, with zero mismatches. Integrity checks, both indexes, and
all migration durability markers passed. Final databases were 2,089,992,192
bytes and each snapshot was 2,053,160,960 bytes. The large diagnostic databases
were removed after verification; small probe sources, SQL, JSON metrics, and
validation records were retained temporarily. No application code, schema,
migration SQL, or dependency changes were made for this investigation.

### Narrow follow-up implementation

The approved follow-up changes only plaintext desktop/server migration
connections to `temp_store=FILE`. Encrypted databases and both Android and iOS
retain MEMORY. FULL durability, published SQL, transaction boundaries, and
backup/recovery behavior are unchanged. The policy and its encryption/mobile
limitations are documented beside the PRAGMA selection in
`DbAccess::run_migrations`.

The regression test records `pragma_temp_store` from the actual Diesel migration
connection through a trigger on the migration history table. Before the fix, it
failed on plaintext desktop migrations, observing MEMORY for both pending
migrations where FILE was required. It also checks that encrypted migrations
retain MEMORY and includes the unchanged mobile expectation.

After the change, the storage suite passed 361 unit tests and eight integration
tests (three existing fixture/resource/doc tests remain ignored). Both desktop
and server passed
`cargo check --locked -p wealthfolio-app -p wealthfolio-server`. Rust formatting
and diff whitespace checks passed. These follow-up checks ran on macOS; mobile
builds and device tests were not repeated for this change. Cargo debug symbols
and incremental output were disabled for these checks to limit rebuilt cache
size after the earlier cleanup.

## Initial feature validation

- Frontend: 274 test files / 2,304 tests passed; type checking, web production
  build and translation parity passed. Lint passed with existing warnings.
- Storage: `cargo test --locked -p wealthfolio-storage-sqlite` passed: 360 unit
  tests and eight integration tests, including frozen portable fixtures and
  permissions checks. Three existing fixture-generation/resource/doc tests were
  ignored.
- Desktop and server:
  `cargo check --locked -p wealthfolio-app -p wealthfolio-server` and
  `cargo test --locked -p wealthfolio-app -p wealthfolio-server` passed (296
  tests; two existing OS credential-store tests ignored). Localhost socket tests
  required execution outside the sandbox.
- iOS: `cargo check --locked -p wealthfolio-app --target aarch64-apple-ios` and
  the equivalent `aarch64-apple-ios-sim` check passed with existing mobile
  warnings. Swift compilation required access to its compiler cache outside the
  sandbox.
- Android: the existing
  `pnpm tauri android build --ci --debug --apk --target aarch64 -- --locked`
  pipeline produced an APK successfully, with the configured NDK/LLVM ranlib and
  access to Tauri/Gradle caches. Generated manifest whitespace was removed from
  the source diff afterward.
- Android runtime: a newly created temporary ARM64 emulator reported a
  16,384-byte OS page size. Fresh launch rendered onboarding and created no
  backup. Installing the synthetic older database, upgrading, force-stopping and
  relaunching retained all 5,000 assets and exactly one unchanged snapshot
  containing the old schema. The upgraded database contained `asset_logos`; the
  original snapshot did not. Onboarding rendered after upgrade and relaunch; the
  native crash buffer was empty. The temporary emulator was removed after
  verification.
- Rust formatting, changed frontend formatting and `git diff --check` passed.

No physical-device or power-loss tests were performed. iOS, Windows, and Linux
runtime testing was not performed. There is no dedicated
cancellation/owner-lifetime regression test. No new access to private snapshots
after failed mobile startup is provided.
