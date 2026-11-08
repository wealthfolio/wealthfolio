use serde::Serialize;

#[derive(Serialize)]
pub struct PlatformCapabilities {
    pub connect_sync: bool,
    pub device_sync: bool,
    pub cloud_sync: bool,
    /// Touch ID / Face ID unlock is available on this platform.
    pub biometric_lock: bool,
}

#[derive(Serialize)]
pub struct PlatformInfo {
    pub os: &'static str,
    pub arch: &'static str,
    pub is_mobile: bool,
    pub is_desktop: bool,
    pub is_tauri: bool,
    pub capabilities: PlatformCapabilities,
}

#[tauri::command]
pub fn get_platform() -> PlatformInfo {
    let connect_sync = cfg!(feature = "connect-sync");
    let device_sync = cfg!(feature = "device-sync");

    PlatformInfo {
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        is_mobile: cfg!(any(target_os = "ios", target_os = "android")),
        is_desktop: cfg!(not(any(target_os = "ios", target_os = "android"))),
        is_tauri: true,
        capabilities: PlatformCapabilities {
            connect_sync,
            device_sync,
            cloud_sync: connect_sync || device_sync,
            biometric_lock: crate::biometric::biometric_available(),
        },
    }
}

// Alternative: Use compile-time constants for even better performance
#[tauri::command]
pub fn is_mobile() -> bool {
    cfg!(any(target_os = "ios", target_os = "android"))
}

#[tauri::command]
pub fn is_desktop() -> bool {
    cfg!(not(any(target_os = "ios", target_os = "android")))
}
