export interface AddonLocalizationSnapshot {
  locale: string;
  uiLocale?: string;
  timezone?: string;
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

export function setAddonLocalizationSnapshot(snapshot: AddonLocalizationSnapshot): void {
  if (
    currentSnapshot.locale === snapshot.locale &&
    currentSnapshot.uiLocale === snapshot.uiLocale &&
    currentSnapshot.timezone === snapshot.timezone
  ) {
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
