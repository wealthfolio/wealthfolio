import type { TFunction } from "i18next";

/** Display-only provenance for local validation; never sent to the import API. */
export type LocalDraftErrorMessages = Record<string, { key: string; originalMessage: string }[]>;

export function formatDraftErrors(
  t: TFunction,
  messages: string[],
  localMessages?: LocalDraftErrorMessages[string],
): string[] {
  return messages.map((message, index) => {
    const local = localMessages?.[index];
    return local?.originalMessage === message ? t(local.key) : message;
  });
}

/** Backend replacements own their text, even when it equals a local English message. */
export function omitLocalDraftErrors(
  messages: LocalDraftErrorMessages | undefined,
  fields: string[],
): LocalDraftErrorMessages | undefined {
  if (!messages) return undefined;
  return Object.fromEntries(Object.entries(messages).filter(([field]) => !fields.includes(field)));
}
