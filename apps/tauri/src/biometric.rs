//! macOS Touch ID unlock via `LocalAuthentication.framework` (LAContext).
//!
//! # Approach
//!
//! Stores the bypass token in a standard login-keychain item and performs
//! the biometric challenge at the **application level** using
//! `LAContext.evaluatePolicy(deviceOwnerAuthenticationWithBiometrics)`.
//!
//! This is the same pattern used by apps like 1Password and Apple Notes.
//!
//! # Security model
//!
//! The bypass token lives in the user's login keychain under a generic
//! password item. Touch ID is enforced at the **application level** (via
//! `LAContext.evaluatePolicy`) before the token is read.
//!
//! **On macOS 25 and earlier:** the keychain item is created with
//! `kSecAccessControlBiometryCurrentSet`, delegating enforcement to the OS.
//! Even code running as the same user cannot read the item without biometric
//! confirmation.
//!
//! **On macOS 26+ (Darwin 27+):** `SecAccessControlCreateWithFlags` returns
//! `errSecParam (-50)` for all flag combinations — an OS-level regression.
//! The item is stored without access-control constraints and Touch ID is
//! enforced only at the application level. Any same-user process can therefore
//! read the item from the keychain without biometric confirmation. This is a
//! known limitation documented here; a future fix will use the corrected
//! entitlement or API once Apple resolves the regression.
//!
//! In both cases the bypass token alone does not open a profile from outside
//! the running app — `unlock_with_biometric` re-triggers `evaluatePolicy` on
//! every call. The argon2 hash (`biometric_verifier`) in the profile lock
//! record is an additional verification layer, not a second secret.
//!
//! # Threading
//!
//! `store_bypass_token` and `retrieve_bypass_token` block the calling thread
//! while the Touch ID sheet is open. Both **must** be called from a blocking
//! thread — wrap every call in `tauri::async_runtime::spawn_blocking`.

#[cfg(target_os = "macos")]
mod imp {
    use block2::RcBlock;
    use core_foundation::base::{TCFType, ToVoid};
    use core_foundation::data::CFData;
    use core_foundation::dictionary::CFMutableDictionary;
    use core_foundation::string::CFString;
    use objc2::{
        class, msg_send,
        rc::Retained,
        runtime::{AnyObject, Bool},
    };
    use objc2_foundation::NSString;
    use security_framework::access_control::{ProtectionMode, SecAccessControl};
    use security_framework::passwords::{
        delete_generic_password, get_generic_password, set_generic_password,
    };
    use security_framework_sys::access_control::kSecAccessControlBiometryCurrentSet;
    use security_framework_sys::base::errSecSuccess;
    use security_framework_sys::item::{
        kSecAttrAccessControl, kSecAttrAccount, kSecAttrService, kSecClass,
        kSecClassGenericPassword, kSecValueData,
    };
    use security_framework_sys::keychain_item::SecItemAdd;
    use std::ffi::c_void;
    use std::sync::mpsc;
    use uuid::Uuid;

    // Pull in LocalAuthentication.framework so the LAContext ObjC class is
    // available at runtime.
    #[allow(unsafe_code, reason = "Links LocalAuthentication.framework via FFI")]
    #[link(name = "LocalAuthentication", kind = "framework")]
    unsafe extern "C" {}

    /// Service prefix for biometric bypass tokens in the login keychain.
    const BIOMETRIC_SERVICE: &str = "wealthfolio.profile.biometric-bypass";
    /// Fixed account label; the profile UUID is embedded in the service name.
    const ACCOUNT: &str = "biometric";
    /// `LAPolicy.deviceOwnerAuthenticationWithBiometrics` = 1
    const LA_POLICY_BIOMETRICS: isize = 1;

    fn service_for(profile_id: Uuid) -> String {
        format!("{BIOMETRIC_SERVICE}.{profile_id}")
    }

    // ── Availability check ───────────────────────────────────────────────────

    /// Returns `true` when Touch ID is enrolled on this Mac.
    ///
    /// Uses `LAContext.canEvaluatePolicy(deviceOwnerAuthenticationWithBiometrics)`
    /// which is reliable on all macOS versions including macOS 26.
    #[allow(unsafe_code, reason = "LAContext ObjC messaging via objc2")]
    pub fn biometric_enrolled() -> bool {
        unsafe {
            let context: Retained<AnyObject> = msg_send![class!(LAContext), new];
            // Pass a null `NSError **`; we only care about the bool return value.
            let null_err = std::ptr::null_mut::<*mut AnyObject>();
            let available: Bool = msg_send![
                &*context,
                canEvaluatePolicy: LA_POLICY_BIOMETRICS,
                error: null_err
            ];
            available.as_bool()
        }
    }

    // ── Biometric challenge ───────────────────────────────────────────────────

    /// Show the Touch ID sheet and block until it resolves.
    ///
    /// Returns `Ok(())` on success, `Err("BIOMETRIC_CANCELLED")` if the user
    /// dismisses the prompt or authentication fails.
    ///
    /// **Must be called from a blocking thread.**
    ///
    /// `pub` so the top-level `evaluate_biometric_challenge` wrapper can call it
    /// without duplicating the LAContext logic.
    #[allow(unsafe_code, reason = "LAContext ObjC messaging via objc2")]
    pub fn evaluate_biometric(reason: &str) -> Result<(), String> {
        let (tx, rx) = mpsc::channel::<bool>();

        unsafe {
            let context: Retained<AnyObject> = msg_send![class!(LAContext), new];
            let ns_reason = NSString::from_str(reason);

            // The reply block fires on a LAContext-internal queue after the user
            // interacts with the Touch ID sheet. `RcBlock` keeps the closure alive
            // (ObjC increments the block's ref-count on `evaluatePolicy`) until the
            // callback fires and ObjC releases its reference.
            let block = RcBlock::new({
                let tx = tx.clone();
                move |success: Bool, _error: *mut c_void| {
                    // Ignore errors; the bool is sufficient for our use-case.
                    let _ = tx.send(success.as_bool());
                }
            });

            let _: () = msg_send![
                &*context,
                evaluatePolicy: LA_POLICY_BIOMETRICS,
                localizedReason: &*ns_reason,
                reply: &*block
            ];
        }

        // Block the calling thread until the sheet resolves.
        match rx.recv() {
            Ok(true) => Ok(()),
            _ => Err("BIOMETRIC_CANCELLED".to_owned()),
        }
    }

    // ── Token storage ─────────────────────────────────────────────────────────

    /// Store `token` in the login keychain after a successful Touch ID challenge.
    ///
    /// On macOS ≤ 25, the keychain item is created with
    /// `kSecAccessControlBiometryCurrentSet` so the OS itself enforces biometric
    /// confirmation on every read. On macOS 26+ (Darwin 27+), that flag causes
    /// `SecAccessControlCreateWithFlags` to return `errSecParam (-50)` — an
    /// OS-level regression — so we fall back to a plain item and rely on the
    /// application-level challenge only (see module doc for the security
    /// implication).
    ///
    /// The challenge fires immediately so the user confirms Touch ID works
    /// at enable time (same UX as 1Password / Apple Notes).
    ///
    /// **Must be called from a blocking thread.**
    pub fn store_bypass_token(profile_id: Uuid, token: &[u8]) -> Result<(), String> {
        // Challenge first — confirms Touch ID is functional and records intent.
        evaluate_biometric("Enable Touch ID for Wealthfolio")?;

        // Replace any stale entry for this profile.
        let _ = delete_generic_password(&service_for(profile_id), ACCOUNT);

        // Attempt OS-level biometric access control (macOS ≤ 25).
        // On macOS 26+ SecAccessControlCreateWithFlags returns errSecParam = -50
        // for all flag combinations — an OS-level regression. In that case we fall
        // back to a plain keychain item and rely on app-level challenge only.
        let used_ac = try_store_with_biometric_ac(&service_for(profile_id), ACCOUNT, token);
        if !used_ac {
            set_generic_password(&service_for(profile_id), ACCOUNT, token).map_err(|e| {
                let code = e.code();
                log::error!("set_generic_password for biometric token failed (code {code}): {e}");
                format!(
                    "PROFILE_BIOMETRIC_STORE_FAILED: Could not store biometric token (code {code})"
                )
            })?;
        }
        Ok(())
    }

    /// Try to store `token` with `kSecAccessControlBiometryCurrentSet`.
    ///
    /// Returns `true` if the item was stored successfully with an OS-level
    /// biometric access-control constraint, `false` if
    /// `SecAccessControlCreateWithFlags` failed (macOS 26 regression:
    /// `errSecParam = -50` for all flag combinations).
    ///
    /// Uses `security_framework::access_control::SecAccessControl` for the
    /// high-level creation (which safely wraps the null-pointer check) and
    /// raw `security_framework_sys` APIs to attach `kSecAttrAccessControl` to
    /// the `SecItemAdd` query dictionary — `security_framework::item::ItemAddOptions`
    /// does not expose that field.
    #[allow(unsafe_code, reason = "Raw Security.framework APIs for kSecAttrAccessControl")]
    fn try_store_with_biometric_ac(service: &str, account: &str, token: &[u8]) -> bool {
        // Attempt OS-level biometric access control.
        // SecAccessControl::create_with_protection wraps SecAccessControlCreateWithFlags
        // and returns Err when the function returns NULL (macOS 26 regression).
        let access_control = match SecAccessControl::create_with_protection(
            Some(ProtectionMode::AccessibleWhenPasscodeSetThisDeviceOnly),
            kSecAccessControlBiometryCurrentSet,
        ) {
            Ok(ac) => ac,
            Err(e) => {
                log::debug!(
                    "SecAccessControlCreateWithFlags failed (code {}): OS-level biometric \
                     constraint unavailable, falling back to app-level challenge only.",
                    e.code()
                );
                return false;
            }
        };

        let service_cf = CFString::new(service);
        let account_cf = CFString::new(account);
        let data_cf = CFData::from_buffer(token);

        // Build the SecItemAdd query dictionary manually so we can attach
        // kSecAttrAccessControl — ItemAddOptions does not expose that field.
        let status = unsafe {
            let mut dict = CFMutableDictionary::<*const c_void, *const c_void>::new();
            dict.add(&kSecClass.to_void(), &kSecClassGenericPassword.to_void());
            dict.add(&kSecAttrService.to_void(), &service_cf.to_void());
            dict.add(&kSecAttrAccount.to_void(), &account_cf.to_void());
            dict.add(&kSecValueData.to_void(), &data_cf.to_void());
            // Attach the biometric access-control constraint.
            // access_control is a TCFType wrapper; it stays alive until end of this
            // function so the raw pointer in the dict remains valid for SecItemAdd.
            dict.add(
                &kSecAttrAccessControl.to_void(),
                &access_control.to_void(),
            );
            SecItemAdd(
                dict.as_concrete_TypeRef() as *const _,
                std::ptr::null_mut(),
            )
        };

        if status == errSecSuccess {
            true
        } else {
            log::warn!(
                "SecItemAdd with kSecAttrAccessControl failed (OSStatus {status}); \
                 biometric constraint not stored."
            );
            false
        }
    }

    /// Show the Touch ID prompt then, on success, return the bypass token.
    ///
    /// **Must be called from a blocking thread.**
    pub fn retrieve_bypass_token(profile_id: Uuid) -> Result<Vec<u8>, String> {
        evaluate_biometric("Unlock Wealthfolio")?;

        get_generic_password(&service_for(profile_id), ACCOUNT).map_err(|e| {
            let code = e.code();
            if code == -25300 {
                // errSecItemNotFound — token was never stored or was deleted.
                // Matches the PROFILE_BIOMETRIC_NOT_ENROLLED check in profile-shell.tsx.
                "PROFILE_BIOMETRIC_NOT_ENROLLED".to_owned()
            } else {
                log::warn!("get_generic_password for biometric token failed (code {code}): {e}");
                format!("Touch ID failed ({code}): {e}")
            }
        })
    }

    /// Remove the biometric bypass token from the keychain. No challenge required.
    pub fn delete_bypass_token(profile_id: Uuid) -> Result<(), String> {
        match delete_generic_password(&service_for(profile_id), ACCOUNT) {
            Ok(()) => Ok(()),
            Err(e) if e.code() == -25300 => Ok(()), // already gone — not an error
            Err(e) => {
                let code = e.code();
                log::warn!(
                    "delete_generic_password for biometric token failed (code {code}): {e}"
                );
                Err(format!(
                    "Could not delete biometric token (code {code}): {e}"
                ))
            }
        }
    }
}

// ── Public surface (stubs on non-macOS) ──────────────────────────────────────

/// Returns `true` only when the platform supports biometrics **and** at least one
/// fingerprint is enrolled. Always `false` on non-macOS platforms.
pub fn biometric_available() -> bool {
    #[cfg(target_os = "macos")]
    return imp::biometric_enrolled();
    #[cfg(not(target_os = "macos"))]
    false
}

/// Trigger a Touch ID challenge without reading a keychain item.
///
/// Used to gate sensitive operations (e.g., disabling biometric unlock on a
/// password-less profile) on a live biometric proof so that WebView code
/// cannot silently strip biometric protection without user interaction.
///
/// Returns `Ok(())` on success, `Err("BIOMETRIC_CANCELLED")` on failure.
///
/// **Must be called from a blocking thread.**
#[allow(unused_variables)]
pub fn evaluate_biometric_challenge(reason: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return imp::evaluate_biometric(reason);
    #[cfg(not(target_os = "macos"))]
    Err(
        "PROFILE_BIOMETRIC_UNAVAILABLE: Biometric unlock is only available on macOS.".to_owned(),
    )
}

/// Store a biometric bypass token in the platform's secure store.
///
/// Triggers the Touch ID prompt. **Call from a blocking thread.**
#[allow(unused_variables)]
pub fn store_bypass_token(profile_id: uuid::Uuid, token: &[u8]) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return imp::store_bypass_token(profile_id, token);
    #[cfg(not(target_os = "macos"))]
    Err(
        "PROFILE_BIOMETRIC_UNAVAILABLE: Biometric unlock is only available on macOS.".to_owned(),
    )
}

/// Retrieve the biometric bypass token, triggering the Touch ID prompt.
///
/// **Call from a blocking thread.**
#[allow(unused_variables)]
pub fn retrieve_bypass_token(profile_id: uuid::Uuid) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "macos")]
    return imp::retrieve_bypass_token(profile_id);
    #[cfg(not(target_os = "macos"))]
    Err(
        "PROFILE_BIOMETRIC_UNAVAILABLE: Biometric unlock is only available on macOS.".to_owned(),
    )
}

/// Remove the biometric bypass token without authentication.
#[allow(unused_variables)]
pub fn delete_bypass_token(profile_id: uuid::Uuid) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return imp::delete_bypass_token(profile_id);
    #[cfg(not(target_os = "macos"))]
    Err(
        "PROFILE_BIOMETRIC_UNAVAILABLE: Biometric unlock is only available on macOS.".to_owned(),
    )
}
