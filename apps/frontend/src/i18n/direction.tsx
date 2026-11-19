import { DirectionProvider, type TextDirection } from "@wealthfolio/ui";
import { useSyncExternalStore, type ReactNode } from "react";

import i18n from "./i18n";

// The reading direction follows the UI language only (`i18n.dir`), never the
// formatting region. It lives here, outside React state, because the login page
// and the profile shell render before the settings provider and still need it,
// and because `<html dir>` must be right before the first paint.
let languageDirection = directionOf(i18n.language || i18n.options.lng);
// Development and tests only: forces a direction without shipping a
// right-to-left language. Kept in memory, never persisted.
let developmentOverride: TextDirection | null = null;
const listeners = new Set<() => void>();

function directionOf(language: string | undefined): TextDirection {
  // i18next answers "rtl" when it is given no language, which is the case
  // before its deferred init has run; the cached language is in `options.lng`.
  return language ? i18n.dir(language) : "ltr";
}

export function getDocumentDirection(): TextDirection {
  return developmentOverride ?? languageDirection;
}

function applyDocumentDirection() {
  const direction = getDocumentDirection();
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("dir", direction);
  }
  for (const listener of listeners) listener();
}

/** Derives the document direction from the active UI language. */
export function setLanguageDirection(language: string) {
  languageDirection = directionOf(language);
  applyDocumentDirection();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useDocumentDirection(): TextDirection {
  return useSyncExternalStore(subscribe, getDocumentDirection, getDocumentDirection);
}

/**
 * Gives Base UI (keyboard navigation, popup sides, sliders, the data grid) the
 * same direction as `<html dir>`, including inside portals.
 */
export function AppDirectionProvider({ children }: { children: ReactNode }) {
  const direction = useDocumentDirection();
  return <DirectionProvider direction={direction}>{children}</DirectionProvider>;
}

function parseDirection(value: unknown): TextDirection | null {
  return value === "rtl" || value === "ltr" ? value : null;
}

if (import.meta.env.DEV || import.meta.env.VITE_E2E === "true") {
  // `?dir=rtl` on the first load, or `__wealthfolioSetDirection("rtl")` at
  // runtime (`null` returns to the language's direction). Both are stripped
  // from production builds, except the E2E build (`VITE_E2E=true`).
  if (typeof window !== "undefined") {
    developmentOverride = parseDirection(new URLSearchParams(window.location.search).get("dir"));
  }
  Object.defineProperty(globalThis, "__wealthfolioSetDirection", {
    configurable: true,
    enumerable: false,
    writable: false,
    value: (direction: TextDirection | null) => {
      developmentOverride = parseDirection(direction);
      applyDocumentDirection();
    },
  });
}

applyDocumentDirection();
