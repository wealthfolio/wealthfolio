use wealthfolio_connect::default_cloud_api_url;

pub fn connect_sync_enabled() -> bool {
    cfg!(feature = "connect-sync")
}

pub fn device_sync_enabled() -> bool {
    cfg!(feature = "device-sync")
}

pub fn cloud_sync_enabled() -> bool {
    connect_sync_enabled() || device_sync_enabled()
}

pub fn cloud_api_base_url() -> Option<String> {
    if !cloud_sync_enabled() {
        return None;
    }

    std::env::var("CONNECT_API_URL")
        .ok()
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| Some(default_cloud_api_url().to_string()))
}
