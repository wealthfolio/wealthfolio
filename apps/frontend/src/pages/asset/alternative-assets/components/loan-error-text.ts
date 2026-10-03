import type { TFunction } from "i18next";

/** Loan helpers throw translation keys; other errors are shown as they are. */
export function loanErrorText(t: TFunction, cause: unknown, fallbackKey: string): string {
  if (!(cause instanceof Error)) return t(fallbackKey);
  return cause.message.startsWith("asset:") ? t(cause.message) : cause.message;
}
