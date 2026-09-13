# Credential storage architecture

The shared `SecretStore` interface separates credential storage from application
logic. Desktop and mobile builds use native credential services through Tauri.
Browser builds route secret-store operations to the server's encrypted vault
rather than browser storage.

## Native credentials

The Tauri implementation of the shared `SecretStore` contract uses
`keyring-core` and explicit platform backends:

| Platform                                      | Backend                                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- |
| macOS                                         | Apple login Keychain (`apple-native-keyring-store`, `keychain`)                               |
| iOS                                           | Apple protected Keychain (`apple-native-keyring-store`, `protected`)                          |
| Android                                       | Android Keystore encryption with encrypted SharedPreferences (`android-native-keyring-store`) |
| Windows                                       | Windows Credential Manager (`windows-native-keyring-store`)                                   |
| Linux / other configured desktop Unix targets | D-Bus Secret Service (`zbus-secret-service-keyring-store`)                                    |

Credentials include authentication tokens, provider API keys, and device-sync
secrets. Existing service identifiers and account names remain compatible with
previous desktop storage. Initialization is lazy, with successful stores cached.
Missing or locked native credential services return errors, with no plaintext or
in-memory fallback. Linux requires a session D-Bus and an available Secret
Service provider.

Sources: [native store](../../apps/tauri/src/secret_store.rs),
[shared contract](../../crates/core/src/secrets/mod.rs).

### Android lifecycle and backup

The Android backend crate implements encryption and credential persistence. Our
JNI bridge only supplies the Java VM and application context before Tauri
starts; it does not implement a custom credential store. Its JNI types match the
backend's initialization API.

The crate stores ciphertext in `shared_prefs/keyring-default.xml`. Its
encryption key remains in Android Keystore and cannot be carried to another
device with an ordinary app-data backup. Android Keystore stores cryptographic
keys; arbitrary API-token strings remain encrypted outside it.

The Android manifest selects backup rules that exclude `keyring-default.xml`
from legacy full backup, cloud backup, and device-to-device transfer. Other app
data retains its existing backup policy. After a restore to another device,
credentials must be re-entered or recreated; restoring portfolio data does not
restore device-bound credentials.

Sources:
[manifest](../../apps/tauri/gen/android/app/src/main/AndroidManifest.xml),
[legacy backup rules](../../apps/tauri/gen/android/app/src/main/res/xml/backup_rules.xml),
[extraction rules](../../apps/tauri/gen/android/app/src/main/res/xml/data_extraction_rules.xml).

## Server credentials

The Axum server uses `FileSecretStore`, a JSON vault encrypted with
ChaCha20-Poly1305 and a fresh nonce per write. The required master key comes
from `WF_SECRET_KEY` or `WF_SECRET_KEY_FILE`. Both inputs use the same decoder
and HKDF-SHA256 derivation, with separate `wealthfolio-jwt` and
`wealthfolio-secrets` labels for session signing and vault encryption. File
input is read once at startup. Native credential services are not required on
the server host.

`WF_SECRET_FILE` selects the encrypted vault location. Its default is
`secrets.json` alongside the database. File writes use the operating system's
normal filesystem behavior: existing ownership, permissions, ACLs, symlinks,
hard links, and individual file mounts are preserved. File creation follows
platform permissions and the process umask.

A mutex serializes operations through one store instance. Writes happen in place
and are not crash-atomic; independent processes must not write the same vault.

Sources: [server store](../../apps/server/src/secrets/mod.rs),
[key configuration](../../apps/server/src/config.rs),
[key derivation](../../apps/server/src/auth.rs).

## Compatibility and recovery

Existing derived-key encrypted files keep their format and key derivation.
Supported raw-key files migrate to derived-key encryption. Legacy plaintext
files remain readable and are encrypted on their next successful credential
write. Empty files are treated as empty vaults. Invalid nonce lengths return
errors instead of panicking. A malformed encrypted envelope is not treated as
plaintext.

Vault read/decryption failures are reported by secret operations rather than
blocking unrelated server features at startup. Failed reads do not trigger an
automatic reset. An interruption during a write can still leave an incomplete
file, so backups remain necessary.

Keep the master key in a separately protected recovery location from the vault
backup. Losing it prevents decryption. Switching from environment input to file
input must use the same key; changing its value is not a key-rotation procedure
and also affects session signing and OIDC logout-token encryption.

For configuration and commands, see the
[server README](../../apps/server/README.md) and
[self-hosting guide](../self-host/README.md#master-key-configuration).
