//! Attachment validation, caching, and marker helpers.
//!
//! Owns:
//! - `SessionAttachmentCache` — per-thread LRU cache of attachments resolved
//!   for the current process session. Lets the chat agent re-inspect the same
//!   CSV/image across turns without re-uploading.
//! - Attachment validators against `AttachmentLimits` (count + per-attachment
//!   size + total size).
//! - The `📎 ` marker convention used in user-message text to indicate
//!   attached-file lines.

use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

use crate::error::AiError;
use crate::tools::constants::{
    MAX_ATTACHMENTS_COUNT, MAX_ATTACHMENT_SIZE_BYTES, MAX_TOTAL_ATTACHMENTS_BYTES,
};
use crate::types::{ChatMessage, ChatMessageRole, MessageAttachment};

pub(super) const ATTACHMENT_MARKER: &str = "\u{1F4CE} ";

const MAX_SESSION_ATTACHMENT_CACHE_BYTES: usize = 100 * 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub(super) struct AttachmentLimits {
    pub(super) max_count: usize,
    pub(super) max_attachment_size_bytes: usize,
    pub(super) max_total_attachments_bytes: usize,
    pub(super) max_session_cache_bytes: usize,
}

impl Default for AttachmentLimits {
    fn default() -> Self {
        Self {
            max_count: MAX_ATTACHMENTS_COUNT,
            max_attachment_size_bytes: MAX_ATTACHMENT_SIZE_BYTES,
            max_total_attachments_bytes: MAX_TOTAL_ATTACHMENTS_BYTES,
            max_session_cache_bytes: MAX_SESSION_ATTACHMENT_CACHE_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct AttachmentCacheKey {
    name: String,
    content_type: String,
    data_sha256: [u8; 32],
}

#[derive(Debug, Clone)]
struct CachedAttachment {
    key: AttachmentCacheKey,
    effective_size: usize,
    attachment: MessageAttachment,
}

#[derive(Debug, Clone, Default)]
struct ThreadAttachmentCache {
    attachments: Vec<CachedAttachment>,
    total_size: usize,
    last_access: u64,
}

#[derive(Debug, Default)]
struct SessionAttachmentCacheState {
    threads: HashMap<String, ThreadAttachmentCache>,
    total_size: usize,
    access_counter: u64,
}

/// Process-local attachment cache for the current app/server session.
#[derive(Debug)]
pub(super) struct SessionAttachmentCache {
    inner: Mutex<SessionAttachmentCacheState>,
    limits: AttachmentLimits,
}

impl SessionAttachmentCache {
    pub(super) fn new() -> Self {
        Self::with_limits(AttachmentLimits::default())
    }

    pub(super) fn with_limits(limits: AttachmentLimits) -> Self {
        Self {
            inner: Mutex::new(SessionAttachmentCacheState::default()),
            limits,
        }
    }

    pub(super) fn resolve_for_thread(
        &self,
        thread_id: &str,
        incoming: &[MessageAttachment],
    ) -> Result<Vec<MessageAttachment>, AiError> {
        validate_attachments_with_limits(incoming, self.limits)?;

        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        state.access_counter = state.access_counter.saturating_add(1);
        let last_access = state.access_counter;

        if incoming.is_empty() {
            return Ok(state
                .threads
                .get_mut(thread_id)
                .map(|entry| {
                    entry.last_access = last_access;
                    entry
                        .attachments
                        .iter()
                        .map(|cached| cached.attachment.clone())
                        .collect()
                })
                .unwrap_or_default());
        }

        let mut next_cached = state
            .threads
            .get(thread_id)
            .map(|entry| entry.attachments.clone())
            .unwrap_or_default();
        let mut keys: HashSet<AttachmentCacheKey> = next_cached
            .iter()
            .map(|cached| cached.key.clone())
            .collect();

        for attachment in incoming {
            let key = attachment_cache_key(attachment);
            if keys.insert(key.clone()) {
                next_cached.push(CachedAttachment {
                    key,
                    effective_size: attachment_effective_size(attachment),
                    attachment: attachment.clone(),
                });
            }
        }

        let next_attachments: Vec<MessageAttachment> = next_cached
            .iter()
            .map(|cached| cached.attachment.clone())
            .collect();
        let next_total = validate_attachments_with_limits(&next_attachments, self.limits)?;
        let cached_total: usize = next_cached.iter().map(|cached| cached.effective_size).sum();
        debug_assert_eq!(next_total, cached_total);

        let old_total = state
            .threads
            .get(thread_id)
            .map(|entry| entry.total_size)
            .unwrap_or_default();
        let entry = state.threads.entry(thread_id.to_string()).or_default();
        entry.attachments = next_cached;
        entry.total_size = cached_total;
        entry.last_access = last_access;

        state.total_size = state
            .total_size
            .saturating_sub(old_total)
            .saturating_add(cached_total);
        self.evict_if_needed(&mut state, thread_id);

        Ok(state
            .threads
            .get(thread_id)
            .map(|entry| {
                entry
                    .attachments
                    .iter()
                    .map(|cached| cached.attachment.clone())
                    .collect()
            })
            .unwrap_or_default())
    }

    pub(super) fn clear_thread(&self, thread_id: &str) {
        let mut state = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = state.threads.remove(thread_id) {
            state.total_size = state.total_size.saturating_sub(entry.total_size);
        }
    }

    fn evict_if_needed(&self, state: &mut SessionAttachmentCacheState, active_thread_id: &str) {
        while state.total_size > self.limits.max_session_cache_bytes {
            let Some(evict_thread_id) = state
                .threads
                .iter()
                .filter(|(thread_id, _)| thread_id.as_str() != active_thread_id)
                .min_by_key(|(_, entry)| entry.last_access)
                .map(|(thread_id, _)| thread_id.clone())
            else {
                break;
            };

            if let Some(entry) = state.threads.remove(&evict_thread_id) {
                state.total_size = state.total_size.saturating_sub(entry.total_size);
            }
        }
    }
}

fn attachment_cache_key(attachment: &MessageAttachment) -> AttachmentCacheKey {
    let mut hasher = Sha256::new();
    hasher.update(attachment.data.as_bytes());
    let digest = hasher.finalize();
    let mut data_sha256 = [0_u8; 32];
    data_sha256.copy_from_slice(&digest);

    AttachmentCacheKey {
        name: attachment.name.clone(),
        content_type: attachment.content_type.clone(),
        data_sha256,
    }
}

pub(super) fn attachment_effective_size(attachment: &MessageAttachment) -> usize {
    let is_binary = attachment.content_type.starts_with("image/")
        || attachment.content_type == "application/pdf";
    if is_binary {
        attachment.data.len() * 3 / 4
    } else {
        attachment.data.len()
    }
}

pub(super) fn validate_attachments(attachments: &[MessageAttachment]) -> Result<usize, AiError> {
    validate_attachments_with_limits(attachments, AttachmentLimits::default())
}

fn validate_attachments_with_limits(
    attachments: &[MessageAttachment],
    limits: AttachmentLimits,
) -> Result<usize, AiError> {
    if attachments.len() > limits.max_count {
        return Err(AiError::InvalidInput(format!(
            "Too many attachments: {} (max {})",
            attachments.len(),
            limits.max_count
        )));
    }

    let mut total_size: usize = 0;
    for attachment in attachments {
        let effective_size = attachment_effective_size(attachment);
        if effective_size > limits.max_attachment_size_bytes {
            return Err(AiError::InvalidInput(format!(
                "Attachment '{}' too large (max {} MB)",
                attachment.name,
                limits.max_attachment_size_bytes / (1024 * 1024)
            )));
        }
        total_size += effective_size;
    }

    if total_size > limits.max_total_attachments_bytes {
        return Err(AiError::InvalidInput(format!(
            "Total attachment size too large (max {} MB)",
            limits.max_total_attachments_bytes / (1024 * 1024)
        )));
    }

    Ok(total_size)
}

pub(super) fn text_has_attachment_marker(text: &str) -> bool {
    text.lines().any(|line| line.starts_with(ATTACHMENT_MARKER))
}

pub(super) fn messages_have_attachment_markers(messages: &[ChatMessage]) -> bool {
    messages.iter().any(|message| {
        message.role == ChatMessageRole::User
            && text_has_attachment_marker(&message.content.get_text_content())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_attachment(name: &str, data: &str) -> MessageAttachment {
        MessageAttachment {
            name: name.to_string(),
            content_type: "text/csv".to_string(),
            data: data.to_string(),
        }
    }

    fn test_limits() -> AttachmentLimits {
        AttachmentLimits {
            max_count: 3,
            max_attachment_size_bytes: 10,
            max_total_attachments_bytes: 20,
            max_session_cache_bytes: 100,
        }
    }

    #[test]
    fn test_text_has_attachment_marker_matches_stored_marker_lines_only() {
        assert!(text_has_attachment_marker("import this\n📎 statement.csv"));
        assert!(text_has_attachment_marker("📎 statement.csv"));
        assert!(!text_has_attachment_marker(
            "please explain 📎 statement.csv"
        ));
        assert!(!text_has_attachment_marker(
            "not an attachment: 📎 statement.csv"
        ));
    }

    #[test]
    fn test_session_attachment_cache_stores_and_reuses_attachments() {
        let cache = SessionAttachmentCache::with_limits(test_limits());
        let incoming = vec![test_attachment("trades.csv", "a,b\n1,2")];
        let stored = cache.resolve_for_thread("thread-1", &incoming).unwrap();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].name, "trades.csv");

        let reused = cache.resolve_for_thread("thread-1", &[]).unwrap();
        assert_eq!(reused.len(), stored.len());
        assert_eq!(reused[0].name, stored[0].name);
        assert_eq!(reused[0].data, stored[0].data);
    }

    #[test]
    fn test_session_attachment_cache_appends_unique_and_skips_duplicates() {
        let cache = SessionAttachmentCache::with_limits(test_limits());
        let first = test_attachment("trades.csv", "a,b\n1,2");
        let second = test_attachment("statement.csv", "c,d\n3,4");

        cache
            .resolve_for_thread("thread-1", std::slice::from_ref(&first))
            .unwrap();
        let with_duplicate = cache
            .resolve_for_thread("thread-1", &[first.clone(), second.clone()])
            .unwrap();

        assert_eq!(with_duplicate.len(), 2);
        assert_eq!(with_duplicate[0].name, first.name);
        assert_eq!(with_duplicate[0].data, first.data);
        assert_eq!(with_duplicate[1].name, second.name);
        assert_eq!(with_duplicate[1].data, second.data);
    }

    #[test]
    fn test_session_attachment_cache_enforces_limits() {
        let cache = SessionAttachmentCache::with_limits(test_limits());

        let too_large = vec![test_attachment("large.csv", "01234567890")];
        assert!(matches!(
            cache.resolve_for_thread("thread-1", &too_large),
            Err(AiError::InvalidInput(_))
        ));

        let too_many = vec![
            test_attachment("a.csv", "1"),
            test_attachment("b.csv", "2"),
            test_attachment("c.csv", "3"),
            test_attachment("d.csv", "4"),
        ];
        assert!(matches!(
            cache.resolve_for_thread("thread-1", &too_many),
            Err(AiError::InvalidInput(_))
        ));

        cache
            .resolve_for_thread("thread-1", &[test_attachment("a.csv", "1234567890")])
            .unwrap();
        assert!(matches!(
            cache.resolve_for_thread("thread-1", &[test_attachment("b.csv", "12345678901")]),
            Err(AiError::InvalidInput(_))
        ));
        assert!(matches!(
            cache.resolve_for_thread(
                "thread-1",
                &[
                    test_attachment("b.csv", "1234567890"),
                    test_attachment("c.csv", "x"),
                ],
            ),
            Err(AiError::InvalidInput(_))
        ));
    }

    #[test]
    fn test_session_attachment_cache_evicts_least_recently_used_thread() {
        let cache = SessionAttachmentCache::with_limits(AttachmentLimits {
            max_session_cache_bytes: 15,
            ..test_limits()
        });

        cache
            .resolve_for_thread("thread-a", &[test_attachment("a.csv", "123456")])
            .unwrap();
        cache
            .resolve_for_thread("thread-b", &[test_attachment("b.csv", "123456")])
            .unwrap();
        cache.resolve_for_thread("thread-a", &[]).unwrap();
        cache
            .resolve_for_thread("thread-c", &[test_attachment("c.csv", "123456")])
            .unwrap();

        assert_eq!(cache.resolve_for_thread("thread-b", &[]).unwrap().len(), 0);
        assert_eq!(cache.resolve_for_thread("thread-a", &[]).unwrap().len(), 1);
        assert_eq!(cache.resolve_for_thread("thread-c", &[]).unwrap().len(), 1);
    }

    #[test]
    fn test_session_attachment_cache_clears_thread() {
        let cache = SessionAttachmentCache::with_limits(test_limits());

        cache
            .resolve_for_thread("thread-1", &[test_attachment("a.csv", "1")])
            .unwrap();
        cache.clear_thread("thread-1");

        assert!(cache
            .resolve_for_thread("thread-1", &[])
            .unwrap()
            .is_empty());
    }
}
