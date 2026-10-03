import { classifyAuthResponse, notifyUnauthorized } from "@/lib/auth-token";
import { isWeb } from "@/adapters";
import { profileScope } from "./session";
import type { ProfileSession } from "./session";
import { profileErrorCode } from "./error-messages";

export const PROFILE_STATE_TIMEOUT_MS = 10_000;

class ProfileRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Keep transport failures distinct from confirmed rejection and domain errors. */
export function profileFailureKind(error: unknown): "session" | "connection" | "auth" | "domain" {
  const code = profileErrorCode(error);
  if (!code || code === "PROFILE_CONNECTION_FAILED") return "connection";
  if (code === "PROFILE_AUTH_REQUIRED") return "auth";
  if (
    (code === "PROFILE_LOCKED" || code === "PROFILE_STALE") &&
    (!(error instanceof ProfileRequestError) || error.status === 423)
  )
    return "session";
  return "domain";
}
// One channel per JS context prevents commands from notifying their own shell.
export const profileChangesChannel =
  isWeb && typeof BroadcastChannel !== "undefined"
    ? new BroadcastChannel("wealthfolio:profiles")
    : undefined;
const PROFILE_MUTATIONS = new Set([
  "unlock_profile",
  "lock_profile",
  "create_profile",
  "delete_profile",
  "update_profile",
  "set_profile_password",
  "recover_profile_password",
]);
export interface ProfileSummary {
  id: string;
  name: string;
  avatarId: string;
  lockEnabled: boolean;
  isLegacy?: boolean;
  /** Prior Connect association, independent of the current sign-in session. */
  hasConnectBinding?: boolean;
}
export interface ProfileState {
  profiles: ProfileSummary[];
  pendingDeletions?: ProfileSummary[];
  session: ProfileSession | null;
  starting: boolean;
  startupError?: string | null;
}
export async function profileCommand<T>(
  command: string,
  payload: Record<string, unknown> = {},
  scoped = false,
): Promise<T> {
  if (!isWeb) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(command, { ...payload, ...(scoped ? { scopeId: profileScope() } : {}) });
  }
  // Bound state reads so startup Retry remains usable if the server is unreachable.
  // Bound web locking too, so its existing retry screen remains usable offline.
  const controller =
    command === "get_profile_state" || command === "lock_profile"
      ? new AbortController()
      : undefined;
  const timeout = controller
    ? window.setTimeout(() => controller.abort(), PROFILE_STATE_TIMEOUT_MS)
    : undefined;
  try {
    const res = await fetch(`/api/v1/profiles/${command}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(scoped ? { "x-wf-profile-scope": profileScope() } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller?.signal,
    });
    const authFailure = classifyAuthResponse(res);
    if (authFailure) {
      notifyUnauthorized(authFailure);
      throw new Error("PROFILE_AUTH_REQUIRED");
    }
    if (!res.ok) throw new ProfileRequestError(await res.text(), res.status);
    const result = (await res.json()) as T;
    if (PROFILE_MUTATIONS.has(command)) profileChangesChannel?.postMessage("changed");
    return result;
  } finally {
    window.clearTimeout(timeout);
  }
}
