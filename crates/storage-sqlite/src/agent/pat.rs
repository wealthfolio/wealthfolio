//! Personal Access Token repository (server-mode MCP auth).
//!
//! Stores only token hashes. Token generation, prefix extraction, and
//! hashing happen in the host (apps/server); this repository persists and
//! queries the rows.

use std::sync::Arc;

use diesel::prelude::*;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::db::{get_connection, DbPool, WriteHandle};
use crate::errors::StorageError;
use crate::schema::personal_access_tokens;
use wealthfolio_core::errors::Result;

#[derive(Queryable, Identifiable, Selectable, Insertable, Serialize, Deserialize, Debug, Clone)]
#[diesel(table_name = crate::schema::personal_access_tokens)]
#[diesel(check_for_backend(diesel::sqlite::Sqlite))]
pub struct PersonalAccessTokenDB {
    pub id: String,
    pub name: String,
    pub token_prefix: String,
    pub token_hash: String,
    pub scopes_json: String,
    pub expires_at: Option<String>,
    pub last_used_at: Option<String>,
    pub revoked_at: Option<String>,
    pub created_at: String,
}

/// Input for creating a token row. The host generates the secret and
/// passes only its derived prefix + hash here.
#[derive(Debug, Clone)]
pub struct NewPersonalAccessToken {
    pub name: String,
    pub token_prefix: String,
    pub token_hash: String,
    /// JSON array of canonical scope strings.
    pub scopes_json: String,
    pub expires_at: Option<String>,
}

pub struct PatRepository {
    pool: Arc<DbPool>,
    writer: WriteHandle,
}

impl PatRepository {
    pub fn new(pool: Arc<DbPool>, writer: WriteHandle) -> Self {
        Self { pool, writer }
    }

    pub async fn create(&self, new_token: NewPersonalAccessToken) -> Result<PersonalAccessTokenDB> {
        let row = PersonalAccessTokenDB {
            id: Uuid::new_v4().to_string(),
            name: new_token.name,
            token_prefix: new_token.token_prefix,
            token_hash: new_token.token_hash,
            scopes_json: new_token.scopes_json,
            expires_at: new_token.expires_at,
            last_used_at: None,
            revoked_at: None,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        self.writer
            .exec(move |conn| {
                diesel::insert_into(personal_access_tokens::table)
                    .values(&row)
                    .returning(PersonalAccessTokenDB::as_returning())
                    .get_result(conn)
                    .map_err(|e| StorageError::from(e).into())
            })
            .await
    }

    /// All tokens, newest first (revoked/expired included — the UI shows
    /// their state).
    pub fn list(&self) -> Result<Vec<PersonalAccessTokenDB>> {
        let mut conn = get_connection(&self.pool)?;
        personal_access_tokens::table
            .order(personal_access_tokens::created_at.desc())
            .select(PersonalAccessTokenDB::as_select())
            .load(&mut conn)
            .map_err(|e| StorageError::from(e).into())
    }

    /// Candidate rows for a presented token's prefix. The caller performs
    /// the constant-time hash comparison and expiry/revocation checks.
    pub fn find_by_prefix(&self, prefix: &str) -> Result<Vec<PersonalAccessTokenDB>> {
        let mut conn = get_connection(&self.pool)?;
        personal_access_tokens::table
            .filter(personal_access_tokens::token_prefix.eq(prefix))
            .select(PersonalAccessTokenDB::as_select())
            .load(&mut conn)
            .map_err(|e| StorageError::from(e).into())
    }

    /// Permanently delete a token. Removing the row cuts off access
    /// immediately (auth does a row lookup). Returns false when the id does
    /// not exist.
    pub async fn delete(&self, id: &str) -> Result<bool> {
        let id = id.to_string();
        self.writer
            .exec(move |conn| {
                let deleted = diesel::delete(
                    personal_access_tokens::table.filter(personal_access_tokens::id.eq(&id)),
                )
                .execute(conn)
                .map_err(StorageError::from)?;
                Ok(deleted > 0)
            })
            .await
    }

    pub async fn touch_last_used(&self, id: &str) -> Result<()> {
        let id = id.to_string();
        let now = chrono::Utc::now().to_rfc3339();
        self.writer
            .exec(move |conn| {
                diesel::update(
                    personal_access_tokens::table.filter(personal_access_tokens::id.eq(&id)),
                )
                .set(personal_access_tokens::last_used_at.eq(Some(now)))
                .execute(conn)
                .map_err(StorageError::from)?;
                Ok(())
            })
            .await
    }
}
