//! Windows passwords are limited to 2,560 UTF-16 bytes per credential. Keep
//! ordinary credentials unchanged and store larger values under private users.
//! The metadata credential is the commit point; it never contains secret data.
//! Calls are serialized by the existing profile credential gate, including
//! profile deletion. No background cleanup or additional lock is needed.

use std::collections::{BTreeSet, HashMap};

use keyring_core::{api::CredentialStore, Entry, Error, Result};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::USERNAME;

const METADATA_USER: &str = "wealthfolio-chunks-v1";
const CHUNK_USER_PREFIX: &str = "wealthfolio-chunk-v1:";
const CHUNK_UTF16_UNITS: usize = 1280;
// Bound native credential fan-out and allocations when reading metadata.
const MAX_SECRET_BYTES: usize = 1024 * 1024;
const MAX_PARTS: usize = MAX_SECRET_BYTES.div_ceil(CHUNK_UTF16_UNITS);

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Metadata {
    version: u8,
    generation: Uuid,
    parts: usize,
    bytes: usize,
}

pub(super) struct ChunkedCredential<'a> {
    store: &'a CredentialStore,
    service: &'a str,
}

impl<'a> ChunkedCredential<'a> {
    pub(super) fn new(store: &'a CredentialStore, service: &'a str) -> Self {
        Self { store, service }
    }

    fn entry(&self, user: &str) -> Result<Entry> {
        self.store.build(self.service, user, None)
    }

    fn metadata(&self) -> Result<Option<Metadata>> {
        let Some(raw) = read(&self.entry(METADATA_USER)?)? else {
            return Ok(None);
        };
        let metadata: Metadata = serde_json::from_str(&raw).map_err(|_| invalid_metadata())?;
        if metadata.version != 1
            || metadata.parts == 0
            || metadata.parts > MAX_PARTS
            || metadata.bytes == 0
            || metadata.bytes > MAX_SECRET_BYTES
        {
            return Err(invalid_metadata());
        }
        Ok(Some(metadata))
    }

    pub(super) fn get(&self) -> Result<Option<String>> {
        let Some(metadata) = self.metadata()? else {
            return read(&self.entry(USERNAME)?);
        };
        let mut value = String::with_capacity(metadata.bytes);
        for index in 0..metadata.parts {
            let chunk = read(&self.entry(&chunk_user(metadata.generation, index))?)?
                .ok_or_else(invalid_metadata)?;
            if value.len() + chunk.len() > metadata.bytes {
                return Err(invalid_metadata());
            }
            value.push_str(&chunk);
        }
        if value.len() != metadata.bytes {
            return Err(invalid_metadata());
        }
        Ok(Some(value))
    }

    pub(super) fn set(&self, secret: &str) -> Result<()> {
        if secret.len() > MAX_SECRET_BYTES {
            return Err(Error::TooLong(
                "secret bytes".into(),
                MAX_SECRET_BYTES as u32,
            ));
        }
        let previous = self.metadata()?;
        if secret.encode_utf16().count() <= CHUNK_UTF16_UNITS {
            self.entry(USERNAME)?.set_password(secret)?;
            // Until this succeeds, readers continue to see the old chunks.
            delete(&self.entry(METADATA_USER)?)?;
        } else {
            let chunks = split(secret);
            let metadata = Metadata {
                version: 1,
                generation: Uuid::new_v4(),
                parts: chunks.len(),
                bytes: secret.len(),
            };
            let write = || {
                for (index, chunk) in chunks.iter().enumerate() {
                    self.entry(&chunk_user(metadata.generation, index))?
                        .set_password(chunk)?;
                }
                let raw = serde_json::to_string(&metadata).map_err(|_| invalid_metadata())?;
                self.entry(METADATA_USER)?.set_password(&raw)
            };
            if let Err(error) = write() {
                self.cleanup(&metadata);
                return Err(error);
            }
            // The new value is committed. Cleanup failures must not report an
            // unsuccessful save: deletion also inventories leftover generations.
            if let Err(error) = self.entry(USERNAME).and_then(|entry| delete(&entry)) {
                super::log_native_failure("cleanup", &error);
            }
        }
        if let Some(previous) = previous {
            self.cleanup(&previous);
        }
        Ok(())
    }

    fn cleanup(&self, metadata: &Metadata) {
        for index in 0..metadata.parts {
            if let Err(error) = self
                .entry(&chunk_user(metadata.generation, index))
                .and_then(|entry| delete(&entry))
            {
                super::log_native_failure("cleanup", &error);
            }
        }
    }

    pub(super) fn delete(&self) -> Result<()> {
        // Inventory first, including orphaned generations from interrupted
        // writes. Do not depend on readable/valid metadata to delete a secret.
        let entries = entries(self.store, self.service, false)?;
        delete(&self.entry(USERNAME)?)?;
        for (entry, user, _) in entries {
            if user.starts_with(CHUNK_USER_PREFIX) {
                delete(&entry)?;
            }
        }
        // Remove the pointer last: an interrupted delete fails closed rather
        // than revealing a stale ordinary credential.
        delete(&self.entry(METADATA_USER)?)
    }
}

pub(super) fn list_services(store: &CredentialStore, prefix: &str) -> Result<Vec<String>> {
    Ok(entries(store, prefix, true)?
        .into_iter()
        .map(|(_, _, service)| service)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect())
}

fn entries(
    store: &CredentialStore,
    service: &str,
    prefix: bool,
) -> Result<Vec<(Entry, String, String)>> {
    let pattern = format!(
        r"(?s)^(?:{}|{}|{}[^.]+)\.{}{}$",
        USERNAME,
        METADATA_USER,
        CHUNK_USER_PREFIX,
        regex::escape(service),
        if prefix { ".*" } else { "" },
    );
    let mut owned = Vec::new();
    for entry in store.search(&HashMap::from([("pattern", pattern.as_str())]))? {
        // Windows' default search splits on the *last* dot, which misparses
        // dotted service IDs. The target uses a dot-free user and the full
        // service. Read attributes only; cleanup never exports secret values.
        #[cfg(target_os = "windows")]
        let specifiers = entry
            .get_attributes()?
            .get("target_name")
            .and_then(|target| target.split_once('.'))
            .map(|(user, service)| (service.to_owned(), user.to_owned()));
        #[cfg(not(target_os = "windows"))]
        let specifiers = entry.get_specifiers();
        if let Some((candidate, user)) = specifiers {
            if (user == USERNAME || user == METADATA_USER || user.starts_with(CHUNK_USER_PREFIX))
                && (candidate == service || (prefix && candidate.starts_with(service)))
            {
                owned.push((entry, user, candidate));
            }
        }
    }
    Ok(owned)
}

fn read(entry: &Entry) -> Result<Option<String>> {
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(Error::NoEntry) => Ok(None),
        Err(error) => Err(error),
    }
}

fn delete(entry: &Entry) -> Result<()> {
    match entry.delete_credential() {
        Ok(()) | Err(Error::NoEntry) => Ok(()),
        Err(error) => Err(error),
    }
}

fn chunk_user(generation: Uuid, index: usize) -> String {
    format!("{CHUNK_USER_PREFIX}{generation}:{index}")
}

fn invalid_metadata() -> Error {
    Error::BadStoreFormat("Chunked credential is incomplete or invalid".into())
}

fn split(secret: &str) -> Vec<&str> {
    let mut chunks = Vec::new();
    let mut start = 0;
    let mut units = 0;
    for (offset, character) in secret.char_indices() {
        if units + character.len_utf16() > CHUNK_UTF16_UNITS {
            chunks.push(&secret[start..offset]);
            start = offset;
            units = 0;
        }
        units += character.len_utf16();
    }
    chunks.push(&secret[start..]);
    chunks
}

#[cfg(test)]
#[path = "chunking/tests.rs"]
mod tests;
