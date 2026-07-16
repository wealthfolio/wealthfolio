import "@testing-library/jest-dom";
import { cleanup } from "@testing-library/react";
import { vi, afterEach } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import enAccount from "@/i18n/locales/en/account.json";
import enActivity from "@/i18n/locales/en/activity.json";
import enCommon from "@/i18n/locales/en/common.json";
import enDashboard from "@/i18n/locales/en/dashboard.json";
import enGoals from "@/i18n/locales/en/goals.json";
import enHoldings from "@/i18n/locales/en/holdings.json";
import enIncome from "@/i18n/locales/en/income.json";
import enPerformance from "@/i18n/locales/en/performance.json";
import enSettings from "@/i18n/locales/en/settings.json";
import enInsights from "@/i18n/locales/en/insights.json";
import enAsset from "@/i18n/locales/en/asset.json";
import enSpending from "@/i18n/locales/en/spending.json";
import enUi from "@/i18n/locales/en/ui.json";
import enAi from "@/i18n/locales/en/ai.json";
import enAllocation from "@/i18n/locales/en/allocation.json";
import enOnboarding from "@/i18n/locales/en/onboarding.json";
import enAuth from "@/i18n/locales/en/auth.json";
import enHealth from "@/i18n/locales/en/health.json";
import enSync from "@/i18n/locales/en/sync.json";
import enConnect from "@/i18n/locales/en/connect.json";

// Initialize i18next synchronously with English resources so `t()` returns real
// copy (not raw keys) in component tests. Uses eager (non-lazy) resources; no
// Suspense so tests render synchronously.
if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    ns: [
      "common",
      "dashboard",
      "holdings",
      "activity",
      "performance",
      "account",
      "settings",
      "goals",
      "income",
      "insights",
      "asset",
      "spending",
      "ui",
      "ai",
      "allocation",
      "onboarding",
      "auth",
      "health",
      "sync",
      "connect",
    ],
    defaultNS: "common",
    resources: {
      en: {
        account: enAccount,
        activity: enActivity,
        common: enCommon,
        dashboard: enDashboard,
        goals: enGoals,
        holdings: enHoldings,
        income: enIncome,
        performance: enPerformance,
        settings: enSettings,
        insights: enInsights,
        asset: enAsset,
        spending: enSpending,
        ui: enUi,
        ai: enAi,
        allocation: enAllocation,
        onboarding: enOnboarding,
        auth: enAuth,
        health: enHealth,
        sync: enSync,
        connect: enConnect,
      },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  });
}

// Extend Vitest's expect method with methods from react-testing-library
expect.extend(matchers);

// Cleanup after each test case (e.g. clearing jsdom)
afterEach(() => {
  cleanup();
});

// Mock window.matchMedia
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(), // deprecated
      removeListener: vi.fn(), // deprecated
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}
