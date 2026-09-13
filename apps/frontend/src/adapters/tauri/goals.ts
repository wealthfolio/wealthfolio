// Goal Commands (platform-specific)
import { tauriInvoke } from "./core";

export const loadGoalCoverImage = async (goalId: string, mimeType?: string): Promise<Blob> => {
  const response = await tauriInvoke<ArrayBuffer | number[]>("load_goal_cover_image", { goalId });
  const bytes = response instanceof ArrayBuffer ? response : new Uint8Array(response);
  return new Blob([bytes], { type: mimeType || "application/octet-stream" });
};
