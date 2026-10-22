#!/usr/bin/env node
// Builds src/themes/generated/themes.css and the picker's registry.ts from the
// theme definitions in src/themes/definitions/. Classic is the base: it applies on :root and .dark,
// so every other theme, scoped to :root[data-theme="<id>"], inherits Classic's
// value for any role it leaves out, and an unknown theme ID shows Classic. Each
// theme also applies to [data-theme-preview="<id>"], so the picker can draw it
// in the current mode.
// Readability (the colour contract) is checked in the browser by
// e2e/design-system/colors.spec.ts for every theme. `--check` fails when the
// committed output is stale.
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { format, resolveConfig } from "prettier";

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const definitionsDir = resolve(frontend, "src/themes/definitions");
export const outputDir = resolve(frontend, "src/themes/generated");
const globalsPath = resolve(frontend, "src/globals.css");

export const baseTheme = "classic";
// The picker's order; themes not listed follow alphabetically.
export const themeOrder = [
  "classic",
  "signature",
  "ember",
  "cupertino",
  "newspaper",
  "cyber",
  "terminal",
];

// Roles every theme sets itself, in both modes, rather than inheriting Classic's.
// Classic sets them on :root only; its .dark block changes the Flexoki values
// they are built from.
export const requiredTokens = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
];

export const fontRoles = ["font-sans", "font-serif", "font-mono"];
// Mode a theme is designed for (/* @mode dark */); every theme keeps both modes.
export const suggestedModes = ["light", "dark"];
const fontGenerics = {
  "font-sans": ["sans-serif", "system-ui"],
  "font-serif": ["serif"],
  "font-mono": ["monospace"],
};
// Fonts the app ships (globals.css). None has Arabic letters, so they may come
// before "Rubik Arabic"; any other family could draw Arabic itself, or is a
// system font that would, so Rubik must come first.
const bundledFonts = ['"Inter Variable"', '"Inter"', '"Merriweather"', '"JetBrains Mono"'];
const arabicFont = '"Rubik Arabic"';

// Theme files hold custom properties on :root and .dark, and element defaults
// (`:root body`, `.dark h1`). A theme changes a component's look through the
// tokens the component reads (classic.css lists them), never with a rule: the
// generated rules sit in @layer base, below every utility class, so a class on
// the element always wins and a rule can't restyle a component. Rules may not
// select components (data-slot, data-variant, data-size), class substrings,
// inline styles or Radix attributes. Imports, other selectors and nested rules
// are not theme inputs.
const ruleSelector = /^(?::root|\.dark)\s+\S/;
const componentSelector = /data-(?:slot|variant|size)\b/;
const fragileSelector = /\[(?:class|style)\b|data-state|data-radix/;

function readThemeCss(source, filename) {
  const root = postcss.parse(source, { from: filename });
  const modes = { light: {}, dark: {} };
  const rules = [];
  root.each((node) => {
    if (node.type === "comment") return;
    if (node.type !== "rule")
      throw new Error(`${filename}: only :root and .dark rules are supported`);
    const selectors = postcss.list.comma(node.selector);
    const variables = selectors.length === 1 && [":root", ".dark"].includes(selectors[0]);
    if (!variables && !selectors.every((selector) => ruleSelector.test(selector)))
      throw new Error(`${filename}: only :root and .dark rules are supported (${node.selector})`);
    if (!variables && selectors.some((selector) => componentSelector.test(selector)))
      throw new Error(
        `${filename}: theme a component through the tokens it reads (classic.css), not a rule (${node.selector})`,
      );
    if (!variables && selectors.some((selector) => fragileSelector.test(selector)))
      throw new Error(
        `${filename}: select by element, role or ARIA, not by class, style or Radix attributes (${node.selector})`,
      );
    node.each((decl) => {
      if (decl.type === "comment") return;
      if (
        decl.type !== "decl" ||
        decl.important ||
        (variables && !/^--[a-z][a-z0-9-]*$/.test(decl.prop)) ||
        /url\s*\(|expression\s*\(/i.test(decl.value)
      )
        throw new Error(`${filename}: unsupported declaration ${decl.toString()}`);
      if (variables)
        modes[node.selector === ":root" ? "light" : "dark"][decl.prop.slice(2)] = decl.value;
    });
    if (!variables) rules.push(node);
  });
  return { ...modes, rules };
}

function resolveFontStack(role, values, path = []) {
  if (path.includes(role)) throw new Error(`circular reference ${[...path, role].join(" -> ")}`);
  const value = values[role];
  const alias = /^var\(--([a-z][a-z0-9-]*)\)$/.exec(value);
  if (!alias) return value;
  if (fontRoles.includes(alias[1]))
    throw new Error(`--${role} may change the role's typeface, not route it to --${alias[1]}`);
  return resolveFontStack(alias[1], values, [...path, role]);
}

function checkFontStack(role, stack) {
  const families = postcss.list.comma(stack);
  if (!fontGenerics[role].includes(families.at(-1)))
    throw new Error(`--${role} must end with ${fontGenerics[role].join(" or ")}`);
  const arabic = families.indexOf(arabicFont);
  if (arabic < 0 || families.slice(0, arabic).some((family) => !bundledFonts.includes(family)))
    throw new Error(
      `--${role} must list ${arabicFont} before any font that is not bundled ` +
        `(${bundledFonts.join(", ")}), or Arabic falls back to a system font`,
    );
}

export async function loadThemes(dir = definitionsDir) {
  const themes = [];
  const names = new Set();
  for (const filename of (await readdir(dir)).filter((name) => name.endsWith(".css")).sort()) {
    const id = filename.slice(0, -4);
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) || id.length > 48)
      throw new Error(`Unsafe theme filename: ${filename}`);
    const source = await readFile(resolve(dir, filename), "utf8");
    const name = /\/\*\s*@name\s+([^*]+)\*\//.exec(source)?.[1].trim() ?? id;
    if (!name || name.length > 60 || /[<>]/.test(name) || /\p{Cc}/u.test(name))
      throw new Error(`${id}: invalid theme name`);
    if (names.has(name.toLowerCase())) throw new Error(`Duplicate theme name: ${name}`);
    names.add(name.toLowerCase());
    const font = /\/\*\s*@font\s+([^*]+?)\s*\*\//.exec(source)?.[1];
    if (font !== undefined && !fontRoles.includes(font))
      throw new Error(`${id}: @font must be one of ${fontRoles.join(", ")}`);
    const mode = /\/\*\s*@mode\s+([^*]+?)\s*\*\//.exec(source)?.[1];
    if (mode !== undefined && !suggestedModes.includes(mode))
      throw new Error(`${id}: @mode must be one of ${suggestedModes.join(", ")}`);
    themes.push({ id, name, font, mode, ...readThemeCss(source, filename) });
  }

  const base = themes.find(({ id }) => id === baseTheme);
  if (!base) throw new Error(`Required base theme ${baseTheme} is missing`);
  // A theme may set only what Classic sets, so every role has a fallback and a
  // misspelt name fails here instead of silently doing nothing. Fonts come from
  // globals.css, not from Classic.
  if (base.rules.length)
    throw new Error(
      `${baseTheme}: the base theme holds variables only; its rules would reach every theme`,
    );
  const known = new Set([...Object.keys(base.light), ...Object.keys(base.dark), ...fontRoles]);
  for (const theme of themes) {
    for (const mode of ["light", "dark"]) {
      const unknown = Object.keys(theme[mode]).filter((token) => !known.has(token));
      if (unknown.length)
        throw new Error(
          `${theme.id}/${mode}: Classic does not define ${unknown.map((token) => `--${token}`).join(", ")}`,
        );
      // Dark mode inherits the theme's light values, as the cascade does.
      const values = { ...theme.light, ...(mode === "dark" ? theme.dark : {}) };
      // Classic's dark mode swaps the Flexoki values its roles are built from.
      const missing =
        theme === base && mode === "dark"
          ? []
          : requiredTokens.filter((token) => !Object.hasOwn(theme[mode], token));
      if (missing.length)
        throw new Error(`${theme.id}/${mode}: missing required tokens: ${missing.join(", ")}`);
      for (const role of fontRoles) {
        if (values[role] === undefined) continue;
        try {
          checkFontStack(role, resolveFontStack(role, values));
        } catch (error) {
          throw new Error(`${theme.id}/${mode}: ${error.message}`);
        }
      }
    }
  }
  const rank = ({ id }) => (themeOrder.includes(id) ? themeOrder.indexOf(id) : themeOrder.length);
  return themes.sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : 1));
}

function block(selector, values) {
  const lines = Object.entries(values).map(([token, value]) => `  --${token}: ${value};`);
  return lines.length ? `${selector} {\n${lines.join("\n")}\n}` : "";
}

// The default font stacks, from globals.css's @theme. A miniature in the picker
// sets them, so it never shows the selected theme's fonts.
export async function loadFontDefaults(path = globalsPath) {
  const values = {};
  postcss.parse(await readFile(path, "utf8")).walkAtRules("theme", (rule) => {
    if (rule.params) return;
    rule.each((decl) => {
      if (decl.type === "decl" && fontRoles.includes(decl.prop.slice(2)))
        values[decl.prop.slice(2)] = decl.value;
    });
  });
  const missing = fontRoles.filter((role) => !values[role]);
  if (missing.length) throw new Error(`${path}: @theme is missing ${missing.join(", ")}`);
  return values;
}

export function renderCss(themes, fonts) {
  const base = themes.find(({ id }) => id === baseTheme);
  const blocks = themes.flatMap((theme) => {
    const scope = theme.id === baseTheme ? ":root" : `:root[data-theme="${theme.id}"]`;
    // A miniature (data-theme-preview) sits inside whatever theme is selected,
    // so it carries every value itself: the default fonts and Classic's roles,
    // then its own. In dark mode Classic's dark values apply only where the
    // theme sets nothing in light, as the cascade does on :root.
    const preview = `[data-theme-preview="${theme.id}"]`;
    const inheritedDark =
      theme === base
        ? {}
        : Object.fromEntries(
            Object.entries(base.dark).filter(([token]) => !Object.hasOwn(theme.light, token)),
          );
    return [
      block(scope, theme.light),
      block(theme.id === baseTheme ? ".dark" : `${scope}.dark`, theme.dark),
      block(preview, { ...fonts, ...base.light, ...theme.light }),
      block(`.dark ${preview}`, { ...inheritedDark, ...theme.dark }),
    ];
  });
  // Rules apply in their theme only; `.dark` rules in its dark mode.
  const rules = themes.flatMap((theme) =>
    theme.rules.map((rule) => {
      const scoped = rule.clone();
      scoped.selector = postcss.list
        .comma(rule.selector)
        .map((selector) =>
          selector.replace(
            /^(:root|\.dark)\s+/,
            (prefix) =>
              `:root[data-theme="${theme.id}"]${prefix.startsWith(".dark") ? ".dark" : ""} `,
          ),
        )
        .join(", ");
      return scoped.toString();
    }),
  );
  return (
    "/* Generated by scripts/theme-generate.mjs from src/themes/definitions. Do not edit. */\n" +
    blocks.filter(Boolean).join("\n\n") +
    (rules.length
      ? `\n\n/* Element defaults: below every utility class. */\n@layer base {\n${rules.join("\n\n")}\n}`
      : "") +
    "\n"
  );
}

export function renderRegistry(themes) {
  const entries = themes.map(({ id, name, font, mode }) => ({ id, name, font, mode }));
  return `// Generated by scripts/theme-generate.mjs from src/themes/definitions. Do not edit.
export interface ThemeDefinition {
  id: string;
  name: string;
  /** Font the theme suggests; choosing the theme applies it to the Font setting. */
  font?: ${fontRoles.map((role) => JSON.stringify(role)).join(" | ")};
  /** Mode the theme is designed for; Settings offers it but never applies it. */
  mode?: ${suggestedModes.map((mode) => JSON.stringify(mode)).join(" | ")};
}

/** In picker order; the first is Classic, the base every theme inherits from. */
export const themes: readonly ThemeDefinition[] = ${JSON.stringify(entries)};
`;
}

export async function generate({ check = false, dir = definitionsDir, out = outputDir } = {}) {
  const themes = await loadThemes(dir);
  for (const [name, source] of [
    ["themes.css", renderCss(themes, await loadFontDefaults())],
    ["registry.ts", renderRegistry(themes)],
  ]) {
    const path = resolve(out, name);
    const content = await format(source, { ...(await resolveConfig(path)), filepath: path });
    const current = await readFile(path, "utf8").catch(() => undefined);
    if (current === content) continue;
    if (check) throw new Error(`${path} is stale: run pnpm themes:generate`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return themes;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const themes = await generate({ check: process.argv.includes("--check") });
    console.log(`Validated ${themes.length} themes: ${themes.map(({ id }) => id).join(", ")}.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
