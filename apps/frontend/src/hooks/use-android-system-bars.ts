import { useEffect } from "react";

interface AndroidBridge {
  postMessage: (message: string) => void;
  onmessage: ((event: MessageEvent<string>) => void) | null;
}

/**
 * The Android app draws edge-to-edge, but its WebView reports no bottom safe area. Its
 * bridge (MainActivity.kt, only on the app's own pages) sends the navigation bar's
 * height, kept as `--android-navigation-bar-inset` and folded into `--inset-bottom`, and
 * takes the app's light or dark theme, so the system bar icons stay readable over it.
 */
export function useAndroidSystemBars() {
  useEffect(() => {
    const bridge = (window as { WealthfolioAndroid?: AndroidBridge }).WealthfolioAndroid;
    if (!bridge) return;
    const root = document.documentElement;

    bridge.onmessage = (event) => {
      const inset = Number(event.data);
      if (Number.isFinite(inset)) {
        root.style.setProperty("--android-navigation-bar-inset", `${inset}px`);
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
