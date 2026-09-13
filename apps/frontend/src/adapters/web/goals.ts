// Web adapter - Goal Commands (platform-specific)
import { API_PREFIX } from "./core";
import { notifyUnauthorized } from "@/lib/auth-token";

export const loadGoalCoverImage = async (goalId: string): Promise<Blob> => {
  const response = await fetch(`${API_PREFIX}/goals/${encodeURIComponent(goalId)}/cover-image`, {
    credentials: "same-origin",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 401) {
    notifyUnauthorized();
  }
  if (!response.ok) {
    let message = response.statusText || "Failed to load goal cover image";
    try {
      const body = (await response.json()) as { message?: unknown };
      if (typeof body.message === "string") {
        message = body.message;
      }
    } catch {
      // Keep the HTTP status text for non-JSON errors.
    }
    throw new Error(message);
  }
  return response.blob();
};
