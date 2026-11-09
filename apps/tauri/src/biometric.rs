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
    use security_framework::passwords::{delete_generic_password, get_generic_password};
    use security_framework_sys::access_control::kSecAccessControlBiometryCurrentSet;
    use security_framework_sys::base::errSecSuccess;
    use security_framework_sys::item::{
        kSecAttrAccessControl, kSecAttrAccount, kSecAttrService, kSecClass,
        kSecClassGenericPassword, kSecValueData,
    };
    use security_framework_sys::keychain_item::{SecItemAdd, SecItemUpdate};
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

    /// Returns the keychain service name for a profile's biometric bypass token.
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
    /// Returns:
    /// - `Ok(())` — authentication succeeded.
    /// - `Err("BIOMETRIC_NOT_ENROLLED")` — biometrics are not enrolled on this
    ///   device (`LAErrorBiometryNotAvailable` = 6 or `LAErrorBiometryNotEnrolled` = 7).
    ///   Callers should treat this as a hardware-availability failure, distinct from a
    ///   user dismissal.
    /// - `Err("BIOMETRIC_CANCELLED")` — the user dismissed the prompt or authentication
    ///   failed for any other reason.
    ///
    /// **Must be called from a blocking thread.**
    ///
    /// `pub` so the top-level `evaluate_biometric_challenge` wrapper can call it
    /// without duplicating the LAContext logic.
    #[allow(unsafe_code, reason = "LAContext ObjC messaging via objc2")]
    pub fn evaluate_biometric(reason: &str) -> Result<(), String> {
        // Tri-state channel: Ok(()) = success, Err(true) = not enrolled/unavailable,
        // Err(false) = user cancelled or other failure.
        let (tx, rx) = mpsc::channel::<Result<(), bool>>();

        unsafe {
            let context: Retained<AnyObject> = msg_send![class!(LAContext), new];
            let ns_reason = NSString::from_str(reason);

            // The reply block fires on a LAContext-internal queue after the user
            // interacts with the Touch ID sheet. `RcBlock` keeps the closure alive
            // (ObjC increments the block's ref-count on `evaluatePolicy`) until the
            // callback fires and ObjC releases its reference.
            let block = RcBlock::new({
                let tx = tx.clone();
                move |success: Bool, error: *mut c_void| {
                    let result: Result<(), bool> = if success.as_bool() {
                        Ok(())
                    } else {
                        // Distinguish hardware-unavailable / not-enrolled from
                        // other failures (user cancel, lockout, etc.).
                        // LAErrorBiometryNotAvailable = 6
                        // LAErrorBiometryNotEnrolled  = 7
                        const LA_ERROR_BIOMETRY_NOT_AVAILABLE: isize = 6;
                        const LA_ERROR_BIOMETRY_NOT_ENROLLED: isize = 7;
                        // SAFETY: `error` is a non-null NSError pointer supplied by
                        // LAContext's reply block. The LAContext framework guarantees it
                        // is a valid NSError object whenever success is NO.
                        let code: isize = if error.is_null() {
                            0
                        } else {
                            msg_send![&*(error as *const AnyObject), code]
                        };
                        Err(code == LA_ERROR_BIOMETRY_NOT_AVAILABLE
                            || code == LA_ERROR_BIOMETRY_NOT_ENROLLED)
                    };
                    let _ = tx.send(result);
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
            Ok(Ok(())) => Ok(()),
            Ok(Err(true)) => Err("BIOMETRIC_NOT_ENROLLED".to_owned()),
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
    /// Uses an atomic update-or-replace strategy: the old token is never deleted
    /// before the new one is confirmed written, so a biometric-only profile always
    /// retains a valid unlock path even if storage fails mid-operation.
    ///
    /// **Must be called from a blocking thread.**
    pub fn store_bypass_token(profile_id: Uuid, token: &[u8]) -> Result<(), String> {
        // Challenge first — confirms Touch ID is functional and records intent.
        evaluate_biometric("Enable Touch ID for Wealthfolio")?;

        let service = service_for(profile_id);

        // Attempt OS-level biometric access control (macOS ≤ 25).
        // On macOS 26+ SecAccessControlCreateWithFlags returns errSecParam = -50
        // for all flag combinations — an OS-level regression. In that case (or when
        // the add fails for any other reason) we fall back to the plain path below.
        // try_store_with_biometric_ac handles pre-existing items (re-enrollment) via
        // a delete-and-retry, so no upfront delete is needed here.
        if try_store_with_biometric_ac(&service, ACCOUNT, token) {
            return Ok(());
        }

        // Plain path (macOS 26 regression or AC write failed).
        // Use SecItemUpdate when the item already exists (re-enrollment) so the old
        // token remains valid until the new write commits — avoiding the window where
        // neither the old nor the new token is present in the keychain.
        update_or_add_plain(&service, ACCOUNT, token).map_err(|code| {
            log::error!("write biometric token failed (OSStatus {code})");
            format!(
                "PROFILE_BIOMETRIC_STORE_FAILED: Could not store biometric token (OSStatus {code})"
            )
        })
    }

    /// Try to store `token` with `kSecAccessControlBiometryCurrentSet`.
    ///
    /// Returns `true` if the item was stored successfully with an OS-level
    /// biometric access-control constraint, `false` if
    /// `SecAccessControlCreateWithFlags` failed (macOS 26 regression:
    /// `errSecParam = -50` for all flag combinations) or if the add ultimately fails.
    ///
    /// For re-enrollment (an existing AC-protected item), first attempts
    /// `SecItemUpdate` to replace `kSecValueData` atomically — the old token
    /// remains valid until the write commits. If `SecItemUpdate` fails (some macOS
    /// versions disallow in-place value updates on AC-constrained items), falls back
    /// to deleting the old entry and retrying `SecItemAdd` once.
    ///
    /// Uses `security_framework::access_control::SecAccessControl` for the
    /// high-level creation (which safely wraps the null-pointer check) and
    /// raw `security_framework_sys` APIs to attach `kSecAttrAccessControl` to
    /// the `SecItemAdd` query dictionary — `security_framework::item::ItemAddOptions`
    /// does not expose that field.
    #[allow(
        unsafe_code,
        reason = "Raw Security.framework APIs for kSecAttrAccessControl"
    )]
    fn try_store_with_biometric_ac(service: &str, account: &str, token: &[u8]) -> bool {
        // errSecDuplicateItem (-25299): pre-existing entry from a prior enrollment.
        const ERR_SEC_DUPLICATE_ITEM: i32 = -25299;

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

        // Build a closure that runs SecItemAdd with the AC dict.
        // access_control is a TCFType wrapper that stays alive for the duration of
        // this function; the raw pointer in the dict is valid for every SecItemAdd call.
        let sec_item_add = || unsafe {
            let mut dict = CFMutableDictionary::<*const c_void, *const c_void>::new();
            dict.add(&kSecClass.to_void(), &kSecClassGenericPassword.to_void());
            dict.add(&kSecAttrService.to_void(), &service_cf.to_void());
            dict.add(&kSecAttrAccount.to_void(), &account_cf.to_void());
            dict.add(&kSecValueData.to_void(), &data_cf.to_void());
            // Attach the biometric access-control constraint.
            dict.add(&kSecAttrAccessControl.to_void(), &access_control.to_void());
            SecItemAdd(dict.as_concrete_TypeRef() as *const _, std::ptr::null_mut())
        };

        let status = sec_item_add();
        if status == errSecSuccess {
            return true;
        }

        if status == ERR_SEC_DUPLICATE_ITEM {
            // Re-enrollment: an AC-protected item already exists for this profile.
            // Try SecItemUpdate first — it atomically replaces kSecValueData on the
            // existing biometric-AC item, so the old token remains valid until the
            // write commits and no window exists where neither token is present.
            // kSecAttrAccessControl is immutable after creation, so we update only
            // the data attribute.
            let update_status = unsafe {
                let mut query = CFMutableDictionary::<*const c_void, *const c_void>::new();
                query.add(&kSecClass.to_void(), &kSecClassGenericPassword.to_void());
                query.add(&kSecAttrService.to_void(), &service_cf.to_void());
                query.add(&kSecAttrAccount.to_void(), &account_cf.to_void());

                let mut attrs = CFMutableDictionary::<*const c_void, *const c_void>::new();
                attrs.add(&kSecValueData.to_void(), &data_cf.to_void());

                SecItemUpdate(
                    query.as_concrete_TypeRef() as *const _,
                    attrs.as_concrete_TypeRef() as *const _,
                )
            };
            if update_status == errSecSuccess {
                return true;
            }

            // SecItemUpdate failed (some AC constraints prevent in-place value
            // updates). Fall back to delete-and-retry; Touch ID was already
            // confirmed above, so the window without a valid token is minimal.
            log::debug!(
                "SecItemUpdate on biometric-AC item failed (OSStatus {update_status}); \
                 falling back to delete-and-retry."
            );
            let _ = delete_generic_password(service, account);
            let retry = sec_item_add();
            if retry == errSecSuccess {
                return true;
            }
            log::warn!(
                "SecItemAdd with kSecAttrAccessControl retry failed (OSStatus {retry}); \
                 falling back to plain keychain item."
            );
        } else {
            log::warn!(
                "SecItemAdd with kSecAttrAccessControl failed (OSStatus {status}); \
                 biometric constraint not stored."
            );
        }
        false
    }

    /// Write `new_data` to the keychain, updating an existing item in-place or
    /// inserting a fresh one if no item is present.
    ///
    /// Unlike delete-then-add, `SecItemUpdate` atomically replaces the value of an
    /// existing item, so the old token remains readable until the write commits.
    /// This avoids a window where a biometric-only profile has no valid unlock path.
    #[allow(
        unsafe_code,
        reason = "Raw Security.framework SecItemUpdate/SecItemAdd APIs"
    )]
    fn update_or_add_plain(service: &str, account: &str, new_data: &[u8]) -> Result<(), i32> {
        // errSecItemNotFound (-25300): no existing entry — insert fresh.
        const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

        let service_cf = CFString::new(service);
        let account_cf = CFString::new(account);
        let data_cf = CFData::from_buffer(new_data);

        // Try SecItemUpdate first (item exists → safe to update atomically).
        let update_status = unsafe {
            let mut query = CFMutableDictionary::<*const c_void, *const c_void>::new();
            query.add(&kSecClass.to_void(), &kSecClassGenericPassword.to_void());
            query.add(&kSecAttrService.to_void(), &service_cf.to_void());
            query.add(&kSecAttrAccount.to_void(), &account_cf.to_void());

            let mut attrs = CFMutableDictionary::<*const c_void, *const c_void>::new();
            attrs.add(&kSecValueData.to_void(), &data_cf.to_void());

            SecItemUpdate(
                query.as_concrete_TypeRef() as *const _,
                attrs.as_concrete_TypeRef() as *const _,
            )
        };

        if update_status == errSecSuccess {
            return Ok(());
        }

        if update_status != ERR_SEC_ITEM_NOT_FOUND {
            // Unexpected update error.
            return Err(update_status);
        }

        // Item absent (first enrollment): add fresh.
        let add_status = unsafe {
            let mut dict = CFMutableDictionary::<*const c_void, *const c_void>::new();
            dict.add(&kSecClass.to_void(), &kSecClassGenericPassword.to_void());
            dict.add(&kSecAttrService.to_void(), &service_cf.to_void());
            dict.add(&kSecAttrAccount.to_void(), &account_cf.to_void());
            dict.add(&kSecValueData.to_void(), &data_cf.to_void());
            SecItemAdd(dict.as_concrete_TypeRef() as *const _, std::ptr::null_mut())
        };

        if add_status == errSecSuccess {
            Ok(())
        } else {
            Err(add_status)
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
                log::warn!("delete_generic_password for biometric token failed (code {code}): {e}");
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
    Err("PROFILE_BIOMETRIC_UNAVAILABLE: Biometric unlock is only available on macOS.".to_owned())
}

/// Store a biometric bypass token in the platform's secure store.
///
/// Triggers the Touch ID prompt. **Call from a blocking thread.**
#[allow(unused_variables)]
pub fn store_bypass_token(profile_id: uuid::Uuid, token: &[u8]) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return imp::store_bypass_token(profile_id, token);
    #[cfg(not(target_os = "macos"))]
    Err("PROFILE_BIOMETRIC_UNAVAILABLE: Biometric unlock is only available on macOS.".to_owned())
}

/// Retrieve the biometric bypass token, triggering the Touch ID prompt.
///
/// **Call from a blocking thread.**
#[allow(unused_variables)]
pub fn retrieve_bypass_token(profile_id: uuid::Uuid) -> Result<Vec<u8>, String> {
    #[cfg(target_os = "macos")]
    return imp::retrieve_bypass_token(profile_id);
    #[cfg(not(target_os = "macos"))]
    Err("PROFILE_BIOMETRIC_UNAVAILABLE: Biometric unlock is only available on macOS.".to_owned())
}

/// Remove the biometric bypass token without authentication.
#[allow(unused_variables)]
pub fn delete_bypass_token(profile_id: uuid::Uuid) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    return imp::delete_bypass_token(profile_id);
    #[cfg(not(target_os = "macos"))]
    Err("PROFILE_BIOMETRIC_UNAVAILABLE: Biometric unlock is only available on macOS.".to_owned())
}
