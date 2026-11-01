/**
 * Text size, saved per device once picked. Each name scales the root font size, and with it
 * every size in rem: text, spacing and controls grow together. The percentages
 * live in globals.css under `:root[data-text-size]`, and the CSS shows the
 * default size for a name it doesn't know.
 */
export const textSizes = ["small", "default", "large", "extra-large"] as const;

export type TextSize = (typeof textSizes)[number];

export const DEFAULT_TEXT_SIZE: TextSize = "default";

/** Caches the size for index.html, which applies it before the app loads. */
export const TEXT_SIZE_STORAGE_KEY = "wealthfolio-text-size";

export const textSizeLabelKeys = {
  small: "settings:appearance_text_size_small",
  default: "settings:appearance_text_size_default",
  large: "settings:appearance_text_size_large",
  "extra-large": "settings:appearance_text_size_extra_large",
} as const satisfies Record<TextSize, string>;

/** Each size's root font size, as globals.css sets it (a test keeps the two equal). */
export const textSizeScales = {
  small: 0.875,
  default: 1,
  large: 1.15,
  "extra-large": 1.3,
} as const satisfies Record<TextSize, number>;

/**
 * The operating system's font scale, where the app knows one. Android's
 * MainActivity sets this global before the page loads and turns off the
 * WebView's own text zoom, so the size reaches the app only through here. On
 * iOS the app measures Dynamic Type itself (`measureDynamicTypeScale`) and sets
 * it with `setSystemTextScale`.
 */
export const SYSTEM_TEXT_SCALE_GLOBAL = "wealthfolioSystemTextScale";

/** Dynamic Type's body text size at iOS's default text size ("Large"). */
const DYNAMIC_TYPE_DEFAULT_BODY_PX = 17;

/**
 * iOS's text size (Dynamic Type) as a scale. WKWebView doesn't apply it to page
 * text, but the `-apple-system-body` font follows it: 17 px at the default size,
 * up to 53 px at the largest accessibility size. Undefined in engines that don't
 * know the keyword.
 */
export function measureDynamicTypeScale(): number | undefined {
  if (typeof document === "undefined" || !document.body) return undefined;
  const probe = document.createElement("span");
  probe.style.font = "-apple-system-body";
  if (!probe.style.font) return undefined;
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const size = Number.parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  return Number.isFinite(size) && size > 0 ? size / DYNAMIC_TYPE_DEFAULT_BODY_PX : undefined;
}

/** Records a font scale the app measured itself (iOS); undefined clears it. */
export function setSystemTextScale(scale: number | undefined) {
  if (typeof window === "undefined") return;
  const scope = window as unknown as Record<string, unknown>;
  if (scope[SYSTEM_TEXT_SCALE_GLOBAL] === scale) return;
  if (scale === undefined) delete scope[SYSTEM_TEXT_SCALE_GLOBAL];
  else scope[SYSTEM_TEXT_SCALE_GLOBAL] = scale;
  for (const listener of systemTextScaleListeners) listener();
}

const systemTextScaleListeners = new Set<() => void>();

/**
 * Notifies when the app records a new system font scale (iOS re-measures it on
 * returning to the foreground), for `useSyncExternalStore`, so what shows the
 * size in effect re-renders with it.
 */
export function subscribeSystemTextScale(listener: () => void) {
  systemTextScaleListeners.add(listener);
  return () => {
    systemTextScaleListeners.delete(listener);
  };
}

export function isTextSize(value: unknown): value is TextSize {
  return typeof value === "string" && (textSizes as readonly string[]).includes(value);
}

export function systemTextScale(): number | undefined {
  if (typeof window === "undefined") return undefined;
  const scale = (window as unknown as Record<string, unknown>)[SYSTEM_TEXT_SCALE_GLOBAL];
  return typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : undefined;
}

/** The size nearest to a font scale; scales past the largest size get the largest. */
export function textSizeForScale(scale: number): TextSize {
  let nearest: TextSize = DEFAULT_TEXT_SIZE;
  for (const size of textSizes) {
    if (Math.abs(textSizeScales[size] - scale) < Math.abs(textSizeScales[nearest] - scale)) {
      nearest = size;
    }
  }
  return nearest;
}

/**
 * The size in effect: the saved one; until one is saved, the size nearest to the
 * system's font scale (Android, iOS), else the default. A name unknown to this version
 * shows the default.
 */
export function resolveTextSize(value: unknown): TextSize {
  if (value === undefined || value === null) {
    const scale = systemTextScale();
    return scale === undefined ? DEFAULT_TEXT_SIZE : textSizeForScale(scale);
  }
  return isTextSize(value) ? value : DEFAULT_TEXT_SIZE;
}
