export interface AddonThemeSnapshot {
  backgroundColor: string;
  colorScheme: string;
  cssVariables: Record<string, string>;
  fontClass?: string;
  fontFamily: string;
  foregroundColor: string;
  themeClass: "light" | "dark";
}

const FONT_CLASSES = ["font-mono", "font-sans", "font-serif"] as const;
const appliedHostCssVariables = new Set<string>();

export function collectAddonThemeSnapshot(): AddonThemeSnapshot {
  const rootStyle = getComputedStyle(document.documentElement);
  const bodyStyle = getComputedStyle(document.body);
  const themeClass = document.documentElement.classList.contains("dark") ? "dark" : "light";
  const cssVariables: Record<string, string> = {};

  for (let index = 0; index < rootStyle.length; index += 1) {
    const propertyName = rootStyle.item(index);
    if (propertyName.startsWith("--")) {
      cssVariables[propertyName] = rootStyle.getPropertyValue(propertyName).trim();
    }
  }

  return {
    backgroundColor: bodyStyle.backgroundColor || rootStyle.backgroundColor || "transparent",
    colorScheme: rootStyle.colorScheme || themeClass,
    cssVariables,
    fontClass: FONT_CLASSES.find((className) => document.body.classList.contains(className)),
    fontFamily: bodyStyle.fontFamily || rootStyle.fontFamily,
    foregroundColor: bodyStyle.color || rootStyle.color || "inherit",
    themeClass,
  };
}

export function applyHostTheme(theme?: Partial<AddonThemeSnapshot>) {
  if (!theme) {
    return;
  }

  const htmlElement = document.documentElement;
  if (theme.themeClass) {
    htmlElement.classList.remove("light", "dark");
    htmlElement.classList.add(theme.themeClass);
  }
  if (theme.colorScheme) {
    htmlElement.style.colorScheme = theme.colorScheme;
  }

  // Refresh the snapshot fallbacks too. These are seeded once from URL params at
  // addon start (before the app's real theme resolves), so without this they can
  // stay stuck on a dark startup value even after the app settles on light.
  if (theme.backgroundColor) {
    htmlElement.style.setProperty("--addon-initial-background", theme.backgroundColor);
  }
  if (theme.foregroundColor) {
    htmlElement.style.setProperty("--addon-initial-foreground", theme.foregroundColor);
  }

  document.body.classList.remove(...FONT_CLASSES);
  if (theme.fontClass && FONT_CLASSES.includes(theme.fontClass as (typeof FONT_CLASSES)[number])) {
    document.body.classList.add(theme.fontClass);
  }
  if (theme.fontFamily) {
    document.body.style.fontFamily = theme.fontFamily;
  }

  const nextCssVariables = new Set(Object.keys(theme.cssVariables ?? {}));
  for (const propertyName of appliedHostCssVariables) {
    if (!nextCssVariables.has(propertyName)) {
      htmlElement.style.removeProperty(propertyName);
    }
  }
  for (const [propertyName, value] of Object.entries(theme.cssVariables ?? {})) {
    if (propertyName.startsWith("--")) {
      htmlElement.style.setProperty(propertyName, value);
    }
  }

  appliedHostCssVariables.clear();
  for (const propertyName of nextCssVariables) {
    appliedHostCssVariables.add(propertyName);
  }
}
