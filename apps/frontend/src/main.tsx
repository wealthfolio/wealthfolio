import { isDesktop, getPlatform } from "@/adapters";
import React from "react";
import ReactDOM from "react-dom/client";
import { debugAddonState, isAddonDevModeEnabled } from "./addons/addons-loader";
import App from "./App";
import "./globals.css";
// Initialize i18next before the app renders. The active language is applied
// from the stored user setting by the settings provider.
import "./i18n/i18n";

if (isAddonDevModeEnabled) {
  void import("./addons/addons-dev-mode");
} else if (isDesktop && !import.meta.env.DEV) {
  // Only install lockdown on actual desktop platforms (not iOS/Android running in Tauri).
  // `isDesktop` is a compile-time constant that is true for ALL Tauri builds, so we
  // check the runtime platform to avoid disabling text selection and gestures on mobile.
  void getPlatform().then(async (platform) => {
    if (!platform.is_mobile) {
      const { installLockdown } = await import("./lockdown");
      installLockdown();
    }
  });
}

if (import.meta.env.DEV) {
  Object.defineProperty(globalThis, "debugAddons", {
    configurable: true,
    enumerable: false,
    value: debugAddonState,
    writable: false,
  });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {/* Suspense boundary for i18next lazy-loaded translation resources: the auth
        layer reads translations before any route-level boundary, so a top-level
        boundary prevents a cold-load suspend from blanking the app. */}
    <React.Suspense fallback={null}>
      <App />
    </React.Suspense>
  </React.StrictMode>,
);
