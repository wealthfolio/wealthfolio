export type AuthFailure = "expired" | "signIn";

/** Successful HTML from an API may be a proxy sign-in page, not a revoked session. */
export function classifyAuthResponse(response: Response): AuthFailure | null {
  if (response.status === 401) return "expired";
  if (response.ok && response.headers.get("content-type")?.includes("text/html")) return "signIn";
  return null;
}

let unauthorizedHandler: ((reason: AuthFailure) => void) | null = null;

export const setUnauthorizedHandler = (handler: ((reason: AuthFailure) => void) | null) => {
  unauthorizedHandler = handler;
};

export const notifyUnauthorized = (reason: AuthFailure = "expired") => {
  unauthorizedHandler?.(reason);
};
