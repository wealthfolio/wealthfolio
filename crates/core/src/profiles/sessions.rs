use super::{ProfileError, ProfileResult};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use uuid::Uuid;

pub const PROFILE_IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSession {
    pub profile_id: Uuid,
    pub scope_id: Uuid,
    #[serde(skip)]
    pub generation: Option<Uuid>,
}

struct Grant {
    session: ProfileSession,
    protected: bool,
    activity: Instant,
}

/// Owners are authenticated web session IDs or the native main window identity.
/// A web scope selector is never authorization without its authenticated owner.
#[derive(Default)]
pub struct ProfileSessions(Mutex<HashMap<String, Grant>>, Mutex<HashMap<String, u64>>);

impl ProfileSessions {
    pub fn issue(
        &self,
        owner: &str,
        profile_id: Uuid,
        protected: bool,
        generation: Option<Uuid>,
    ) -> ProfileResult<ProfileSession> {
        let session = ProfileSession {
            profile_id,
            scope_id: Uuid::new_v4(),
            generation,
        };
        self.0
            .lock()
            .map_err(|_| ProfileError::Unavailable("Session state is unavailable.".into()))?
            .insert(
                owner.into(),
                Grant {
                    session: session.clone(),
                    protected,
                    activity: Instant::now(),
                },
            );
        Ok(session)
    }

    pub fn current(&self, owner: &str) -> ProfileResult<Option<ProfileSession>> {
        let mut grants = self
            .0
            .lock()
            .map_err(|_| ProfileError::Unavailable("Session state is unavailable.".into()))?;
        if grants
            .get(owner)
            .is_some_and(|g| g.protected && g.activity.elapsed() >= PROFILE_IDLE_TIMEOUT)
        {
            grants.remove(owner);
        }
        Ok(grants.get(owner).map(|g| g.session.clone()))
    }

    pub fn admit(&self, owner: &str, scope: Uuid) -> ProfileResult<ProfileSession> {
        let session = self.current(owner)?.ok_or(ProfileError::Locked)?;
        if session.scope_id != scope {
            return Err(ProfileError::Stale);
        }
        Ok(session)
    }

    pub fn activity(&self, owner: &str, scope: Uuid) -> ProfileResult<()> {
        self.admit(owner, scope)?;
        let mut grants = self
            .0
            .lock()
            .map_err(|_| ProfileError::Unavailable("Session state is unavailable.".into()))?;
        let grant = grants
            .get_mut(owner)
            .filter(|g| g.session.scope_id == scope)
            .ok_or(ProfileError::Stale)?;
        grant.activity = Instant::now();
        Ok(())
    }

    pub fn rotate(
        &self,
        owner: &str,
        expected: Uuid,
        generation: Option<Uuid>,
    ) -> ProfileResult<ProfileSession> {
        let mut grants = self.0.lock().map_err(|_| ProfileError::Locked)?;
        let grant = grants
            .get_mut(owner)
            .filter(|g| {
                g.session.scope_id == expected
                    && (!g.protected || g.activity.elapsed() < PROFILE_IDLE_TIMEOUT)
            })
            .ok_or(ProfileError::Stale)?;
        grant.session.scope_id = Uuid::new_v4();
        grant.session.generation = generation;
        Ok(grant.session.clone())
    }

    pub fn unlock_revision(&self, owner: &str) -> ProfileResult<u64> {
        Ok(*self
            .1
            .lock()
            .map_err(|_| ProfileError::Locked)?
            .entry(owner.into())
            .or_default())
    }
    pub fn issue_if_current(
        &self,
        owner: &str,
        revision: u64,
        profile: Uuid,
        protected: bool,
    ) -> ProfileResult<ProfileSession> {
        let mut revisions = self.1.lock().map_err(|_| ProfileError::Locked)?;
        if *revisions.entry(owner.into()).or_default() != revision {
            return Err(ProfileError::Stale);
        }
        let result = self.issue(owner, profile, protected, None)?;
        *revisions.entry(owner.into()).or_default() += 1;
        Ok(result)
    }
    pub fn revoke(&self, owner: &str) -> ProfileResult<()> {
        let mut revisions = self.1.lock().map_err(|_| ProfileError::Locked)?;
        *revisions.entry(owner.into()).or_default() += 1;
        self.0
            .lock()
            .map_err(|_| ProfileError::Unavailable("Session state is unavailable.".into()))?
            .remove(owner);
        Ok(())
    }

    /// Preserve admitted unprotected sessions during automatic lifecycle locking.
    /// Missing grants still cancel pending admission. Protection comes from
    /// credential verification, not the registry hint.
    pub fn revoke_for_auto_lock(&self, owner: &str) -> ProfileResult<bool> {
        let mut revisions = self.1.lock().map_err(|_| ProfileError::Locked)?;
        let mut grants = self
            .0
            .lock()
            .map_err(|_| ProfileError::Unavailable("Session state is unavailable.".into()))?;
        if grants.get(owner).is_some_and(|grant| !grant.protected) {
            return Ok(false);
        }
        *revisions.entry(owner.into()).or_default() += 1;
        grants.remove(owner);
        Ok(true)
    }

    pub fn revoke_profile(&self, profile_id: Uuid) -> ProfileResult<()> {
        let mut revisions = self.1.lock().map_err(|_| ProfileError::Locked)?;
        for revision in revisions.values_mut() {
            *revision += 1;
        }
        self.0
            .lock()
            .map_err(|_| ProfileError::Unavailable("Session state is unavailable.".into()))?
            .retain(|_, g| g.session.profile_id != profile_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unprotected_sessions_survive_idle_and_lifecycle_but_allow_explicit_switching() {
        let sessions = ProfileSessions::default();
        let session = sessions
            .issue("native", Uuid::new_v4(), false, None)
            .unwrap();
        sessions
            .0
            .lock()
            .unwrap()
            .get_mut("native")
            .unwrap()
            .activity = Instant::now() - PROFILE_IDLE_TIMEOUT;
        assert!(!sessions.revoke_for_auto_lock("native").unwrap());
        assert!(sessions.admit("native", session.scope_id).is_ok());
        sessions.revoke("native").unwrap();
        assert!(matches!(
            sessions.admit("native", session.scope_id),
            Err(ProfileError::Locked)
        ));
    }

    #[test]
    fn lifecycle_lock_revokes_protected_sessions_and_pending_admission() {
        let sessions = ProfileSessions::default();
        let session = sessions
            .issue("native", Uuid::new_v4(), true, None)
            .unwrap();
        let revision = sessions.unlock_revision("native").unwrap();
        assert!(sessions.revoke_for_auto_lock("native").unwrap());
        assert!(sessions.admit("native", session.scope_id).is_err());
        assert!(sessions
            .issue_if_current("native", revision, session.profile_id, true)
            .is_err());
        let revision = sessions.unlock_revision("native").unwrap();
        assert!(sessions.revoke_for_auto_lock("native").unwrap());
        assert!(sessions
            .issue_if_current("native", revision, session.profile_id, true)
            .is_err());
    }

    #[test]
    fn switching_and_browser_ownership_reject_stale_scopes() {
        let sessions = ProfileSessions::default();
        let a = sessions
            .issue("browser-a", Uuid::new_v4(), true, None)
            .unwrap();
        assert!(sessions.admit("browser-b", a.scope_id).is_err());
        let b = sessions
            .issue("browser-b", Uuid::new_v4(), true, None)
            .unwrap();
        sessions
            .issue("browser-a", b.profile_id, true, None)
            .unwrap();
        assert!(matches!(
            sessions.admit("browser-a", a.scope_id),
            Err(ProfileError::Stale)
        ));
        sessions.revoke("browser-a").unwrap();
        assert!(sessions.admit("browser-b", b.scope_id).is_ok());
    }

    #[test]
    fn expired_activity_cannot_unlock_a_session() {
        let sessions = ProfileSessions::default();
        let session = sessions
            .issue("native", Uuid::new_v4(), true, None)
            .unwrap();
        sessions
            .0
            .lock()
            .unwrap()
            .get_mut("native")
            .unwrap()
            .activity = Instant::now() - PROFILE_IDLE_TIMEOUT;
        assert!(matches!(
            sessions.activity("native", session.scope_id),
            Err(ProfileError::Locked)
        ));
    }
    #[test]
    fn pending_unlock_and_recovery_rotation_cannot_resurrect_revoked_grants() {
        let sessions = ProfileSessions::default();
        let profile = Uuid::new_v4();
        let revision = sessions.unlock_revision("browser").unwrap();
        sessions.revoke("browser").unwrap();
        assert!(sessions
            .issue_if_current("browser", revision, profile, true)
            .is_err());
        let revision = sessions.unlock_revision("browser").unwrap();
        sessions.revoke_profile(profile).unwrap();
        assert!(sessions
            .issue_if_current("browser", revision, profile, true)
            .is_err());
        let grant = sessions.issue("browser", profile, true, None).unwrap();
        let recovered = sessions
            .rotate("browser", grant.scope_id, Some(Uuid::new_v4()))
            .unwrap();
        assert!(sessions.admit("browser", grant.scope_id).is_err());
        sessions.revoke("browser").unwrap();
        assert!(sessions
            .rotate("browser", recovered.scope_id, Some(Uuid::new_v4()))
            .is_err());
    }
}
