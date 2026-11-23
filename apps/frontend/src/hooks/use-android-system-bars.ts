import { useEffect } from "react";

interface AndroidBridge {
  postMessage: (message: string) => void;
  onmessage: ((event: MessageEvent<string>) => void) | null;
}

/**
 * The Android app draws edge-to-edge, but its WebView reports no bottom safe area. Its
 * bridge (MainActivity.kt, only on the app's own pages) sends the system-bar/cutout
 * edges, folded into the shared `--inset-*` variables, and
 * takes the app's light or dark theme, so the system bar icons stay readable over it.
 */
export function useAndroidSystemBars() {
  useEffect(() => {
    const bridge = (window as { WealthfolioAndroid?: AndroidBridge }).WealthfolioAndroid;
    if (!bridge) return;
    const root = document.documentElement;

    bridge.onmessage = (event) => {
      try {
        const value: unknown = JSON.parse(event.data);
        // Keep compatibility with an older native shell during frontend development.
        const insets = typeof value === "number" ? { bottom: value } : value;
        if (!insets || typeof insets !== "object") return;
        for (const edge of ["top", "right", "bottom", "left"] as const) {
          const inset = (insets as Record<string, unknown>)[edge];
          if (typeof inset === "number" && Number.isFinite(inset) && inset >= 0) {
            root.style.setProperty(`--android-inset-${edge}`, `${inset}px`);
          }
        }
        const imeBottom = (insets as Record<string, unknown>).imeBottom;
        if (typeof imeBottom === "number" && Number.isFinite(imeBottom) && imeBottom >= 0) {
          root.style.setProperty("--keyboard-inset-bottom", `${imeBottom}px`);
        }
      } catch {
        // Ignore malformed messages at the native boundary.
      }
    };
    bridge.postMessage("insets");

    let reported: string | null = null;
    const reportAppearance = () => {
      const appearance = root.classList.contains("dark") ? "appearance:dark" : "appearance:light";
      if (appearance === reported) return;
      reported = appearance;
      bridge.postMessage(appearance);
    };
    reportAppearance();
    const observer = new MutationObserver(reportAppearance);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });

    return () => {
      observer.disconnect();
      bridge.onmessage = null;
    };
  }, []);
}
