use std::collections::BTreeSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::json;

use super::addon_traits::AddonServiceTrait;
use super::models::*;
use super::network::{perform_addon_network_request, AddonNetworkRequest, AddonNetworkResponse};
use super::storage_repository::AddonStorageRepositoryTrait;

// Constants
pub const ADDON_STORE_API_BASE_URL: &str = "https://wealthfolio.app/api/addons";
const MAX_ADDON_ARCHIVE_ENTRIES: usize = 256;
const MAX_ADDON_ARCHIVE_FILE_SIZE: u64 = 5 * 1024 * 1024;
const MAX_ADDON_ARCHIVE_TOTAL_SIZE: u64 = 25 * 1024 * 1024;
const MAX_ADDON_ARCHIVE_COMPRESSED_SIZE: usize = 50 * 1024 * 1024;
const MAX_ADDON_STORAGE_KEY_LEN: usize = 128;
/// Upper bound on the serialized `{addon_id, key, value}` sync payload — NOT the
/// raw value length. A storage write emits a device-sync outbox event whose
/// payload is this JSON, encrypted (+40 B XChaCha20-Poly1305 nonce/tag) and
/// base64-encoded before it hits the sync server. The server caps the encrypted
/// base64 payload at 350,000 chars (`payload` in wealthfolio-cloud
/// `apps/api/src/schemas/sync.ts`), i.e. 350_000 * 3/4 - 40 = 262,460 plaintext
/// bytes. We bound the serialized payload (which is what actually gets encrypted,
/// so JSON escaping can't sneak past a raw-byte check) at 250_000 to keep
/// headroom. An oversized write is rejected at `set()` — otherwise it would
/// succeed locally and later dead-letter its whole sync push batch on the server.
/// To raise this: bump the cloud cap FIRST, then this constant, as a pair.
const MAX_ADDON_STORAGE_SYNC_PAYLOAD_LEN: usize = 250_000;

/// Implicit baseline capabilities that every addon may use without declaring a
/// permission or obtaining user consent. Mirrors `BASELINE_PERMISSION_CATEGORIES`
/// in `packages/addon-sdk/src/permissions.ts`. Legacy manifests that still declare
/// these keep parsing, but they never count as a permission escalation on update.
const BASELINE_PERMISSION_CATEGORIES: &[&str] = &["ui", "query", "toast", "logger", "storage"];

#[derive(Clone)]
struct AddonArchiveFile {
    name: String,
    content: Vec<u8>,
    is_main: bool,
}

struct ExtractedAddonArchive {
    metadata: AddonManifest,
    files: Vec<AddonArchiveFile>,
}

/// Helper function to create a request with common headers
fn create_request_with_headers(
    client: &reqwest::Client,
    method: reqwest::Method,
    url: &str,
) -> reqwest::RequestBuilder {
    let mut request = client.request(method, url);

    // Always add User-Agent, with version if available
    let app_version = option_env!("CARGO_PKG_VERSION");
    let user_agent = if let Some(version) = app_version {
        format!("Wealthfolio/{}", version)
    } else {
        "Wealthfolio".to_string()
    };
    request = request.header("User-Agent", user_agent);

    // Add X-App-Version header only if version is available
    if let Some(version) = app_version {
        request = request.header("X-App-Version", version);
    }

    request
}

/// Helper function to handle API response and parse JSON
async fn handle_api_response<T>(response: reqwest::Response, operation: &str) -> Result<T, String>
where
    T: serde::de::DeserializeOwned,
{
    let status = response.status();

    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        log::error!(
            "{} API returned error {}: {}",
            operation,
            status,
            error_text
        );
        return Err(format!(
            "{} API returned error {}: {}",
            operation, status, error_text
        ));
    }

    let response_text = response.text().await.map_err(|e| {
        log::error!("Failed to read {} API response: {}", operation, e);
        format!("Failed to read {} API response: {}", operation, e)
    })?;

    serde_json::from_str(&response_text).map_err(|e| {
        log::error!("Failed to parse {} API response as JSON: {}", operation, e);
        format!("Failed to parse {} API response: {}", operation, e)
    })
}

/// Initialize the addons directory in the provided data root
pub fn ensure_addons_directory(base_dir: impl AsRef<Path>) -> Result<PathBuf, String> {
    let addons_dir = base_dir.as_ref().join("addons");
    if !addons_dir.exists() {
        fs::create_dir_all(&addons_dir)
            .map_err(|e| format!("Failed to create addons directory: {}", e))?;
    }
    Ok(addons_dir)
}

pub fn validate_addon_id(addon_id: &str) -> Result<(), String> {
    if addon_id.is_empty() {
        return Err("Invalid addon id: id is empty".to_string());
    }
    if addon_id.len() > 64 {
        return Err("Invalid addon id: id must be 64 characters or fewer".to_string());
    }
    if addon_id == "." || addon_id == ".." || addon_id.chars().all(|c| c == '.') {
        return Err("Invalid addon id: dot-only ids are not allowed".to_string());
    }
    if addon_id == "staging" {
        return Err("Invalid addon id: 'staging' is reserved".to_string());
    }

    let mut chars = addon_id.chars();
    let Some(first) = chars.next() else {
        return Err("Invalid addon id: id is empty".to_string());
    };
    if !first.is_ascii_lowercase() && !first.is_ascii_digit() {
        return Err("Invalid addon id: id must start with a lowercase letter or digit".to_string());
    }

    if !chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '.' | '_' | '-'))
    {
        return Err("Invalid addon id: use lowercase letters, digits, '.', '_' or '-'".to_string());
    }

    Ok(())
}

/// Get addon directory path for a specific addon
pub fn get_addon_path(base_dir: impl AsRef<Path>, addon_id: &str) -> Result<PathBuf, String> {
    validate_addon_id(addon_id)?;
    let addons_dir = ensure_addons_directory(base_dir)?;
    Ok(addons_dir.join(addon_id))
}

pub fn validated_addon_archive_path(file_name: &str) -> Result<PathBuf, String> {
    if file_name.is_empty() {
        return Err("Unsafe addon archive path: path is empty".to_string());
    }

    if file_name.contains('\\') {
        return Err(format!(
            "Unsafe addon archive path '{}': backslashes are not allowed",
            file_name
        ));
    }

    if file_name.len() >= 2
        && file_name.as_bytes()[1] == b':'
        && file_name.as_bytes()[0].is_ascii_alphabetic()
    {
        return Err(format!(
            "Unsafe addon archive path '{}': Windows drive prefixes are not allowed",
            file_name
        ));
    }

    let path = Path::new(file_name);
    if path.is_absolute() {
        return Err(format!(
            "Unsafe addon archive path '{}': absolute paths are not allowed",
            file_name
        ));
    }

    let mut has_normal_component = false;
    for component in path.components() {
        match component {
            Component::Normal(_) => has_normal_component = true,
            Component::ParentDir => {
                return Err(format!(
                    "Unsafe addon archive path '{}': parent traversal is not allowed",
                    file_name
                ));
            }
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {
                return Err(format!("Unsafe addon archive path '{}'", file_name));
            }
        }
    }

    if !has_normal_component {
        return Err(format!(
            "Unsafe addon archive path '{}': no file components found",
            file_name
        ));
    }

    Ok(path.to_path_buf())
}

/// Simple permission detection based on common API function patterns
/// Returns detected permissions that can be merged with declared ones
pub fn detect_addon_permissions(addon_files: &[AddonFile]) -> Vec<AddonPermission> {
    // Define known permission categories and their associated functions
    // Use SDK category ids and current Host API function names
    let permission_patterns = vec![
        (
            "portfolio",
            "portfolio",
            vec![
                "getHoldings",
                "getHolding",
                "update",
                "recalculate",
                "getIncomeSummary",
                "getHistoricalValuations",
                "getLatestValuations",
            ],
            "Access to portfolio holdings, valuations, and performance",
        ),
        (
            "activities",
            "activities",
            vec![
                "getAll",
                "search",
                "create",
                "update",
                "saveMany",
                "import",
                "checkImport",
                "getImportMapping",
                "saveImportMapping",
            ],
            "Access to transaction history and activity management",
        ),
        (
            "accounts",
            "accounts",
            vec!["getAll", "create"],
            "Access to account information and management",
        ),
        (
            "market-data",
            "market",
            vec![
                "searchTicker",
                "syncHistory",
                "sync",
                "getProviders",
                "fetchDividends",
            ],
            "Access to quotes and market data",
        ),
        (
            "assets",
            "assets",
            vec!["getProfile", "updateProfile", "updateQuoteMode"],
            "Access to asset profiles and data sources",
        ),
        (
            "quotes",
            "quotes",
            vec!["update", "getHistory"],
            "Access to quote management",
        ),
        (
            "performance",
            "performance",
            vec![
                "calculateHistory",
                "calculateSummary",
                "calculateAccountsSimple",
            ],
            "Access to performance calculations",
        ),
        (
            "financial-planning",
            "goals",
            vec![
                "getAll",
                "create",
                "update",
                "getFunding",
                "saveFunding",
                "updateAllocations",
                "getAllocations",
            ],
            "Access to goals and contribution limits",
        ),
        (
            "contribution-limits",
            "contributionLimits",
            vec!["getAll", "create", "update", "calculateDeposits"],
            "Access to contribution limits and deposit calculations",
        ),
        (
            "currency",
            "exchangeRates",
            vec!["getAll", "update", "add"],
            "Access to exchange rates and currency data",
        ),
        (
            "settings",
            "settings",
            vec!["get", "update", "backupDatabase"],
            "Access to application settings",
        ),
        (
            "files",
            "files",
            vec!["openCsvDialog", "openSaveDialog"],
            "Access to file dialogs",
        ),
        (
            "secrets",
            "secrets",
            vec!["set", "get", "use", "delete"],
            "Access to secure storage for addon secrets",
        ),
        (
            "snapshots",
            "snapshots",
            vec![
                "getAll",
                "getByDate",
                "save",
                "checkImport",
                "importSnapshots",
                "delete",
            ],
            "Access to holdings snapshots",
        ),
        (
            "events",
            "events",
            vec![
                // Import events
                "onDropHover",
                "onDrop",
                "onDropCancelled",
                // Portfolio events
                "onUpdateStart",
                "onUpdateComplete",
                "onUpdateError",
                // Market events
                "onSyncStart",
                "onSyncComplete",
            ],
            "Access to application events",
        ),
        (
            "query",
            "query",
            vec!["invalidateQueries", "refetchQueries"],
            "Access to refresh host application data",
        ),
        (
            "network",
            "network",
            vec!["request"],
            "Access to declared external HTTPS hosts",
        ),
        (
            "ui",
            "ui",
            vec![
                "sidebar.addItem",
                "router.add",
                "navigation.navigate",
                "onDisable",
            ],
            "User interface and navigation",
        ),
    ];

    let mut detected_permissions: Vec<AddonPermission> = Vec::new();
    let current_time = chrono::Utc::now().to_rfc3339();

    // Group detected functions by category
    let mut category_functions: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();

    // Analyze all addon files for function usage
    for file in addon_files {
        log::debug!(
            "Analyzing file: {} (size: {} chars)",
            file.name,
            file.content.len()
        );

        for (category, api_category, functions, _purpose) in &permission_patterns {
            for function in functions {
                let mut function_detected = false;

                // For dotted function names (e.g., "sidebar.addItem"), check for the full pattern first
                if function.contains('.') {
                    let parts: Vec<&str> = function.split('.').collect();
                    if parts.len() == 2 {
                        let dotted_patterns = vec![
                            format!(".{}.{}(", parts[0], parts[1]), // ctx.sidebar.addItem(
                            format!("{}.{}(", parts[0], parts[1]),  // sidebar.addItem(
                            format!("ctx.{}.{}(", parts[0], parts[1]), // ctx.sidebar.addItem(
                        ];

                        for pattern in &dotted_patterns {
                            if file.content.contains(pattern) {
                                log::debug!(
                                    "Found dotted pattern '{}' in file '{}' for function '{}'",
                                    pattern,
                                    file.name,
                                    function
                                );
                                category_functions
                                    .entry(category.to_string())
                                    .or_default()
                                    .push(function.to_string());
                                function_detected = true;
                                break;
                            }
                        }
                    }
                }

                // For simple function names or if dotted pattern wasn't found
                if !function_detected {
                    // Create API-specific patterns to prevent false positives
                    let api_patterns = vec![
                        format!("api.{}.{}(", api_category, function), // api.portfolio.getHoldings(
                        format!(".api.{}.{}(", api_category, function), // ctx.api.portfolio.getHoldings(
                        format!("ctx.api.{}.{}(", api_category, function), // ctx.api.portfolio.getHoldings(
                    ];

                    // Handle events category with nested API structure
                    let events_patterns = if *category == "events" {
                        vec![
                            format!("ctx.api.events.import.{}(", function), // ctx.api.events.import.onDrop(
                            format!("ctx.api.events.portfolio.{}(", function), // ctx.api.events.portfolio.onUpdateStart(
                            format!("ctx.api.events.market.{}(", function), // ctx.api.events.market.onSyncStart(
                            format!("api.events.import.{}(", function), // api.events.import.onDrop(
                            format!("api.events.portfolio.{}(", function), // api.events.portfolio.onUpdateStart(
                            format!("api.events.market.{}(", function), // api.events.market.onSyncStart(
                        ]
                    } else {
                        vec![]
                    };

                    // Special patterns for non-API functions
                    let simple_patterns = if *category == "ui" {
                        vec![
                            format!(".{}(", function),    // ctx.onDisable( or minified e.onDisable(
                            format!("{}(", function),     // onDisable(
                            format!("ctx.{}(", function), // ctx.onDisable(
                        ]
                    } else {
                        vec![] // No simple patterns for API functions to prevent false positives
                    };

                    // First try API-specific patterns
                    let mut pattern_found = false;
                    for pattern in &api_patterns {
                        if file.content.contains(pattern) {
                            log::debug!(
                                "Found API pattern '{}' in file '{}' for function '{}'",
                                pattern,
                                file.name,
                                function
                            );
                            category_functions
                                .entry(category.to_string())
                                .or_default()
                                .push(function.to_string());
                            pattern_found = true;
                            break;
                        }
                    }

                    // If no API pattern found, try events patterns
                    if !pattern_found {
                        for pattern in &events_patterns {
                            if file.content.contains(pattern) {
                                log::debug!(
                                    "Found events pattern '{}' in file '{}' for function '{}'",
                                    pattern,
                                    file.name,
                                    function
                                );
                                category_functions
                                    .entry(category.to_string())
                                    .or_default()
                                    .push(function.to_string());
                                pattern_found = true;
                                break;
                            }
                        }
                    }

                    // If no API or events pattern found, try simple patterns (for special cases like onDisable)
                    if !pattern_found {
                        for pattern in &simple_patterns {
                            if file.content.contains(pattern) {
                                log::debug!(
                                    "Found simple pattern '{}' in file '{}' for function '{}'",
                                    pattern,
                                    file.name,
                                    function
                                );
                                category_functions
                                    .entry(category.to_string())
                                    .or_default()
                                    .push(function.to_string());
                                break; // Only add once per function per file
                            }
                        }
                    }
                }
            }
        }

        if file.content.contains(".network.request(")
            && file.content.contains("auth")
            && file.content.contains("secretKey")
        {
            category_functions
                .entry("secrets".to_string())
                .or_default()
                .push("use".to_string());
        }
    }

    // Create permission objects for each category with detected functions
    for (category, functions) in category_functions {
        // Remove duplicates
        let mut unique_functions = functions;
        unique_functions.sort();
        unique_functions.dedup();

        // Find the purpose for this category
        let purpose = permission_patterns
            .iter()
            .find(|(cat, _, _, _)| cat == &category)
            .map(|(_, _, _, purpose)| purpose.to_string())
            .unwrap_or_else(|| format!("Access to {} functions", category));

        // Create FunctionPermission objects for detected functions
        let function_permissions: Vec<FunctionPermission> = unique_functions
            .into_iter()
            .map(|func_name| FunctionPermission {
                name: func_name,
                is_declared: false,
                is_detected: true,
                detected_at: Some(current_time.clone()),
            })
            .collect();

        detected_permissions.push(AddonPermission {
            category,
            functions: function_permissions,
            purpose,
        });
    }

    log::debug!(
        "Permission detection completed. Found {} categories with permissions",
        detected_permissions.len()
    );
    for perm in &detected_permissions {
        log::debug!(
            "Category '{}': {} functions detected",
            perm.category,
            perm.functions.len()
        );
    }

    detected_permissions
}

fn merge_detected_permissions(
    declared_permissions: Option<&[AddonPermission]>,
    detected_permissions: Vec<AddonPermission>,
) -> Vec<AddonPermission> {
    let mut merged_permissions = Vec::new();

    if let Some(declared_permissions) = declared_permissions {
        for permission in declared_permissions {
            merged_permissions.push(AddonPermission {
                category: permission.category.clone(),
                functions: permission.functions.clone(),
                purpose: permission.purpose.clone(),
            });
        }
    }

    for detected_permission in detected_permissions {
        if let Some(existing) = merged_permissions
            .iter_mut()
            .find(|permission| permission.category == detected_permission.category)
        {
            for detected_function in &detected_permission.functions {
                if let Some(existing_function) = existing
                    .functions
                    .iter_mut()
                    .find(|function| function.name == detected_function.name)
                {
                    existing_function.is_detected = true;
                    existing_function.detected_at = detected_function.detected_at.clone();
                } else {
                    existing.functions.push(detected_function.clone());
                }
            }
        } else {
            merged_permissions.push(detected_permission);
        }
    }

    merged_permissions
}

fn archive_file_to_addon_file(file: AddonArchiveFile) -> AddonFile {
    AddonFile {
        name: file.name,
        content: String::from_utf8(file.content).unwrap_or_default(),
        is_main: file.is_main,
    }
}

fn archive_files_to_text_files(files: &[AddonArchiveFile]) -> Vec<AddonFile> {
    files
        .iter()
        .filter_map(|file| {
            String::from_utf8(file.content.clone())
                .ok()
                .map(|content| AddonFile {
                    name: file.name.clone(),
                    content,
                    is_main: file.is_main,
                })
        })
        .collect()
}

fn extract_addon_zip_archive(zip_data: Vec<u8>) -> Result<ExtractedAddonArchive, String> {
    use std::io::Cursor;
    use zip::ZipArchive;

    if zip_data.is_empty() {
        return Err("ZIP addon data is empty".to_string());
    }
    if zip_data.len() > MAX_ADDON_ARCHIVE_COMPRESSED_SIZE {
        return Err(format!(
            "ZIP addon is too large: {} bytes exceeds {} byte limit",
            zip_data.len(),
            MAX_ADDON_ARCHIVE_COMPRESSED_SIZE
        ));
    }

    let cursor = Cursor::new(zip_data);
    let mut archive = ZipArchive::new(cursor).map_err(|e| format!("Failed to read ZIP: {}", e))?;
    if archive.len() > MAX_ADDON_ARCHIVE_ENTRIES {
        return Err(format!(
            "ZIP addon has too many entries: {} exceeds {} entry limit",
            archive.len(),
            MAX_ADDON_ARCHIVE_ENTRIES
        ));
    }

    let mut files = Vec::new();
    let mut manifest_json: Option<String> = None;
    let mut main_file: Option<String> = None;
    let mut total_uncompressed_size = 0u64;

    // Extract all files from ZIP
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to access file {}: {}", i, e))?;

        if file.is_dir() {
            continue;
        }

        let file_name = file.name().to_string();
        validated_addon_archive_path(&file_name)?;

        if file_name.ends_with(".map") {
            log::debug!("Skipping addon source map '{}'", file_name);
            continue;
        }

        let file_size = file.size();
        if file_size > MAX_ADDON_ARCHIVE_FILE_SIZE {
            return Err(format!(
                "ZIP addon file '{}' is too large: {} bytes exceeds {} byte limit",
                file_name, file_size, MAX_ADDON_ARCHIVE_FILE_SIZE
            ));
        }
        total_uncompressed_size = total_uncompressed_size
            .checked_add(file_size)
            .ok_or_else(|| "ZIP addon uncompressed size overflowed".to_string())?;
        if total_uncompressed_size > MAX_ADDON_ARCHIVE_TOTAL_SIZE {
            return Err(format!(
                "ZIP addon uncompressed size is too large: {} bytes exceeds {} byte limit",
                total_uncompressed_size, MAX_ADDON_ARCHIVE_TOTAL_SIZE
            ));
        }

        let mut contents = Vec::with_capacity(file_size.min(MAX_ADDON_ARCHIVE_FILE_SIZE) as usize);
        let bytes_read = file
            .by_ref()
            .take(MAX_ADDON_ARCHIVE_FILE_SIZE + 1)
            .read_to_end(&mut contents)
            .map_err(|e| format!("Failed to read file {}: {}", file_name, e))?;
        if bytes_read as u64 > MAX_ADDON_ARCHIVE_FILE_SIZE {
            return Err(format!(
                "ZIP addon file '{}' exceeds {} byte limit",
                file_name, MAX_ADDON_ARCHIVE_FILE_SIZE
            ));
        }

        // Check for manifest.json
        if file_name == "manifest.json" || file_name.ends_with("/manifest.json") {
            manifest_json = Some(
                String::from_utf8(contents.clone())
                    .map_err(|e| format!("Failed to read manifest.json as UTF-8: {}", e))?,
            );
        }

        // Check for main addon file (fallback detection)
        let is_main_fallback = file_name.ends_with("addon.js")
            || file_name.ends_with("addon.jsx")
            || file_name.ends_with("index.js")
            || file_name.ends_with("index.jsx")
            || file_name.contains("dist/addon.js");

        if is_main_fallback && main_file.is_none() {
            main_file = Some(file_name.clone());
        }

        files.push(AddonArchiveFile {
            name: file_name,
            content: contents,
            is_main: false, // Will be set correctly after parsing manifest.json
        });
    }

    // Parse metadata from manifest.json or fallback to file analysis
    let metadata = if let Some(manifest_content) = manifest_json {
        parse_manifest_json_metadata(&manifest_content)?
    } else {
        return Err("ZIP addon must contain a manifest.json file with addon metadata".to_string());
    };

    // Now set the is_main flag correctly based on the metadata.main path
    let main_file = metadata.get_main()?;
    for file in &mut files {
        file.is_main = archive_path_matches_manifest_main(&file.name, main_file);
    }

    // Verify that we found the main file
    let main_file_found = files.iter().any(|f| f.is_main);
    if !main_file_found {
        return Err(format!(
            "Main addon file '{}' not found. Available files: {}",
            main_file,
            files
                .iter()
                .map(|f| f.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    // Perform permission detection on the extracted files (same as install_addon_zip)
    log::debug!(
        "Starting permission detection for extracted addon: {}",
        metadata.id
    );
    let permission_files = archive_files_to_text_files(&files);
    log::debug!("Number of files to analyze: {}", permission_files.len());
    for file in &permission_files {
        log::debug!(
            "File: {} (size: {} chars, is_main: {})",
            file.name,
            file.content.len(),
            file.is_main
        );
    }

    let detected_permissions = detect_addon_permissions(&permission_files);
    log::debug!(
        "Permission detection completed for extracted addon: {}",
        metadata.id
    );
    log::debug!(
        "Detected {} permission categories",
        detected_permissions.len()
    );

    let merged_permissions =
        merge_detected_permissions(metadata.permissions.as_deref(), detected_permissions);

    // Create a metadata copy with merged permissions for the extracted addon
    let mut metadata_with_merged_permissions = metadata;
    metadata_with_merged_permissions.permissions = Some(merged_permissions.clone());

    // Debug log the final merged permissions
    log::debug!(
        "Final merged permissions for extracted addon {}: {:#?}",
        metadata_with_merged_permissions.id,
        merged_permissions
    );
    for perm in &merged_permissions {
        log::debug!(
            "Category '{}': {} functions",
            perm.category,
            perm.functions.len()
        );
        for func in &perm.functions {
            log::debug!(
                "  Function '{}': declared={}, detected={}",
                func.name,
                func.is_declared,
                func.is_detected
            );
        }
    }

    Ok(ExtractedAddonArchive {
        metadata: metadata_with_merged_permissions,
        files,
    })
}

pub fn extract_addon_zip_internal(zip_data: Vec<u8>) -> Result<ExtractedAddon, String> {
    let extracted = extract_addon_zip_archive(zip_data)?;
    Ok(ExtractedAddon {
        metadata: extracted.metadata,
        files: extracted
            .files
            .into_iter()
            .map(archive_file_to_addon_file)
            .collect(),
    })
}

/// The running Wealthfolio host version. `wealthfolio-core` inherits the workspace
/// package version (`workspace.package.version`), which is the app version shipped
/// by both the Tauri desktop app and the server, so `CARGO_PKG_VERSION` is the
/// authoritative host version here.
pub const HOST_WEALTHFOLIO_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Parse a dot-separated version into its leading numeric `(major, minor, patch)`
/// components, ignoring any pre-release/build suffix (e.g. `-beta.1`, `+build`).
/// Missing components default to 0. Returns `None` when any dotted component is
/// not a bare integer (`"v4.0.0"`, `"4.0.x"`) — callers must treat that as
/// unsatisfiable rather than silently comparing against `0.0.0`, which would
/// turn an author typo into a disabled version gate.
fn parse_version_triple(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.trim().split(['-', '+']).next().unwrap_or("").trim();
    if core.is_empty() {
        return None;
    }
    let mut components = [0u64; 3];
    for (i, part) in core.split('.').enumerate() {
        let value = part.trim().parse::<u64>().ok()?;
        if let Some(slot) = components.get_mut(i) {
            *slot = value;
        }
    }
    Some((components[0], components[1], components[2]))
}

/// Whether `current` satisfies the minimum `required` version (semver-style numeric
/// comparison of major.minor.patch). Fails closed: an unparseable version on
/// either side never satisfies the check.
pub(crate) fn version_meets_minimum(current: &str, required: &str) -> bool {
    match (
        parse_version_triple(current),
        parse_version_triple(required),
    ) {
        (Some(current), Some(required)) => current >= required,
        _ => false,
    }
}

/// Hard-fail install/enable when the addon requires a newer host than the one
/// running. No-op when `minWealthfolioVersion` is absent; a malformed value is
/// rejected outright so the author sees the typo instead of the gate silently
/// evaporating.
fn enforce_min_wealthfolio_version(manifest: &AddonManifest) -> Result<(), String> {
    if let Some(required) = manifest.min_wealthfolio_version.as_deref() {
        let required = required.trim();
        if required.is_empty() {
            return Ok(());
        }
        if parse_version_triple(required).is_none() {
            return Err(format!(
                "Invalid 'minWealthfolioVersion' value '{}' in manifest: expected a version like '3.6.1'",
                required
            ));
        }
        if !version_meets_minimum(HOST_WEALTHFOLIO_VERSION, required) {
            return Err(format!(
                "Addon requires Wealthfolio {} or newer, but this version is {}. Update Wealthfolio to use this addon.",
                required, HOST_WEALTHFOLIO_VERSION
            ));
        }
    }
    Ok(())
}

fn validate_contributed_route_path(path: &str) -> Result<(), String> {
    if path != path.trim() {
        return Err(
            "Invalid contributes.routes path: leading or trailing whitespace is not allowed"
                .to_string(),
        );
    }
    if path.is_empty() {
        return Ok(());
    }
    if path.starts_with('/') {
        return Err(
            "Invalid contributes.routes path: expected a relative path below the addon mount"
                .to_string(),
        );
    }
    if path
        .chars()
        .any(|character| matches!(character, '\\' | '?' | '#' | '%'))
    {
        return Err(
            "Invalid contributes.routes path: backslashes, escapes, queries, and fragments are not allowed"
                .to_string(),
        );
    }
    if path
        .split('/')
        .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        return Err(
            "Invalid contributes.routes path: empty and traversal segments are not allowed"
                .to_string(),
        );
    }
    Ok(())
}

pub fn parse_manifest_json_metadata(manifest_content: &str) -> Result<AddonManifest, String> {
    parse_manifest_json_metadata_with_options(manifest_content, true)
}

fn parse_installed_manifest_json_metadata(manifest_content: &str) -> Result<AddonManifest, String> {
    parse_manifest_json_metadata_with_options(manifest_content, false)
}

fn parse_manifest_json_metadata_with_options(
    manifest_content: &str,
    enforce_canonical_id: bool,
) -> Result<AddonManifest, String> {
    // First, parse as a raw JSON value to handle the legacy format
    let raw_manifest: serde_json::Value = serde_json::from_str(manifest_content)
        .map_err(|e| format!("Invalid manifest.json: {}", e))?;

    // Parse the basic manifest fields
    let id = raw_manifest["id"]
        .as_str()
        .ok_or("Missing 'id' field in manifest.json")?
        .to_string();
    let name = raw_manifest["name"]
        .as_str()
        .ok_or("Missing 'name' field in manifest.json")?
        .to_string();
    let version = raw_manifest["version"]
        .as_str()
        .ok_or("Missing 'version' field in manifest.json")?
        .to_string();
    let main = raw_manifest["main"].as_str().map(|s| s.to_string());
    let description = raw_manifest["description"].as_str().map(|s| s.to_string());
    let author = raw_manifest["author"].as_str().map(|s| s.to_string());
    let sdk_version = raw_manifest["sdkVersion"].as_str().map(|s| s.to_string());
    let enabled = raw_manifest["enabled"].as_bool();
    let homepage = raw_manifest["homepage"].as_str().map(|s| s.to_string());
    let repository = raw_manifest["repository"].as_str().map(|s| s.to_string());
    let license = raw_manifest["license"].as_str().map(|s| s.to_string());
    let min_wealthfolio_version = raw_manifest["minWealthfolioVersion"]
        .as_str()
        .map(|s| s.to_string());
    let keywords = raw_manifest["keywords"].as_array().map(|arr| {
        arr.iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect()
    });
    let icon = raw_manifest["icon"].as_str().map(|s| s.to_string());
    let host_dependencies = raw_manifest["hostDependencies"].as_object().map(|deps| {
        deps.iter()
            .filter_map(|(name, version)| {
                version
                    .as_str()
                    .map(|version| (name.clone(), version.to_string()))
            })
            .collect()
    });
    let network = if let Some(network_value) = raw_manifest.get("network") {
        if network_value.is_null() {
            None
        } else {
            let mut allowed_hosts = network_value["allowedHosts"]
                .as_array()
                .ok_or("Missing or invalid 'network.allowedHosts' field in manifest")?
                .iter()
                .map(|host| {
                    host.as_str()
                        .map(|s| s.trim().trim_end_matches('.').to_ascii_lowercase())
                        .filter(|s| !s.is_empty() && s.len() <= 253)
                        .ok_or("Invalid network allowed host in manifest")
                })
                .collect::<Result<Vec<_>, _>>()?;
            allowed_hosts.sort();
            allowed_hosts.dedup();
            let mut approved_hosts = network_value["approvedHosts"]
                .as_array()
                .map(|hosts| {
                    hosts
                        .iter()
                        .filter_map(|host| {
                            host.as_str()
                                .map(|s| s.trim().trim_end_matches('.').to_ascii_lowercase())
                        })
                        .filter(|host| allowed_hosts.contains(host))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            approved_hosts.sort();
            approved_hosts.dedup();
            Some(AddonNetworkAccess {
                allowed_hosts,
                approved_hosts,
            })
        }
    } else {
        None
    };

    // Declarative contributions (routes + links). Parse the whole `contributes`
    // sub-object via serde for brevity, then validate: every route has a
    // non-empty id with a unique host-relative path, and every link (in any slot,
    // including unknown future slots, which are accepted and round-tripped
    // as-is) has a non-empty label and references a declared route id.
    let contributes = match raw_manifest.get("contributes") {
        Some(value) if !value.is_null() => {
            let parsed: AddonContributes = serde_json::from_value(value.clone())
                .map_err(|e| format!("Invalid 'contributes' field in manifest.json: {}", e))?;
            let mut route_ids = std::collections::HashSet::new();
            let mut route_paths = std::collections::HashSet::new();
            for route in &parsed.routes {
                if route.id.trim().is_empty() {
                    return Err("Missing 'id' field in contributes.routes entry".to_string());
                }
                if !route_ids.insert(route.id.as_str()) {
                    return Err(format!(
                        "Invalid 'contributes' field in manifest.json: duplicate route id '{}'",
                        route.id
                    ));
                }
                let path = route.path.as_deref().unwrap_or("");
                validate_contributed_route_path(path)?;
                if !route_paths.insert(path.to_ascii_lowercase()) {
                    return Err(format!(
                        "Invalid 'contributes' field in manifest.json: duplicate route path '{}'",
                        path
                    ));
                }
            }
            for (slot, links) in &parsed.links {
                let mut link_ids = std::collections::HashSet::new();
                for link in links {
                    if link.route.trim().is_empty() {
                        return Err(format!(
                            "Missing 'route' field in contributes.links['{}'] entry",
                            slot
                        ));
                    }
                    if link.label.trim().is_empty() {
                        return Err(format!(
                            "Missing 'label' field in contributes.links['{}'] entry",
                            slot
                        ));
                    }
                    if !route_ids.contains(link.route.as_str()) {
                        return Err(format!(
                            "Invalid 'contributes' field in manifest.json: link in slot '{}' references undeclared route '{}'",
                            slot, link.route
                        ));
                    }
                    let effective_id = link.id.as_deref().unwrap_or(link.route.as_str());
                    if !link_ids.insert(effective_id) {
                        return Err(format!(
                            "Invalid 'contributes' field in manifest.json: duplicate link id '{}' in slot '{}'",
                            effective_id, slot
                        ));
                    }
                }
            }
            Some(parsed)
        }
        _ => None,
    };

    // Validate required fields
    if main.is_none() {
        return Err("Missing 'main' field in manifest.json".to_string());
    }
    if enforce_canonical_id {
        validate_addon_id(&id)?;
    } else {
        validate_addon_id(&id.to_ascii_lowercase())?;
    }
    if let Some(main_path) = &main {
        validated_addon_archive_path(main_path)?;
    }

    // Handle permissions - convert from legacy string array format to new FunctionPermission format
    let permissions = if let Some(perms_array) = raw_manifest["permissions"].as_array() {
        let mut converted_permissions = Vec::new();

        for perm_value in perms_array {
            let category = perm_value["category"]
                .as_str()
                .ok_or("Missing 'category' field in permission")?
                .to_string();
            let purpose = perm_value["purpose"]
                .as_str()
                .ok_or("Missing 'purpose' field in permission")?
                .to_string();

            // Handle both string arrays and FunctionPermission objects
            let functions = if let Some(functions_array) = perm_value["functions"].as_array() {
                let mut function_permissions = Vec::new();

                for func_value in functions_array {
                    if let Some(func_name) = func_value.as_str() {
                        // Legacy format: string array
                        function_permissions.push(FunctionPermission {
                            name: func_name.to_string(),
                            is_declared: true,
                            is_detected: false,
                            detected_at: None,
                        });
                    } else if func_value.is_object() {
                        // New format: FunctionPermission object
                        let name = func_value["name"]
                            .as_str()
                            .ok_or("Missing 'name' field in function permission")?
                            .to_string();
                        let is_declared = func_value["isDeclared"].as_bool().unwrap_or(true);
                        let is_detected = func_value["isDetected"].as_bool().unwrap_or(false);
                        let detected_at = func_value["detectedAt"].as_str().map(|s| s.to_string());

                        function_permissions.push(FunctionPermission {
                            name,
                            is_declared,
                            is_detected,
                            detected_at,
                        });
                    }
                }

                function_permissions
            } else {
                return Err("Missing or invalid 'functions' field in permission".to_string());
            };

            converted_permissions.push(AddonPermission {
                category,
                functions,
                purpose,
            });
        }

        Some(converted_permissions)
    } else {
        None
    };

    // Return manifest with converted permissions but without runtime fields yet
    Ok(AddonManifest {
        id,
        name,
        version,
        description,
        author,
        sdk_version,
        main,
        enabled,
        permissions,
        homepage,
        repository,
        license,
        min_wealthfolio_version,
        keywords,
        icon,
        network,
        host_dependencies,
        contributes,
        installed_at: None,
        updated_at: None,
        source: None,
        size: None,
    })
}

pub fn read_addon_files_recursive(
    current_dir: &Path,
    base_dir: &Path,
    files: &mut Vec<AddonFile>,
) -> Result<(), String> {
    let entries =
        fs::read_dir(current_dir).map_err(|e| format!("Failed to read addon directory: {}", e))?;

    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
        let file_path = entry.path();

        if file_path.is_dir() {
            // Recursively read subdirectories
            read_addon_files_recursive(&file_path, base_dir, files)?;
        } else if file_path.is_file() {
            let file_name = file_path.file_name().unwrap().to_string_lossy().to_string();

            // Skip the manifest file
            if file_name == "manifest.json" {
                continue;
            }

            // Get relative path from base directory
            let relative_path = file_path
                .strip_prefix(base_dir)
                .map_err(|e| format!("Failed to get relative path: {}", e))?;
            let relative_path_str = relative_path.to_string_lossy().to_string();

            if relative_path_str.ends_with(".map") {
                log::debug!("Skipping addon source map '{}'", relative_path_str);
                continue;
            }

            let metadata = fs::metadata(&file_path).map_err(|e| {
                format!("Failed to read file metadata {}: {}", relative_path_str, e)
            })?;
            if metadata.len() > MAX_ADDON_ARCHIVE_FILE_SIZE {
                return Err(format!(
                    "Addon file '{}' is too large: {} bytes exceeds {} byte limit",
                    relative_path_str,
                    metadata.len(),
                    MAX_ADDON_ARCHIVE_FILE_SIZE
                ));
            }
            let bytes = fs::read(&file_path)
                .map_err(|e| format!("Failed to read file {}: {}", relative_path_str, e))?;
            let content = match String::from_utf8(bytes) {
                Ok(content) => content,
                Err(_) => {
                    log::debug!("Skipping non-UTF-8 addon asset '{}'", relative_path_str);
                    continue;
                }
            };

            files.push(AddonFile {
                name: relative_path_str,
                content,
                is_main: false, // Will be set later in the calling function
            });
        }
    }

    Ok(())
}

/// Check for addon updates from the API server
pub async fn check_addon_update_from_api(
    addon_id: &str,
    current_version: &str,
) -> Result<AddonUpdateCheckResult, String> {
    validate_addon_id(addon_id)?;
    let api_url = format!(
        "{}/update-check?addonId={}&currentVersion={}",
        ADDON_STORE_API_BASE_URL, addon_id, current_version
    );

    let client = reqwest::Client::new();
    let response = create_request_with_headers(&client, reqwest::Method::GET, &api_url)
        .send()
        .await
        .map_err(|e| {
            log::error!("Failed to fetch addon info from API: {}", e);
            format!("Failed to fetch addon info from API: {}", e)
        })?;

    handle_api_response(response, "Update check").await
}

/// Download addon package from URL
pub async fn download_addon_package(
    download_url: &str,
    expected_sha256: &str,
) -> Result<Vec<u8>, String> {
    download_addon_package_verified(download_url, expected_sha256).await
}

pub(crate) fn archive_path_matches_manifest_main(file_name: &str, main_file: &str) -> bool {
    let file_name = file_name.replace('\\', "/");
    let main_file = main_file.replace('\\', "/");
    let main_file = main_file.trim_start_matches('/');
    if main_file.is_empty() {
        return false;
    }

    file_name == main_file || file_name.ends_with(&format!("/{main_file}"))
}

pub fn verify_addon_package_sha256(zip_data: &[u8], expected_sha256: &str) -> Result<(), String> {
    let expected = expected_sha256.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid addon package SHA-256 digest".to_string());
    }

    use sha2::{Digest, Sha256};
    let actual = hex::encode(Sha256::digest(zip_data));
    if actual != expected {
        return Err("Addon package SHA-256 digest did not match".to_string());
    }

    Ok(())
}

pub async fn download_addon_package_verified(
    download_url: &str,
    expected_sha256: &str,
) -> Result<Vec<u8>, String> {
    download_addon_package_with_optional_sha256(download_url, Some(expected_sha256)).await
}

async fn download_addon_package_with_optional_sha256(
    download_url: &str,
    expected_sha256: Option<&str>,
) -> Result<Vec<u8>, String> {
    log::info!("Downloading addon package from URL: {}", download_url);

    let client = reqwest::Client::new();
    let mut request = client.get(download_url);

    // Always add User-Agent, with version if available
    let app_version = option_env!("CARGO_PKG_VERSION");
    let user_agent = if let Some(version) = app_version {
        format!("Wealthfolio/{}", version)
    } else {
        "Wealthfolio".to_string()
    };
    request = request.header("User-Agent", user_agent);

    // Add X-App-Version header only if version is available
    if let Some(version) = app_version {
        request = request.header("X-App-Version", version);
    }

    let response = request.send().await.map_err(|e| {
        log::error!(
            "Failed to download addon package from '{}': {}",
            download_url,
            e
        );
        format!("Failed to download addon package: {}", e)
    })?;

    let status = response.status();
    log::debug!(
        "Package download response status from '{}': {}",
        download_url,
        status
    );

    if !status.is_success() {
        log::error!(
            "Package download failed with status {} from URL: {}",
            status,
            download_url
        );
        return Err(format!("Download failed with status: {}", status));
    }

    let zip_data = response
        .bytes()
        .await
        .map_err(|e| {
            log::error!(
                "Failed to read download data from '{}': {}",
                download_url,
                e
            );
            format!("Failed to read download data: {}", e)
        })?
        .to_vec();

    log::info!(
        "Successfully downloaded addon package ({} bytes) from: {}",
        zip_data.len(),
        download_url
    );

    if let Some(expected_sha256) = expected_sha256 {
        verify_addon_package_sha256(&zip_data, expected_sha256)?;
        log::info!(
            "Verified SHA-256 digest for addon package: {}",
            download_url
        );
    } else {
        log::warn!(
            "Addon package download from '{}' did not include a SHA-256 digest; skipping package verification",
            download_url
        );
    }

    Ok(zip_data)
}

/// Get staging directory for downloads
pub fn get_staging_directory(base_dir: impl AsRef<Path>) -> Result<PathBuf, String> {
    let staging_dir = base_dir.as_ref().join("addons").join("staging");

    if !staging_dir.exists() {
        fs::create_dir_all(&staging_dir)
            .map_err(|e| format!("Failed to create staging directory: {}", e))?;
    }

    Ok(staging_dir)
}

/// Clear staging directory
pub fn clear_staging_directory(base_dir: impl AsRef<Path>) -> Result<(), String> {
    let staging_dir = get_staging_directory(base_dir)?;

    if staging_dir.exists() {
        fs::remove_dir_all(&staging_dir)
            .map_err(|e| format!("Failed to clear staging directory: {}", e))?;

        // Recreate the empty staging directory
        fs::create_dir_all(&staging_dir)
            .map_err(|e| format!("Failed to recreate staging directory: {}", e))?;
    }

    Ok(())
}

/// Download addon from store using GET request
pub async fn download_addon_from_store(addon_id: &str) -> Result<Vec<u8>, String> {
    validate_addon_id(addon_id)?;
    let download_api_url = format!("{}/{}/download", ADDON_STORE_API_BASE_URL, addon_id);

    log::info!(
        "Calling download API for addon '{}' at URL: {}",
        addon_id,
        download_api_url
    );
    let client = reqwest::Client::new();
    let response = create_request_with_headers(&client, reqwest::Method::GET, &download_api_url)
        .send()
        .await
        .map_err(|e| {
            log::error!("Failed to call download API for addon {}: {}", addon_id, e);
            format!("Failed to call download API: {}", e)
        })?;

    let status = response.status();
    log::debug!(
        "Download API response status for addon '{}': {}",
        addon_id,
        status
    );

    // Log response headers for debugging
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("unknown");
    log::debug!("Response content-type: {}", content_type);

    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        log::error!(
            "Download API returned error {} for addon '{}' at URL '{}': {}",
            status,
            addon_id,
            download_api_url,
            error_text
        );
        return match status.as_u16() {
            404 => Err("Addon not found or coming soon".to_string()),
            410 => Err("Addon is inactive or deprecated".to_string()),
            503 => Err("Download service temporarily unavailable".to_string()),
            _ => Err(format!(
                "Download API returned error {}: {}",
                status, error_text
            )),
        };
    }

    // Check if response is JSON (containing download URL) or direct ZIP data
    if content_type.contains("application/json") {
        log::debug!("Response is JSON, parsing for download URL");

        // Parse JSON response to get actual download URL
        let response_text = response.text().await.map_err(|e| {
            log::error!("Failed to read JSON download response: {}", e);
            format!("Failed to read download response: {}", e)
        })?;

        log::debug!("Download API returned JSON response");

        let download_response: serde_json::Value =
            serde_json::from_str(&response_text).map_err(|e| {
                log::error!("Failed to parse download API response as JSON: {}", e);
                format!("Failed to parse download response: {}", e)
            })?;

        // Extract the actual download URL
        let actual_download_url = download_response
            .get("downloadUrl")
            .and_then(|v| v.as_str())
            .ok_or("Download API response missing downloadUrl field")?;
        let expected_sha256 = download_response
            .get("sha256")
            .or_else(|| download_response.get("checksumSha256"))
            .and_then(|v| v.as_str())
            .map(str::to_string);

        log::info!(
            "Got download URL for addon '{}': {}",
            addon_id,
            actual_download_url
        );

        // Now download the actual file
        return download_addon_package_with_optional_sha256(
            actual_download_url,
            expected_sha256.as_deref(),
        )
        .await;
    } else {
        log::debug!("Response is binary data, treating as direct ZIP download");
        let expected_sha256 = response
            .headers()
            .get("x-addon-sha256")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);

        // Download the addon package directly (GET request returns the file)
        let zip_data = response
            .bytes()
            .await
            .map_err(|e| {
                log::error!(
                    "Failed to read download data for addon '{}': {}",
                    addon_id,
                    e
                );
                format!("Failed to read download data: {}", e)
            })?
            .to_vec();

        log::info!(
            "Successfully downloaded addon package ({} bytes) for addon '{}'",
            zip_data.len(),
            addon_id
        );

        // Quick check of downloaded data
        if zip_data.len() < 100 {
            log::warn!(
                "Downloaded data for addon '{}' is suspiciously small: {} bytes",
                addon_id,
                zip_data.len()
            );
            if !zip_data.is_empty() {
                let preview = String::from_utf8_lossy(&zip_data);
                log::debug!("Small download content: {}", preview);
            }
        }

        if let Some(expected_sha256) = expected_sha256 {
            verify_addon_package_sha256(&zip_data, &expected_sha256)?;
            log::info!("Verified SHA-256 digest for addon '{}'", addon_id);
        } else {
            log::warn!(
                "Download response for addon '{}' did not include x-addon-sha256; skipping package verification",
                addon_id
            );
        }

        Ok(zip_data)
    }
}

/// Save addon data to staging directory
pub fn save_addon_to_staging(
    addon_id: &str,
    base_dir: impl AsRef<Path>,
    zip_data: &[u8],
) -> Result<PathBuf, String> {
    validate_addon_id(addon_id)?;
    let staging_dir = get_staging_directory(base_dir)?;
    let staged_file_path = staging_dir.join(format!("{}.zip", addon_id));

    // Validate zip data before saving
    if zip_data.is_empty() {
        return Err("Cannot stage empty addon data".to_string());
    }
    if zip_data.len() > MAX_ADDON_ARCHIVE_COMPRESSED_SIZE {
        return Err(format!(
            "Cannot stage addon data larger than {} bytes",
            MAX_ADDON_ARCHIVE_COMPRESSED_SIZE
        ));
    }

    log::debug!(
        "Validating ZIP data for addon '{}': {} bytes",
        addon_id,
        zip_data.len()
    );

    // Log first few bytes for debugging
    if zip_data.len() >= 4 {
        log::debug!(
            "First 4 bytes: {:02x} {:02x} {:02x} {:02x}",
            zip_data[0],
            zip_data[1],
            zip_data[2],
            zip_data[3]
        );
    }

    // Check for ZIP signature
    if zip_data.len() < 4 || &zip_data[0..4] != b"PK\x03\x04" {
        if zip_data.len() >= 100 {
            // Log first 100 bytes as string to see if it's an error response
            let preview = String::from_utf8_lossy(&zip_data[0..100]);
            log::error!(
                "Invalid ZIP signature for addon '{}'. Data preview: {}",
                addon_id,
                preview
            );
        }
        return Err(format!(
            "Invalid ZIP data: missing ZIP signature (got {} bytes)",
            zip_data.len()
        ));
    }

    // Quick validation that it's a valid zip
    use std::io::Cursor;
    use zip::ZipArchive;

    let cursor = Cursor::new(zip_data);
    let archive_result = ZipArchive::new(cursor);

    match archive_result {
        Ok(mut archive) => {
            log::debug!(
                "ZIP validation successful for addon '{}': {} files",
                addon_id,
                archive.len()
            );
            // Verify we can read at least the manifest
            let mut manifest_found = false;
            for i in 0..archive.len() {
                if let Ok(file) = archive.by_index(i) {
                    if file.name() == "manifest.json" || file.name().ends_with("/manifest.json") {
                        manifest_found = true;
                        break;
                    }
                }
            }
            if !manifest_found {
                log::warn!("No manifest.json found in ZIP for addon '{}'", addon_id);
            }
        }
        Err(e) => {
            log::error!("ZIP validation failed for addon '{}': {}", addon_id, e);
            return Err(format!("Invalid ZIP data for staging: {}", e));
        }
    }

    fs::write(&staged_file_path, zip_data)
        .map_err(|e| format!("Failed to write staged addon file: {}", e))?;

    log::info!(
        "Addon '{}' staged at: {:?} ({} bytes)",
        addon_id,
        staged_file_path,
        zip_data.len()
    );

    Ok(staged_file_path)
}

/// Load addon from staging directory
pub fn load_addon_from_staging(
    addon_id: &str,
    base_dir: impl AsRef<Path>,
) -> Result<Vec<u8>, String> {
    validate_addon_id(addon_id)?;
    let staging_dir = get_staging_directory(base_dir)?;
    let staged_file_path = staging_dir.join(format!("{}.zip", addon_id));

    if !staged_file_path.exists() {
        return Err(format!(
            "Staged addon file not found for addon: {}",
            addon_id
        ));
    }

    let zip_data = fs::read(&staged_file_path)
        .map_err(|e| format!("Failed to read staged addon file: {}", e))?;

    log::info!(
        "Loaded addon '{}' from staging ({} bytes)",
        addon_id,
        zip_data.len()
    );

    Ok(zip_data)
}

/// Remove specific addon from staging
pub fn remove_addon_from_staging(addon_id: &str, base_dir: impl AsRef<Path>) -> Result<(), String> {
    validate_addon_id(addon_id)?;
    let staging_dir = get_staging_directory(base_dir)?;
    let staged_file_path = staging_dir.join(format!("{}.zip", addon_id));

    if staged_file_path.exists() {
        fs::remove_file(&staged_file_path)
            .map_err(|e| format!("Failed to remove staged addon file: {}", e))?;
        log::info!("Removed addon '{}' from staging", addon_id);
    }

    Ok(())
}

/// Fetch available addons from the store API
pub async fn fetch_addon_store_listings() -> Result<Vec<serde_json::Value>, String> {
    // Fetch all addons and let frontend filter by status
    let api_url = ADDON_STORE_API_BASE_URL.to_string();

    let client = reqwest::Client::new();
    let response = create_request_with_headers(&client, reqwest::Method::GET, &api_url)
        .send()
        .await
        .map_err(|e| {
            log::error!("Failed to fetch addon store listings: {}", e);
            format!("Failed to fetch addon store listings: {}", e)
        })?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        log::error!("Store API returned error {}: {}", status, error_text);
        return Err(format!(
            "Store API returned error {}: {}",
            status, error_text
        ));
    }

    // Get the response text first for custom parsing
    let response_text = response.text().await.map_err(|e| {
        log::error!("Failed to read store API response: {}", e);
        format!("Failed to read store API response: {}", e)
    })?;

    // Parse the response as an object first to handle the {"addons": [...]} structure
    let response_json: serde_json::Value = serde_json::from_str(&response_text).map_err(|e| {
        log::error!("Failed to parse store API response as JSON: {}", e);
        format!("Failed to parse store API response: {}", e)
    })?;

    // Extract the addons array from the response object
    let store_listings = if let Some(addons) = response_json.get("addons") {
        if let Some(addons_array) = addons.as_array() {
            addons_array.clone()
        } else {
            log::error!("'addons' field is not an array in API response");
            return Err("'addons' field is not an array in API response".to_string());
        }
    } else {
        // Fallback: try to parse as direct array for backward compatibility
        if let Some(direct_array) = response_json.as_array() {
            direct_array.clone()
        } else {
            log::error!("API response is neither {{\"addons\": [...]}} nor a direct array");
            log::error!(
                "Response structure: {}",
                serde_json::to_string_pretty(&response_json).unwrap_or_default()
            );
            return Err("Invalid API response structure".to_string());
        }
    };

    Ok(store_listings)
}

/// Submit or update a rating for an addon
pub async fn submit_addon_rating(
    addon_id: &str,
    rating: u8,
    review: Option<String>,
    rating_instance_id: &str,
) -> Result<serde_json::Value, String> {
    validate_addon_id(addon_id)?;
    if !(1..=5).contains(&rating) {
        return Err("Rating must be between 1 and 5".to_string());
    }

    let api_url = format!("{}/{}/ratings", ADDON_STORE_API_BASE_URL, addon_id);

    let mut request_body = serde_json::json!({
        "rating": rating
    });

    if let Some(review_text) = review {
        request_body["review"] = serde_json::Value::String(review_text);
    }

    let client = reqwest::Client::new();
    let response = create_request_with_headers(&client, reqwest::Method::POST, &api_url)
        .header("X-Instance-Id", rating_instance_id)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| {
            log::error!("Failed to submit rating for addon {}: {}", addon_id, e);
            format!("Failed to submit rating: {}", e)
        })?;

    let status = response.status();
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        log::error!(
            "Rating submission API returned error {} for addon {}: {}",
            status,
            addon_id,
            error_text
        );
        return Err(format!("Failed to submit rating: HTTP {}", status));
    }

    let response_text = response.text().await.map_err(|e| {
        log::error!("Failed to read rating submission API response: {}", e);
        format!("Failed to read rating submission API response: {}", e)
    })?;

    let response_json: serde_json::Value = serde_json::from_str(&response_text).map_err(|e| {
        log::error!(
            "Failed to parse rating submission API response as JSON: {}",
            e
        );
        format!("Failed to parse rating submission API response: {}", e)
    })?;

    Ok(response_json)
}

// ============================================================================
// AddonService Implementation
// ============================================================================

/// Service for addon management operations.
pub struct AddonService {
    addons_root: PathBuf,
    rating_instance_id: String,
    storage_repo: Arc<dyn AddonStorageRepositoryTrait>,
}

impl AddonService {
    pub fn new(
        addons_root: impl Into<PathBuf>,
        rating_instance_id: impl Into<String>,
        storage_repo: Arc<dyn AddonStorageRepositoryTrait>,
    ) -> Self {
        Self {
            addons_root: addons_root.into(),
            rating_instance_id: rating_instance_id.into(),
            storage_repo,
        }
    }

    fn validate_storage_key(key: &str) -> Result<(), String> {
        if key.is_empty() {
            return Err("Invalid storage key: key is empty".to_string());
        }
        if key.len() > MAX_ADDON_STORAGE_KEY_LEN {
            return Err(format!(
                "Invalid storage key: key must be {} characters or fewer",
                MAX_ADDON_STORAGE_KEY_LEN
            ));
        }
        // The key is embedded verbatim in the device-sync entity id, which must
        // match the sync server's allowed charset (letters, digits, and
        // `_ . : -`). Rejecting anything outside it here guarantees a stored key
        // can never produce an event the server refuses (which would otherwise
        // fail the whole push batch).
        if !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '-'))
        {
            return Err(
                "Invalid storage key: only letters, digits, and the characters _ . : - are allowed"
                    .to_string(),
            );
        }
        Ok(())
    }

    fn read_manifest_if_exists(&self, addon_dir: &Path) -> Result<Option<AddonManifest>, String> {
        let manifest_path = addon_dir.join("manifest.json");
        if !manifest_path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(&manifest_path)
            .map_err(|e| format!("Failed to read manifest {}: {}", manifest_path.display(), e))?;
        let manifest = parse_installed_manifest_json_metadata(&content).map_err(|e| {
            format!(
                "Failed to parse manifest {}: {}",
                manifest_path.display(),
                e
            )
        })?;
        Ok(Some(manifest))
    }

    fn read_manifest_or_error(&self, addon_dir: &Path) -> Result<AddonManifest, String> {
        self.read_manifest_if_exists(addon_dir)?
            .ok_or_else(|| format!("Addon manifest not found in {}", addon_dir.display()))
    }

    fn find_installed_addon_dir_by_manifest_id(&self, addon_id: &str) -> Result<PathBuf, String> {
        let addons_dir = ensure_addons_directory(&self.addons_root)?;
        for entry in fs::read_dir(&addons_dir)
            .map_err(|e| format!("Failed to read addons directory: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let dir = entry.path();
            if !dir.is_dir() || Self::is_hidden_addon_dir(&dir) {
                continue;
            }
            let manifest = match self.read_manifest_if_exists(&dir) {
                Ok(Some(manifest)) => manifest,
                Ok(None) => continue,
                Err(err) => {
                    log::warn!("Skipping invalid addon manifest in {:?}: {}", dir, err);
                    continue;
                }
            };
            if manifest.id == addon_id {
                return Ok(dir);
            }
        }

        Err("Addon not found".to_string())
    }

    fn existing_addon_dir(&self, addon_id: &str) -> Result<PathBuf, String> {
        if validate_addon_id(addon_id).is_ok() {
            self.recover_incomplete_replacement_for_addon(addon_id)?;
            let addon_dir = get_addon_path(&self.addons_root, addon_id)?;
            if addon_dir.exists() {
                return Ok(addon_dir);
            }
        }

        self.find_installed_addon_dir_by_manifest_id(addon_id)
    }

    fn write_addon_archive_files(
        &self,
        addon_dir: &Path,
        files: &[AddonArchiveFile],
    ) -> Result<(), String> {
        for file in files {
            let relative_path = validated_addon_archive_path(&file.name)?;
            let file_path = addon_dir.join(relative_path);
            if let Some(parent) = file_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create directory: {}", e))?;
            }
            fs::write(&file_path, &file.content)
                .map_err(|e| format!("Failed to write file {}: {}", file.name, e))?;
        }
        Ok(())
    }

    fn write_manifest(&self, addon_dir: &Path, manifest: &AddonManifest) -> Result<(), String> {
        let manifest_path = addon_dir.join("manifest.json");
        let manifest_json = serde_json::to_string_pretty(manifest)
            .map_err(|e| format!("Failed to serialize manifest: {}", e))?;
        fs::write(&manifest_path, manifest_json)
            .map_err(|e| format!("Failed to write manifest: {}", e))?;
        Ok(())
    }

    fn hidden_artifact_dirs(&self, addon_id: &str, kind: &str) -> Result<Vec<PathBuf>, String> {
        validate_addon_id(addon_id)?;
        let addons_dir = ensure_addons_directory(&self.addons_root)?;
        let prefix = format!(".{addon_id}.{kind}-");
        let mut dirs = Vec::new();

        for entry in fs::read_dir(&addons_dir)
            .map_err(|e| format!("Failed to read addons directory: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if name.starts_with(&prefix) {
                dirs.push(path);
            }
        }

        dirs.sort();
        Ok(dirs)
    }

    fn cleanup_replacement_artifacts(&self, addon_id: &str) {
        for kind in ["tmp", "backup"] {
            let Ok(dirs) = self.hidden_artifact_dirs(addon_id, kind) else {
                continue;
            };
            for dir in dirs {
                if let Err(error) = fs::remove_dir_all(&dir) {
                    log::warn!("Failed to remove stale addon artifact {:?}: {}", dir, error);
                }
            }
        }
    }

    fn addon_id_from_backup_dir_name(name: &str) -> Option<&str> {
        let without_dot = name.strip_prefix('.')?;
        let (addon_id, _) = without_dot.rsplit_once(".backup-")?;
        validate_addon_id(addon_id).ok()?;
        Some(addon_id)
    }

    fn is_hidden_addon_dir(dir: &Path) -> bool {
        dir.file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with('.'))
    }

    fn recover_incomplete_replacement_for_addon(&self, addon_id: &str) -> Result<(), String> {
        let addon_dir = get_addon_path(&self.addons_root, addon_id)?;
        if addon_dir.exists() {
            self.cleanup_replacement_artifacts(addon_id);
            return Ok(());
        }

        let backup_dirs = self.hidden_artifact_dirs(addon_id, "backup")?;
        for backup_dir in backup_dirs.into_iter().rev() {
            let manifest = match self.read_manifest_if_exists(&backup_dir) {
                Ok(Some(manifest)) => manifest,
                Ok(None) => continue,
                Err(error) => {
                    log::warn!(
                        "Skipping invalid addon backup manifest in {:?}: {}",
                        backup_dir,
                        error
                    );
                    continue;
                }
            };
            if manifest.id != addon_id {
                log::warn!(
                    "Skipping addon backup {:?}: manifest id '{}' does not match '{}'",
                    backup_dir,
                    manifest.id,
                    addon_id
                );
                continue;
            }

            fs::rename(&backup_dir, &addon_dir)
                .map_err(|e| format!("Failed to restore addon backup '{}': {}", addon_id, e))?;
            self.cleanup_replacement_artifacts(addon_id);
            return Ok(());
        }

        Ok(())
    }

    fn recover_incomplete_replacements(&self) -> Result<(), String> {
        let addons_dir = ensure_addons_directory(&self.addons_root)?;
        let mut addon_ids = Vec::new();

        for entry in fs::read_dir(&addons_dir)
            .map_err(|e| format!("Failed to read addons directory: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if let Some(addon_id) = Self::addon_id_from_backup_dir_name(name) {
                addon_ids.push(addon_id.to_string());
            }
        }

        addon_ids.sort();
        addon_ids.dedup();
        for addon_id in addon_ids {
            self.recover_incomplete_replacement_for_addon(&addon_id)?;
        }

        Ok(())
    }

    fn replace_addon_directory(
        &self,
        addon_id: &str,
        files: &[AddonArchiveFile],
        metadata: &AddonManifest,
    ) -> Result<(), String> {
        let addon_dir = get_addon_path(&self.addons_root, addon_id)?;
        let addons_dir = ensure_addons_directory(&self.addons_root)?;
        let nonce = uuid::Uuid::new_v4();
        let temp_dir = addons_dir.join(format!(".{addon_id}.tmp-{nonce}"));
        let backup_dir = addons_dir.join(format!(".{addon_id}.backup-{nonce}"));

        if temp_dir.exists() {
            fs::remove_dir_all(&temp_dir)
                .map_err(|e| format!("Failed to clear temporary addon directory: {}", e))?;
        }
        fs::create_dir_all(&temp_dir)
            .map_err(|e| format!("Failed to create temporary addon directory: {}", e))?;

        let write_result = (|| -> Result<(), String> {
            self.write_addon_archive_files(&temp_dir, files)?;
            self.write_manifest(&temp_dir, metadata)?;
            Ok(())
        })();

        if let Err(err) = write_result {
            let _ = fs::remove_dir_all(&temp_dir);
            return Err(err);
        }

        let had_existing_addon = addon_dir.exists();
        if had_existing_addon {
            fs::rename(&addon_dir, &backup_dir)
                .map_err(|e| format!("Failed to move existing addon aside: {}", e))?;
        }

        match fs::rename(&temp_dir, &addon_dir) {
            Ok(()) => {
                if had_existing_addon {
                    let _ = fs::remove_dir_all(&backup_dir);
                }
                Ok(())
            }
            Err(err) => {
                let _ = fs::remove_dir_all(&temp_dir);
                if had_existing_addon && backup_dir.exists() {
                    let _ = fs::rename(&backup_dir, &addon_dir);
                }
                Err(format!("Failed to install addon directory: {}", err))
            }
        }
    }

    fn enabled_manifest_for_addon(&self, addon_id: &str) -> Result<AddonManifest, String> {
        let addon_dir = self.existing_addon_dir(addon_id)?;
        let manifest = self.read_manifest_or_error(&addon_dir)?;
        if !manifest.is_enabled() {
            return Err("Addon is disabled".to_string());
        }
        Ok(manifest)
    }

    fn manifest_allows_function(
        manifest: &AddonManifest,
        category: &str,
        function_name: &str,
    ) -> bool {
        manifest
            .permissions
            .as_ref()
            .map(|permissions| {
                permissions.iter().any(|permission| {
                    permission.category == category
                        && permission
                            .functions
                            .iter()
                            .any(|function| function.name == function_name && function.is_declared)
                })
            })
            .unwrap_or(false)
    }

    fn manifest_permission_keys(manifest: &AddonManifest) -> BTreeSet<String> {
        manifest
            .permissions
            .as_ref()
            .map(|permissions| {
                permissions
                    .iter()
                    .filter(|permission| {
                        !BASELINE_PERMISSION_CATEGORIES.contains(&permission.category.as_str())
                    })
                    .flat_map(|permission| {
                        permission
                            .functions
                            .iter()
                            .filter(|function| function.is_declared || function.is_detected)
                            .map(|function| format!("{}.{}", permission.category, function.name))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn ensure_update_does_not_add_permissions(
        previous: Option<&AddonManifest>,
        next: &AddonManifest,
    ) -> Result<(), String> {
        let Some(previous) = previous else {
            return Ok(());
        };

        let previous_permissions = Self::manifest_permission_keys(previous);
        let next_permissions = Self::manifest_permission_keys(next);
        let added_permissions = next_permissions
            .difference(&previous_permissions)
            .cloned()
            .collect::<Vec<_>>();

        if added_permissions.is_empty() {
            return Ok(());
        }

        let preview = added_permissions
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>()
            .join(", ");
        let suffix = if added_permissions.len() > 8 {
            format!(" and {} more", added_permissions.len() - 8)
        } else {
            String::new()
        };

        Err(format!(
            "Addon update adds new permissions and requires reinstall approval: {}{}",
            preview, suffix
        ))
    }

    fn write_network_audit_entry(
        &self,
        addon_id: &str,
        request: &AddonNetworkRequest,
        result: &Result<AddonNetworkResponse, String>,
    ) -> Result<(), String> {
        let audit_path = ensure_addons_directory(&self.addons_root)?.join("network-audit.jsonl");
        let parsed_url = url::Url::parse(&request.url).ok();
        let method = request
            .method
            .as_deref()
            .unwrap_or("GET")
            .to_ascii_uppercase();
        let entry = match result {
            Ok(response) => json!({
                "timestamp": chrono::Utc::now().to_rfc3339(),
                "addonId": addon_id,
                "method": method,
                "scheme": parsed_url.as_ref().map(|url| url.scheme()),
                "host": parsed_url.as_ref().and_then(|url| url.host_str()),
                "port": parsed_url.as_ref().and_then(|url| url.port_or_known_default()),
                "allowed": true,
                "status": response.status,
                "responseBytes": response.body.len(),
            }),
            Err(error) => json!({
                "timestamp": chrono::Utc::now().to_rfc3339(),
                "addonId": addon_id,
                "method": method,
                "scheme": parsed_url.as_ref().map(|url| url.scheme()),
                "host": parsed_url.as_ref().and_then(|url| url.host_str()),
                "port": parsed_url.as_ref().and_then(|url| url.port_or_known_default()),
                "allowed": false,
                "errorCode": Self::classify_network_error(error),
            }),
        };

        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&audit_path)
            .map_err(|e| format!("Failed to open addon network audit log: {}", e))?;
        serde_json::to_writer(&mut file, &entry)
            .map_err(|e| format!("Failed to serialize addon network audit entry: {}", e))?;
        writeln!(file).map_err(|e| format!("Failed to write addon network audit entry: {}", e))?;
        Ok(())
    }

    fn audit_network_request(
        &self,
        addon_id: &str,
        request: &AddonNetworkRequest,
        result: &Result<AddonNetworkResponse, String>,
    ) {
        if let Err(error) = self.write_network_audit_entry(addon_id, request, result) {
            log::warn!("Failed to write addon network audit entry: {}", error);
        }
    }

    fn classify_network_error(error: &str) -> &'static str {
        if error.contains("disabled") {
            "addon_disabled"
        } else if error.contains("Invalid addon id") {
            "invalid_addon_id"
        } else if error.contains("not approved") || error.contains("not declared") {
            "host_not_approved"
        } else if error.contains("not allowed to use network auth") {
            "network_auth_permission_denied"
        } else if error.contains("must use HTTPS") {
            "https_required"
        } else if error.contains("credentials") {
            "url_credentials"
        } else if error.contains("method") {
            "method_not_allowed"
        } else if error.contains("not allowed") {
            "blocked_host"
        } else if error.contains("could not be resolved") {
            "dns_resolution_failed"
        } else if error.contains("private address") {
            "private_address_resolution"
        } else if error.contains("too large") {
            "size_limit_exceeded"
        } else {
            "request_failed"
        }
    }

    fn apply_network_approvals(
        mut manifest: AddonManifest,
        approved_network_hosts: &[String],
    ) -> AddonManifest {
        if let Some(network) = manifest.network.as_mut() {
            let requested = network.allowed_hosts.clone();
            network.approved_hosts = approved_network_hosts
                .iter()
                .map(|host| host.trim().trim_end_matches('.').to_ascii_lowercase())
                .filter(|host| requested.contains(host))
                .collect();
            network.approved_hosts.sort();
            network.approved_hosts.dedup();
        }
        manifest
    }

    fn preserve_existing_network_approvals(
        mut manifest: AddonManifest,
        previous: Option<&AddonManifest>,
    ) -> AddonManifest {
        if let Some(network) = manifest.network.as_mut() {
            let allowed_hosts = network.allowed_hosts.clone();
            let previous_approved = previous
                .and_then(|m| m.network.as_ref())
                .map(|network| network.approved_hosts.as_slice())
                .unwrap_or(&[]);
            network.approved_hosts = previous_approved
                .iter()
                .filter(|host| allowed_hosts.contains(host))
                .cloned()
                .collect();
            network.approved_hosts.sort();
            network.approved_hosts.dedup();
        }
        manifest
    }
}

#[async_trait]
impl AddonServiceTrait for AddonService {
    async fn install_addon_zip(
        &self,
        zip_data: Vec<u8>,
        enable_after_install: bool,
        approved_network_hosts: Vec<String>,
    ) -> Result<AddonManifest, String> {
        let extracted = extract_addon_zip_archive(zip_data)?;
        enforce_min_wealthfolio_version(&extracted.metadata)?;
        let addon_id = extracted.metadata.id.clone();
        let metadata = Self::apply_network_approvals(
            extracted.metadata.to_installed(enable_after_install)?,
            &approved_network_hosts,
        );
        self.replace_addon_directory(&addon_id, &extracted.files, &metadata)?;

        Ok(metadata)
    }

    async fn install_addon_from_staging(
        &self,
        addon_id: &str,
        enable_after_install: bool,
        approved_network_hosts: Vec<String>,
    ) -> Result<AddonManifest, String> {
        let zip = load_addon_from_staging(addon_id, &self.addons_root)?;
        let extracted = match extract_addon_zip_archive(zip) {
            Ok(extracted) => extracted,
            Err(err) => {
                let _ = remove_addon_from_staging(addon_id, &self.addons_root);
                return Err(err);
            }
        };
        if extracted.metadata.id != addon_id {
            let _ = remove_addon_from_staging(addon_id, &self.addons_root);
            return Err(format!(
                "Staged addon id mismatch: requested '{}', manifest contains '{}'",
                addon_id, extracted.metadata.id
            ));
        }
        if let Err(err) = enforce_min_wealthfolio_version(&extracted.metadata) {
            let _ = remove_addon_from_staging(addon_id, &self.addons_root);
            return Err(err);
        }
        let installed_addon_id = extracted.metadata.id.clone();
        let metadata = Self::apply_network_approvals(
            extracted.metadata.to_installed(enable_after_install)?,
            &approved_network_hosts,
        );
        self.replace_addon_directory(&installed_addon_id, &extracted.files, &metadata)?;

        // Clean staging file
        let _ = remove_addon_from_staging(addon_id, &self.addons_root);

        Ok(metadata)
    }

    async fn uninstall_addon(&self, addon_id: &str) -> Result<(), String> {
        let addon_dir = self.existing_addon_dir(addon_id)?;
        if !addon_dir.exists() {
            return Err("Addon not found".to_string());
        }
        fs::remove_dir_all(&addon_dir).map_err(|e| format!("Failed to remove addon: {}", e))?;
        if let Err(error) = self.clear_addon_storage(addon_id).await {
            log::warn!("Failed to remove storage for addon '{addon_id}': {error}");
        }
        Ok(())
    }

    fn list_installed_addons(&self) -> Result<Vec<InstalledAddon>, String> {
        self.recover_incomplete_replacements()?;
        let addons_dir = ensure_addons_directory(&self.addons_root)?;
        let mut installed = Vec::new();

        if addons_dir.exists() {
            for entry in fs::read_dir(&addons_dir)
                .map_err(|e| format!("Failed to read addons directory: {}", e))?
            {
                let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                if Self::is_hidden_addon_dir(&dir) {
                    continue;
                }
                let manifest = match self.read_manifest_if_exists(&dir) {
                    Ok(Some(m)) => m,
                    Ok(None) => continue,
                    Err(err) => {
                        log::error!("Skipping invalid addon manifest in {:?}: {}", dir, err);
                        continue;
                    }
                };
                let files_count = fs::read_dir(&dir)
                    .map_err(|e| format!("Failed to count addon files: {}", e))?
                    .count();
                let is_zip_addon = files_count > 2;
                installed.push(InstalledAddon {
                    metadata: manifest,
                    file_path: dir.to_string_lossy().to_string(),
                    is_zip_addon,
                });
            }
        }
        Ok(installed)
    }

    fn load_addon_for_runtime(&self, addon_id: &str) -> Result<ExtractedAddon, String> {
        let addon_dir = self.existing_addon_dir(addon_id)?;
        let manifest = self.read_manifest_or_error(&addon_dir)?;

        if !manifest.is_enabled() {
            return Err("Addon is disabled".to_string());
        }

        let mut files = Vec::new();
        read_addon_files_recursive(&addon_dir, &addon_dir, &mut files)?;

        let main_file = manifest.get_main()?;
        for f in &mut files {
            f.is_main = archive_path_matches_manifest_main(&f.name, main_file);
        }

        if !files.iter().any(|f| f.is_main) {
            return Err("Main addon file not found".to_string());
        }

        let detected_permissions = detect_addon_permissions(&files);
        let mut metadata = manifest;
        metadata.permissions = Some(merge_detected_permissions(
            metadata.permissions.as_deref(),
            detected_permissions,
        ));

        Ok(ExtractedAddon { metadata, files })
    }

    fn get_enabled_addons_on_startup(&self) -> Result<Vec<ExtractedAddon>, String> {
        let installed = self.list_installed_addons()?;
        let mut enabled = Vec::new();

        for item in installed {
            if item.metadata.is_enabled() {
                if let Ok(extracted) = self.load_addon_for_runtime(&item.metadata.id) {
                    enabled.push(extracted);
                }
            }
        }
        Ok(enabled)
    }

    async fn check_addon_update(&self, addon_id: &str) -> Result<AddonUpdateCheckResult, String> {
        let addon_dir = self.existing_addon_dir(addon_id)?;
        let manifest = self.read_manifest_or_error(&addon_dir)?;
        check_addon_update_from_api(addon_id, &manifest.version).await
    }

    async fn check_all_addon_updates(&self) -> Result<Vec<AddonUpdateCheckResult>, String> {
        self.recover_incomplete_replacements()?;
        let addons_dir = ensure_addons_directory(&self.addons_root)?;
        let mut results = Vec::new();

        if addons_dir.exists() {
            for entry in fs::read_dir(&addons_dir)
                .map_err(|e| format!("Failed to read addons directory: {}", e))?
            {
                let entry = entry.map_err(|e| format!("Failed to read directory entry: {}", e))?;
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                if Self::is_hidden_addon_dir(&dir) {
                    continue;
                }
                let manifest = match self.read_manifest_if_exists(&dir) {
                    Ok(Some(m)) => m,
                    Ok(None) => continue,
                    Err(err) => {
                        log::error!("Skipping invalid addon manifest in {:?}: {}", dir, err);
                        continue;
                    }
                };
                let addon_id = manifest.id.clone();
                match check_addon_update_from_api(&addon_id, &manifest.version).await {
                    Ok(result) => results.push(result),
                    Err(err) => {
                        log::error!("Failed to check update for addon {}: {}", addon_id, err);
                        results.push(AddonUpdateCheckResult {
                            addon_id,
                            update_info: AddonUpdateInfo {
                                current_version: manifest.version,
                                latest_version: "unknown".to_string(),
                                update_available: false,
                                download_url: None,
                                sha256: None,
                                release_notes: None,
                                release_date: None,
                                changelog_url: None,
                                is_critical: None,
                                has_breaking_changes: None,
                                min_wealthfolio_version: None,
                            },
                            error: Some(err),
                        });
                    }
                }
            }
        }
        Ok(results)
    }

    async fn update_addon_from_store(&self, addon_id: &str) -> Result<AddonManifest, String> {
        let addon_dir = self.existing_addon_dir(addon_id)?;
        let previous_manifest = self.read_manifest_if_exists(&addon_dir)?;
        let was_enabled = previous_manifest
            .as_ref()
            .and_then(|m| m.enabled)
            .unwrap_or(false);

        let zip_data = download_addon_from_store(addon_id).await?;
        let extracted = extract_addon_zip_archive(zip_data)?;
        if extracted.metadata.id != addon_id {
            return Err(format!(
                "Downloaded addon id mismatch: requested '{}', manifest contains '{}'",
                addon_id, extracted.metadata.id
            ));
        }
        enforce_min_wealthfolio_version(&extracted.metadata)?;
        Self::ensure_update_does_not_add_permissions(
            previous_manifest.as_ref(),
            &extracted.metadata,
        )?;

        let metadata = Self::preserve_existing_network_approvals(
            extracted.metadata.to_installed(was_enabled)?,
            previous_manifest.as_ref(),
        );
        self.replace_addon_directory(addon_id, &extracted.files, &metadata)?;

        Ok(metadata)
    }

    async fn addon_network_request(
        &self,
        addon_id: &str,
        request: AddonNetworkRequest,
    ) -> Result<AddonNetworkResponse, String> {
        let result = match self.enabled_manifest_for_addon(addon_id) {
            Ok(manifest) => {
                if (request.auth.is_some() || request.injected_authorization.is_some())
                    && !Self::manifest_allows_function(&manifest, "secrets", "use")
                {
                    Err("Addon is not allowed to use network auth secrets".to_string())
                } else {
                    let approved_hosts = manifest
                        .network
                        .map(|network| network.approved_hosts)
                        .unwrap_or_default();
                    perform_addon_network_request(addon_id, &approved_hosts, request.clone()).await
                }
            }
            Err(error) => Err(error),
        };
        self.audit_network_request(addon_id, &request, &result);
        result
    }

    fn update_addon_network_approvals(
        &self,
        addon_id: &str,
        approved_network_hosts: Vec<String>,
    ) -> Result<AddonManifest, String> {
        let addon_dir = self.existing_addon_dir(addon_id)?;
        let manifest = self.read_manifest_or_error(&addon_dir)?;
        let manifest = Self::apply_network_approvals(manifest, &approved_network_hosts);
        self.write_manifest(&addon_dir, &manifest)?;
        Ok(manifest)
    }

    fn toggle_addon(&self, addon_id: &str, enabled: bool) -> Result<(), String> {
        let addon_dir = self.existing_addon_dir(addon_id)?;
        let mut manifest = self.read_manifest_or_error(&addon_dir)?;
        if enabled {
            enforce_min_wealthfolio_version(&manifest)?;
        }
        manifest.enabled = Some(enabled);
        self.write_manifest(&addon_dir, &manifest)?;
        Ok(())
    }

    async fn get_addon_storage_item(
        &self,
        addon_id: &str,
        key: &str,
    ) -> Result<Option<String>, String> {
        validate_addon_id(addon_id)?;
        Self::validate_storage_key(key)?;
        self.storage_repo.get(addon_id, key).await
    }

    async fn set_addon_storage_item(
        &self,
        addon_id: &str,
        key: &str,
        value: &str,
    ) -> Result<(), String> {
        validate_addon_id(addon_id)?;
        Self::validate_storage_key(key)?;
        // Bound the serialized sync payload, not the raw value: this is the exact
        // plaintext that gets encrypted and pushed, so it matches what the sync
        // server validates and JSON escaping can't inflate past the check.
        let payload_len = serde_json::to_string(&json!({
            "addon_id": addon_id,
            "key": key,
            "value": value,
        }))
        .map(|s| s.len())
        .unwrap_or(usize::MAX);
        if payload_len > MAX_ADDON_STORAGE_SYNC_PAYLOAD_LEN {
            return Err(format!(
                "Invalid storage value: too large to sync across devices (max ~{} KB)",
                MAX_ADDON_STORAGE_SYNC_PAYLOAD_LEN / 1024
            ));
        }
        self.storage_repo.set(addon_id, key, value).await
    }

    async fn delete_addon_storage_item(&self, addon_id: &str, key: &str) -> Result<(), String> {
        validate_addon_id(addon_id)?;
        Self::validate_storage_key(key)?;
        self.storage_repo.delete(addon_id, key).await
    }

    async fn clear_addon_storage(&self, addon_id: &str) -> Result<(), String> {
        validate_addon_id(addon_id)?;
        self.storage_repo.delete_all(addon_id).await
    }

    async fn download_addon_to_staging(&self, addon_id: &str) -> Result<ExtractedAddon, String> {
        let zip = download_addon_from_store(addon_id).await?;
        let _staged_path = save_addon_to_staging(addon_id, &self.addons_root, &zip)?;
        let extracted = extract_addon_zip_internal(zip)?;
        if extracted.metadata.id != addon_id {
            let _ = remove_addon_from_staging(addon_id, &self.addons_root);
            return Err(format!(
                "Downloaded addon id mismatch: requested '{}', manifest contains '{}'",
                addon_id, extracted.metadata.id
            ));
        }
        Ok(extracted)
    }

    fn clear_staging(&self, addon_id: Option<&str>) -> Result<(), String> {
        if let Some(id) = addon_id {
            remove_addon_from_staging(id, &self.addons_root)?;
        } else {
            clear_staging_directory(&self.addons_root)?;
        }
        Ok(())
    }

    async fn fetch_store_listings(&self) -> Result<Vec<serde_json::Value>, String> {
        fetch_addon_store_listings().await
    }

    async fn submit_rating(
        &self,
        addon_id: &str,
        rating: u8,
        review: Option<String>,
    ) -> Result<serde_json::Value, String> {
        submit_addon_rating(addon_id, rating, review, &self.rating_instance_id).await
    }

    fn extract_addon_zip(&self, zip_data: Vec<u8>) -> Result<ExtractedAddon, String> {
        extract_addon_zip_internal(zip_data)
    }
}
