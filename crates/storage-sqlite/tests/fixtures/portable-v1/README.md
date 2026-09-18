# Frozen portable backup v1 fixtures

These are **synthetic test data**, not user backups or production secrets. Keep
these exact bytes: future importers must continue to read them. Do not regenerate
them to make a failing compatibility test pass.

| File | Contents |
| --- | --- |
| `protected.wfbackup` | Version-one protected export; SQLCipher profile 4, 256000 KDF iterations |
| `plaintext.db` | Explicit unencrypted portable export of the same synthetic portfolio |
| `manifest.json` | SHA-256 hashes, producer app version, OS/architecture and SQLCipher version |

Both contain one synthetic USD account and one deposit of
`1234.567890123456789`, with a Unicode account name. The source contained a fake
personal-access token, custom-provider secret, broker account reference and a
fixed source identity, which the exporter sanitizes. The source was encrypted
with a random installation key that is deliberately not retained. Import must
work without it and preserve each destination's own encryption policy.

The public test password is expressed exactly as a Rust string to make spaces
and the combining accent unambiguous:

```rust
"  fixture 日本語 cafe\u{301} password  "
```

Trimming its spaces or substituting precomposed `é` must fail. Corruption cases
are deterministic mutations of the frozen protected bytes: unknown version,
changed salt, changed encrypted page, truncation and appended page. They are
derived in temporary directories rather than committing duplicate megabyte files.

## Provenance and execution

Authored on macOS aarch64 using app/storage 3.9.0, `libsqlite3-sys` 0.38.2 and
SQLCipher 4.14.0 community, with the lockfile and export implementation at commit
`8eac3bfa77b11fa03459c232106a19f2e0c86f04`. The generator is the ignored test in
`../../portable_fixtures.rs`. It calls the real exporter; cryptographic salts,
creation timestamps and ephemeral keys are random/runtime inputs. **Generation
is not byte-reproducible; the committed outputs are the frozen test vectors.**

From the repository root, run the consumer tests:

```sh
cargo test --locked -p wealthfolio-storage-sqlite --test portable_fixtures
```

The authoring command is documented for provenance; it refuses to overwrite any
existing fixture and is never run by normal CI:

```sh
cargo test --locked -p wealthfolio-storage-sqlite --test portable_fixtures generate_portable_v1_fixtures -- --ignored --exact
```

Add a new directory/version for future producer fixtures while retaining these
files and their consumer assertions. Existing PR workspace tests run the consumer
suite; the storage compatibility matrix also runs it on Linux, macOS and Windows
without rerunning the generator. A configured CI job is not evidence that its
platform passed: actual results belong in the implementation validation record.
Android/iOS device execution and shipped server artifact tests remain separate
release gates.
