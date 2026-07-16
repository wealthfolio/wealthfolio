export interface SandboxAddonFile {
  name: string;
  content: string;
  isMain?: boolean;
}

const ADDON_STYLE_ATTRIBUTE = "data-wealthfolio-addon-style";

export function isCssFile(path: string) {
  return path.toLowerCase().endsWith(".css");
}

function findAddonStyleElement(path: string) {
  return Array.from(
    document.head.querySelectorAll<HTMLStyleElement>(`style[${ADDON_STYLE_ATTRIBUTE}]`),
  ).find((element) => element.getAttribute(ADDON_STYLE_ATTRIBUTE) === path);
}

export function installAddonStyle(path: string, css: string) {
  let styleElement = findAddonStyleElement(path);
  if (!styleElement) {
    styleElement = document.createElement("style");
    styleElement.setAttribute(ADDON_STYLE_ATTRIBUTE, path);
    document.head.appendChild(styleElement);
  }
  styleElement.textContent = css;
}

export function installAddonCssFiles(files: SandboxAddonFile[] = []) {
  clearAddonStyles();
  for (const file of files) {
    if (isCssFile(file.name) && file.content.trim()) {
      installAddonStyle(file.name, file.content);
    }
  }
}

export function clearAddonStyles() {
  for (const styleElement of document.head.querySelectorAll<HTMLStyleElement>(
    `style[${ADDON_STYLE_ATTRIBUTE}]`,
  )) {
    styleElement.remove();
  }
}

export function createCssModuleSource(path: string, css: string) {
  return `
const css = ${JSON.stringify(css)};
const installAddonStyle = globalThis.__wealthfolioInstallAddonStyle;
if (typeof installAddonStyle === "function") {
  installAddonStyle(${JSON.stringify(path)}, css);
}
export default css;
`;
}
