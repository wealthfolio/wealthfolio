//! Native lifecycle notifications are independent of renderer activity/timers.
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager};
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn request_lock(reason: &str) {
    log::debug!("Profile lock requested: {reason}");
    let Some(handle) = APP.get() else {
        return;
    };
    let Some(root) = handle.try_state::<crate::profiles::NativeProfiles>() else {
        return;
    };
    if matches!(
        root.registry
            .sessions
            .revoke_for_auto_lock(crate::profiles::NATIVE_OWNER),
        Ok(false)
    ) {
        return;
    }
    if let Some(runtime) = root.active().ok().flatten() {
        runtime.suspend();
    }
    let _ = handle.emit(crate::profiles::PROFILE_CHANGED, ());
    let handle = handle.clone();
    tauri::async_runtime::spawn(async move {
        let _ = handle
            .state::<crate::profiles::NativeProfiles>()
            .lock(&handle)
            .await;
    });
}

pub fn install(handle: &AppHandle) {
    let _ = APP.set(handle.clone());
    #[cfg(target_os = "macos")]
    unsafe {
        use block2::RcBlock;
        use objc2_foundation::NSString;
        let block = RcBlock::new(|_: std::ptr::NonNull<objc2_foundation::NSNotification>| {
            request_lock("native lifecycle")
        });
        #[cfg(target_os = "macos")]
        {
            use objc2_app_kit::{
                NSWorkspace, NSWorkspaceSessionDidResignActiveNotification,
                NSWorkspaceWillSleepNotification,
            };
            let center = NSWorkspace::sharedWorkspace().notificationCenter();
            // The notification center retains these process-lifetime observers.
            let _ = center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceWillSleepNotification),
                None,
                None,
                &block,
            );
            let _ = center.addObserverForName_object_queue_usingBlock(
                Some(NSWorkspaceSessionDidResignActiveNotification),
                None,
                None,
                &block,
            );
            let distributed = objc2_foundation::NSDistributedNotificationCenter::defaultCenter();
            let _ = distributed.addObserverForName_object_queue_usingBlock(
                Some(&NSString::from_str("com.apple.screenIsLocked")),
                None,
                None,
                &block,
            );
        }
    }
    #[cfg(target_os = "windows")]
    install_windows_sleep_notifications();
    #[cfg(target_os = "windows")]
    tauri::async_runtime::spawn(async {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            use windows_sys::Win32::System::RemoteDesktop::*;
            unsafe {
                let mut buffer = std::ptr::null_mut();
                let mut size = 0;
                if WTSQuerySessionInformationW(
                    std::ptr::null_mut(),
                    WTS_CURRENT_SESSION,
                    WTSSessionInfoEx,
                    &mut buffer,
                    &mut size,
                ) != 0
                {
                    if size as usize >= std::mem::size_of::<WTSINFOEXW>() {
                        let info = &*(buffer as *const WTSINFOEXW);
                        if info.Level == 1
                            && info.Data.WTSInfoExLevel1.SessionFlags
                                == WTS_SESSIONSTATE_LOCK as i32
                        {
                            request_lock("Windows session lock");
                        }
                    }
                    WTSFreeMemory(buffer.cast());
                }
            }
        }
    });
    #[cfg(all(
        unix,
        not(any(target_os = "macos", target_os = "ios", target_os = "android"))
    ))]
    tauri::async_runtime::spawn(async {
        use futures::StreamExt;
        let connection = match zbus::Connection::system().await {
            Ok(connection) => connection,
            Err(error) => {
                log::warn!(
                    "Could not connect to Linux system bus for session notifications: {error}"
                );
                return;
            }
        };
        let proxy = match zbus::Proxy::new(
            &connection,
            "org.freedesktop.login1",
            "/org/freedesktop/login1/session/auto",
            "org.freedesktop.login1.Session",
        )
        .await
        {
            Ok(proxy) => proxy,
            Err(error) => {
                log::warn!("Could not access Linux session notifications: {error}");
                return;
            }
        };
        let manager = zbus::Proxy::new(
            &connection,
            "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
        )
        .await;
        let mut sleep_signals = match manager.as_ref() {
            Ok(manager) => match manager.receive_signal("PrepareForSleep").await {
                Ok(signals) => Some(signals),
                Err(error) => {
                    log::warn!("Could not subscribe to Linux sleep notifications: {error}");
                    None
                }
            },
            Err(error) => {
                log::warn!("Could not access Linux sleep notifications: {error}");
                None
            }
        };
        // Subscribe before taking the delay inhibitor. Keep its fd until access
        // has been revoked, so logind cannot suspend us before request_lock runs.
        let mut inhibitor = if sleep_signals.is_some() {
            match manager.as_ref() {
                Ok(manager) => linux_sleep_inhibitor(manager).await,
                Err(_) => None,
            }
        } else {
            None
        };
        loop {
            tokio::select! {
                signal = async {
                    match sleep_signals.as_mut() {
                        Some(signals) => signals.next().await,
                        None => std::future::pending().await,
                    }
                } => {
                    let Some(signal) = signal else {
                        sleep_signals = None;
                        inhibitor.take();
                        continue;
                    };
                    if let Ok((sleeping,)) = signal.body().deserialize::<(bool,)>() {
                        // Resume also revokes if acquiring a delay inhibitor was
                        // denied, or the pre-suspend notification was delayed.
                        request_lock("Linux sleep/resume");
                        inhibitor.take();
                        if !sleeping {
                            if let Ok(manager) = manager.as_ref() {
                                inhibitor = linux_sleep_inhibitor(manager).await;
                            }
                        }
                    }
                }
                locked = async {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    proxy.get_property::<bool>("LockedHint").await.unwrap_or(false)
                } => {
                    if locked {
                        request_lock("Linux session lock");
                    }
                }
            }
        }
    });
}

#[cfg(target_os = "windows")]
fn install_windows_sleep_notifications() {
    use windows_sys::Win32::System::Power::{
        PowerRegisterSuspendResumeNotification, DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DEVICE_NOTIFY_CALLBACK, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND,
    };

    unsafe extern "system" fn on_power_event(
        _context: *const core::ffi::c_void,
        event: u32,
        _setting: *const core::ffi::c_void,
    ) -> u32 {
        if matches!(
            event,
            PBT_APMSUSPEND | PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND
        ) {
            request_lock("Windows sleep/resume");
        }
        0
    }

    let mut parameters = Box::new(DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS {
        Callback: Some(on_power_event),
        Context: std::ptr::null_mut(),
    });
    let mut registration = std::ptr::null_mut();
    // The callback has no borrowed context. Retain its parameters and OS
    // registration for the application lifetime, like the macOS observers.
    let result = unsafe {
        PowerRegisterSuspendResumeNotification(
            DEVICE_NOTIFY_CALLBACK,
            (&mut *parameters as *mut DEVICE_NOTIFY_SUBSCRIBE_PARAMETERS).cast(),
            &mut registration,
        )
    };
    if result == 0 {
        Box::leak(parameters);
    } else {
        log::warn!("Could not subscribe to Windows sleep notifications: {result}");
    }
}

#[cfg(all(
    unix,
    not(any(target_os = "macos", target_os = "ios", target_os = "android"))
))]
async fn linux_sleep_inhibitor(manager: &zbus::Proxy<'_>) -> Option<zbus::zvariant::OwnedFd> {
    match manager
        .call(
            "Inhibit",
            &("sleep", "Wealthfolio", "Lock protected profiles", "delay"),
        )
        .await
    {
        Ok(fd) => Some(fd),
        Err(error) => {
            log::warn!("Could not delay sleep for profile locking: {error}");
            None
        }
    }
}
