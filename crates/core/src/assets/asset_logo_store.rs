//! Local storage for user-uploaded per-asset logo overrides.
//!
//! Bytes are validated by file-signature (not by trusting the caller's
//! declared extension or MIME type) before ever touching disk, and the
//! on-disk filename is always derived from the asset id, never from
//! caller-supplied input, so this cannot be used for path traversal.

use std::path::PathBuf;
use std::sync::Arc;

use super::assets_traits::AssetServiceTrait;
use crate::errors::{Error, Result, ValidationError};

/// Hard cap on uploaded logo size. Generous for a small square icon, small
/// enough to make disk-fill abuse impractical.
const MAX_LOGO_BYTES: usize = 2 * 1024 * 1024;

/// Supported image formats, matched by file-signature ("magic bytes"), not
/// by trusting the extension or `Content-Type` the caller sent.
const SIGNATURES: &[(&str, &str, &[u8])] = &[
    ("png", "image/png", &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    ("jpg", "image/jpeg", &[0xFF, 0xD8, 0xFF]),
    ("webp", "image/webp", b"RIFF"), // followed by size (4 bytes) then "WEBP"; checked below
];

fn detect_image_type(bytes: &[u8]) -> Result<(&'static str, &'static str)> {
    if bytes.len() > MAX_LOGO_BYTES {
        return Err(Error::Validation(ValidationError::InvalidInput(
            "Image exceeds the 2MB size limit".to_string(),
        )));
    }

    for (ext, content_type, magic) in SIGNATURES {
        if *ext == "webp" {
            if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
                return Ok((ext, content_type));
            }
            continue;
        }
        if bytes.starts_with(magic) {
            return Ok((ext, content_type));
        }
    }

    Err(Error::Validation(ValidationError::InvalidInput(
        "Unsupported or unrecognized image format; only PNG, JPEG, and WEBP are allowed"
            .to_string(),
    )))
}

/// An asset id must already be a validated identifier (UUID) coming from the
/// database, but we never trust that assumption when building filesystem
/// paths — reject anything that isn't a plain alphanumeric/dash token.
fn sanitize_asset_id(asset_id: &str) -> Result<()> {
    let valid = !asset_id.is_empty()
        && asset_id.len() <= 128
        && asset_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '$');
    if valid {
        Ok(())
    } else {
        Err(Error::Validation(ValidationError::InvalidInput(
            "Invalid asset id".to_string(),
        )))
    }
}

pub struct AssetLogoStore {
    base_dir: PathBuf,
}

impl AssetLogoStore {
    pub fn new(base_dir: impl Into<PathBuf>) -> Self {
        Self {
            base_dir: base_dir.into(),
        }
    }

    fn path_for(&self, filename: &str) -> PathBuf {
        self.base_dir.join(filename)
    }

    /// Validates, stores, and records a new logo override for `asset_id`,
    /// replacing any previous override.
    pub async fn store(
        &self,
        service: &Arc<dyn AssetServiceTrait>,
        asset_id: &str,
        bytes: &[u8],
    ) -> Result<()> {
        sanitize_asset_id(asset_id)?;
        let (ext, _content_type) = detect_image_type(bytes)?;

        // Verify the asset exists before writing anything to disk.
        let existing = service.get_asset_by_id(asset_id)?;

        std::fs::create_dir_all(&self.base_dir)
            .map_err(|e| Error::Asset(format!("Failed to create logo directory: {e}")))?;

        // Clean up a prior override that may have used a different extension.
        if let Some(old) = existing.custom_logo_filename.as_deref() {
            let _ = std::fs::remove_file(self.path_for(old));
        }

        let filename = format!("{asset_id}.{ext}");
        let path = self.path_for(&filename);
        std::fs::write(&path, bytes)
            .map_err(|e| Error::Asset(format!("Failed to write logo file: {e}")))?;

        if let Err(e) = service
            .update_custom_logo_filename(asset_id, Some(&filename))
            .await
        {
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }

        Ok(())
    }

    /// Reads the stored override bytes for `asset_id`, if one exists.
    pub fn read(
        &self,
        service: &Arc<dyn AssetServiceTrait>,
        asset_id: &str,
    ) -> Result<Option<(Vec<u8>, &'static str)>> {
        sanitize_asset_id(asset_id)?;
        let asset = service.get_asset_by_id(asset_id)?;
        let Some(filename) = asset.custom_logo_filename else {
            return Ok(None);
        };

        // Defense in depth: the filename must be exactly what `store` would
        // have produced for this asset id, never a value that could escape
        // `base_dir` even if the DB row were somehow corrupted.
        let Some(ext) = filename.strip_prefix(&format!("{asset_id}.")) else {
            return Ok(None);
        };
        let content_type = match ext {
            "png" => "image/png",
            "jpg" => "image/jpeg",
            "webp" => "image/webp",
            _ => return Ok(None),
        };

        let path = self.path_for(&filename);
        match std::fs::read(&path) {
            Ok(bytes) => Ok(Some((bytes, content_type))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Error::Asset(format!("Failed to read logo file: {e}"))),
        }
    }

    /// Removes any stored logo override for `asset_id`, restoring the
    /// default logo resolution.
    pub async fn remove(
        &self,
        service: &Arc<dyn AssetServiceTrait>,
        asset_id: &str,
    ) -> Result<()> {
        sanitize_asset_id(asset_id)?;
        let asset = service.get_asset_by_id(asset_id)?;
        if let Some(filename) = asset.custom_logo_filename.as_deref() {
            let _ = std::fs::remove_file(self.path_for(filename));
        }
        service.update_custom_logo_filename(asset_id, None).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::assets::assets_model::{Asset, AssetKind, NewAsset, QuoteMode, UpdateAssetProfile};
    use crate::errors::{DatabaseError, Error};
    use std::collections::HashMap;
    use std::sync::Mutex;

    const PNG_MAGIC: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];

    struct FakeAssetService {
        assets: Mutex<HashMap<String, Asset>>,
    }

    impl FakeAssetService {
        fn with_asset(id: &str) -> Self {
            let mut assets = HashMap::new();
            assets.insert(
                id.to_string(),
                Asset {
                    id: id.to_string(),
                    kind: AssetKind::Investment,
                    quote_mode: QuoteMode::Market,
                    quote_ccy: "USD".to_string(),
                    ..Default::default()
                },
            );
            Self {
                assets: Mutex::new(assets),
            }
        }
    }

    #[async_trait::async_trait]
    impl AssetServiceTrait for FakeAssetService {
        fn get_assets(&self) -> Result<Vec<Asset>> {
            Ok(self.assets.lock().unwrap().values().cloned().collect())
        }

        fn get_asset_by_id(&self, asset_id: &str) -> Result<Asset> {
            self.assets
                .lock()
                .unwrap()
                .get(asset_id)
                .cloned()
                .ok_or_else(|| Error::Database(DatabaseError::NotFound("not found".to_string())))
        }

        async fn delete_asset(&self, _asset_id: &str) -> Result<()> {
            unimplemented!()
        }

        async fn update_asset_profile(
            &self,
            _asset_id: &str,
            _payload: UpdateAssetProfile,
        ) -> Result<Asset> {
            unimplemented!()
        }

        async fn create_asset(&self, _new_asset: NewAsset) -> Result<Asset> {
            unimplemented!()
        }

        async fn get_or_create_minimal_asset(
            &self,
            _asset_id: &str,
            _context_currency: Option<String>,
            _metadata: Option<crate::assets::assets_model::AssetMetadata>,
            _quote_mode: Option<String>,
        ) -> Result<Asset> {
            unimplemented!()
        }

        async fn update_quote_mode(&self, _asset_id: &str, _quote_mode: &str) -> Result<Asset> {
            unimplemented!()
        }

        async fn update_custom_logo_filename(
            &self,
            asset_id: &str,
            filename: Option<&str>,
        ) -> Result<Asset> {
            let mut assets = self.assets.lock().unwrap();
            let asset = assets
                .get_mut(asset_id)
                .ok_or_else(|| Error::Database(DatabaseError::NotFound("not found".to_string())))?;
            asset.custom_logo_filename = filename.map(|f| f.to_string());
            Ok(asset.clone())
        }

        async fn get_assets_by_asset_ids(&self, _asset_ids: &[String]) -> Result<Vec<Asset>> {
            unimplemented!()
        }

        async fn enrich_asset_profile(&self, _asset_id: &str) -> Result<Asset> {
            unimplemented!()
        }

        async fn enrich_assets(&self, _asset_ids: Vec<String>) -> Result<(usize, usize, usize)> {
            unimplemented!()
        }

        async fn cleanup_legacy_metadata(&self, _asset_id: &str) -> Result<()> {
            unimplemented!()
        }

        async fn merge_unknown_asset(
            &self,
            _resolved_asset_id: &str,
            _unknown_asset_id: &str,
            _activity_repository: &dyn crate::activities::ActivityRepositoryTrait,
        ) -> Result<u32> {
            unimplemented!()
        }

        async fn ensure_assets(
            &self,
            _specs: Vec<crate::assets::assets_model::AssetSpec>,
            _activity_repository: &dyn crate::activities::ActivityRepositoryTrait,
        ) -> Result<crate::assets::assets_model::EnsureAssetsResult> {
            unimplemented!()
        }

        async fn resolve_import_asset_inputs(
            &self,
            _inputs: Vec<crate::assets::AssetResolutionInput>,
        ) -> Result<Vec<crate::assets::AssetResolutionOutput>> {
            unimplemented!()
        }
    }

    fn service_with_asset(id: &str) -> Arc<dyn AssetServiceTrait> {
        Arc::new(FakeAssetService::with_asset(id))
    }

    #[tokio::test]
    async fn store_rejects_oversized_upload() {
        let dir = tempfile::tempdir().unwrap();
        let store = AssetLogoStore::new(dir.path());
        let service = service_with_asset("asset-1");

        let mut bytes = PNG_MAGIC.to_vec();
        bytes.extend(vec![0u8; MAX_LOGO_BYTES + 1]);

        let err = store.store(&service, "asset-1", &bytes).await.unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
    }

    #[tokio::test]
    async fn store_rejects_content_that_is_not_a_recognized_image() {
        let dir = tempfile::tempdir().unwrap();
        let store = AssetLogoStore::new(dir.path());
        let service = service_with_asset("asset-1");

        let err = store
            .store(&service, "asset-1", b"not-an-image, just text")
            .await
            .unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
    }

    #[tokio::test]
    async fn store_rejects_extension_spoofing_via_content_sniffing() {
        // A file merely named "logo.png" but containing non-image bytes must
        // still be rejected: detection is by magic bytes, never by trusting
        // a caller-supplied name or content-type.
        let dir = tempfile::tempdir().unwrap();
        let store = AssetLogoStore::new(dir.path());
        let service = service_with_asset("asset-1");

        let fake_png = b"<script>alert(1)</script>".to_vec();
        let err = store.store(&service, "asset-1", &fake_png).await.unwrap_err();
        assert!(matches!(err, Error::Validation(_)));
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
    }

    #[tokio::test]
    async fn store_rejects_path_traversal_asset_ids() {
        let dir = tempfile::tempdir().unwrap();
        let store = AssetLogoStore::new(dir.path());
        let service = service_with_asset("asset-1");

        for malicious_id in ["../../etc/passwd", "..\\windows\\system32", "a/b", "a\0b", ""] {
            let err = store
                .store(&service, malicious_id, PNG_MAGIC)
                .await
                .unwrap_err();
            assert!(
                matches!(err, Error::Validation(_)),
                "expected rejection for id {malicious_id:?}, got {err:?}"
            );
        }
        // Nothing was ever written to disk, even transiently.
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
    }

    #[tokio::test]
    async fn store_rejects_unknown_asset_without_writing_to_disk() {
        let dir = tempfile::tempdir().unwrap();
        let store = AssetLogoStore::new(dir.path());
        let service = service_with_asset("asset-1");

        let err = store
            .store(&service, "does-not-exist", PNG_MAGIC)
            .await
            .unwrap_err();
        assert!(matches!(err, Error::Database(_)));
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
    }

    #[tokio::test]
    async fn store_then_read_then_remove_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = AssetLogoStore::new(dir.path());
        let service = service_with_asset("asset-1");

        store.store(&service, "asset-1", PNG_MAGIC).await.unwrap();

        let (bytes, content_type) = store.read(&service, "asset-1").unwrap().unwrap();
        assert_eq!(bytes, PNG_MAGIC);
        assert_eq!(content_type, "image/png");

        let on_disk = std::fs::read_dir(dir.path()).unwrap().count();
        assert_eq!(on_disk, 1);

        store.remove(&service, "asset-1").await.unwrap();
        assert!(store.read(&service, "asset-1").unwrap().is_none());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn store_replacing_an_existing_logo_removes_the_old_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = AssetLogoStore::new(dir.path());
        let service = service_with_asset("asset-1");

        store.store(&service, "asset-1", PNG_MAGIC).await.unwrap();
        // JPEG magic bytes: different extension than the first upload.
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0];
        store.store(&service, "asset-1", &jpeg).await.unwrap();

        // Only the newest file should remain (the .png from the first
        // upload must have been cleaned up).
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
        let (bytes, content_type) = store.read(&service, "asset-1").unwrap().unwrap();
        assert_eq!(bytes, jpeg);
        assert_eq!(content_type, "image/jpeg");
    }

    #[tokio::test]
    async fn read_defends_against_a_corrupted_filename_escaping_base_dir() {
        let dir = tempfile::tempdir().unwrap();
        let store = AssetLogoStore::new(dir.path());
        let service = service_with_asset("asset-1");

        // Simulate a corrupted DB row pointing outside the expected
        // "{asset_id}.{ext}" shape.
        service
            .update_custom_logo_filename("asset-1", Some("../../../etc/passwd"))
            .await
            .unwrap();

        assert!(store.read(&service, "asset-1").unwrap().is_none());
    }
}
