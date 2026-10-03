import { classifyAuthResponse, notifyUnauthorized } from "@/lib/auth-token";
import { deferApplicationReload, reloadApplication } from "@/lib/reload-application";

// Immutable for the lifetime of a financial application load. Old async work
// must never acquire a subsequently selected profile's authority.
export interface ProfileSession {
  profileId: string;
  scopeId: string;
}
let admitted: Readonly<ProfileSession & { isLegacy: boolean }> | undefined;
let revoked = false;
let deferReload = false;
export function deferProfileReload(value: boolean) {
  deferReload = value;
  deferApplicationReload(value);
}
export function installProfileSession(session: ProfileSession, isLegacy = false) {
  if (deferReload) return false;
  if ((admitted && admitted.scopeId !== session.scopeId) || (revoked && !admitted)) {
    revokeProfileSession();
    reloadApplication({ dashboard: !!admitted && admitted.profileId !== session.profileId });
    return false;
  }
  if (revoked) return false;
  admitted = Object.freeze({ ...session, isLegacy });
  return true;
}
export function hasProfileSession(): boolean {
  return admitted !== undefined && !revoked;
}
export function profileScope(): string {
  if (!admitted || revoked) throw new Error("PROFILE_LOCKED");
  return admitted.scopeId;
}
export function revokeProfileSession() {
  if (revoked) return;
  revoked = true;
  window.dispatchEvent(new Event("wealthfolio:profile-locked"));
}
export function profileHeaders(): Record<string, string> {
  return { "x-wf-profile-scope": profileScope() };
}

export async function profileFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-wf-profile-scope", profileScope());
  const response = await fetch(input, { ...init, headers });
  if (classifyAuthResponse(response) === "signIn") {
    notifyUnauthorized("signIn");
    throw new Error("PROFILE_AUTH_REQUIRED");
  }
  if (response.status === 423) revokeProfileSession();
  profileScope();
  return response;
}

export function usesLegacyPreferences(): boolean {
  return admitted?.isLegacy === true;
}

export function selectedProfileId(): string | undefined {
  return admitted?.profileId;
}

export function matchesProfileScope(scope: string): boolean {
  return !revoked && admitted?.scopeId === scope;
}
