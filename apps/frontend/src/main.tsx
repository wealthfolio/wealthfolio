import { isTauri, getPlatform, openUrlInBrowser } from "@/adapters";
import React from "react";
import { ExternalLinkProvider } from "@wealthfolio/ui/components/ui/external-link";
import { StartupBoundary } from "@/components/startup-boundary";
import { StartupScreen } from "@/components/startup-screen";
import ReactDOM from "react-dom/client";
import { debugAddonState, isAddonDevModeEnabled } from "./addons/addons-loader";
import App from "./App";
import "./globals.css";
import { installLinuxUndoRedo } from "./linux-undo-redo";
// Initialize i18next before the app renders. The active language is applied
// from the stored user setting by the settings provider.
import "./i18n/i18n";

if (isAddonDevModeEnabled) {
  void import("./addons/addons-dev-mode");
} else if (isTauri && !import.meta.env.DEV) {
  // Lockdown is for desktop OSes only; keep text selection and gestures on iOS/Android.
  void getPlatform().then(async (platform) => {
    if (!platform.is_mobile) {
      const { installLockdown } = await import("./lockdown");
      installLockdown();
    }
  });
}

if (isTauri) {
  void getPlatform().then((platform) => {
    if (platform.os === "linux") installLinuxUndoRedo();
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
    <StartupBoundary>
      <React.Suspense fallback={<StartupScreen />}>
        <ExternalLinkProvider openUrl={openUrlInBrowser}>
          <App />
        </ExternalLinkProvider>
      </React.Suspense>
    </StartupBoundary>
  </React.StrictMode>,
);
