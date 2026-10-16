export interface AddonLocalizationSnapshot {
  locale: string;
  uiLocale?: string;
  timezone?: string;
  /** Formatting regions for amounts in specific currencies, keyed by currency code. */
  currencyFormattingRegions?: Record<string, string>;
}

type AddonLocalizationListener = (snapshot: AddonLocalizationSnapshot) => void;

const listeners = new Set<AddonLocalizationListener>();

let currentSnapshot: AddonLocalizationSnapshot = {
  locale:
    typeof navigator === "undefined"
      ? "en-US"
      : navigator.languages?.[0] || navigator.language || "en-US",
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

export function collectAddonLocalizationSnapshot(): AddonLocalizationSnapshot {
  return currentSnapshot;
}

export function isSameAddonLocalization(
  left: AddonLocalizationSnapshot,
  right: AddonLocalizationSnapshot,
): boolean {
  return (
    left.locale === right.locale &&
    left.uiLocale === right.uiLocale &&
    left.timezone === right.timezone &&
    JSON.stringify(left.currencyFormattingRegions ?? {}) ===
      JSON.stringify(right.currencyFormattingRegions ?? {})
  );
}

export function setAddonLocalizationSnapshot(snapshot: AddonLocalizationSnapshot): void {
  if (isSameAddonLocalization(currentSnapshot, snapshot)) {
    return;
  }

  currentSnapshot = snapshot;
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function subscribeToAddonLocalization(listener: AddonLocalizationListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
