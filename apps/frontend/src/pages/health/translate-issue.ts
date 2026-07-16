import type { TFunction } from "i18next";

import type { HealthIssue } from "@/lib/types";

// Prefer the translated `health:issues.<code>.<field>` (interpolated with the
// backend's params); fall back to the English title/message the backend still
// sends when an issue has no code yet. This lets checks migrate incrementally.
export function translateIssueText(
  t: TFunction,
  issue: Pick<HealthIssue, "code" | "params" | "title" | "message">,
  field: "title" | "message",
): string {
  const fallback = issue[field];
  if (!issue.code) return fallback;
  return t(`health:issues.${issue.code}.${field}`, {
    ...(issue.params ?? {}),
    defaultValue: fallback,
  });
}
