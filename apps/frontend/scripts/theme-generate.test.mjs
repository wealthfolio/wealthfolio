import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { generate, loadThemes, requiredTokens } from "./theme-generate.mjs";

const classic = await readFile(
  new URL("../src/themes/definitions/classic.css", import.meta.url),
  "utf8",
);

// A complete non-base theme: every required role in both modes.
function theme(name, extra = "", { dark = "" } = {}) {
  const roles = requiredTokens.map((token) => `  --${token}: #123456;`).join("\n");
  return `/* @name ${name} */\n:root {\n${roles}\n${extra}\n}\n.dark {\n${roles}\n${dark}\n}\n`;
}

async function workspace(t, files) {
  const dir = await mkdtemp(path.join(tmpdir(), "wealthfolio-themes-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "classic.css"), classic);
  for (const [name, source] of Object.entries(files)) await writeFile(path.join(dir, name), source);
  return dir;
}

test("scopes Classic to :root and other themes to their data-theme", async (t) => {
  const dir = await workspace(t, { "example.css": theme("Example") });
  const out = path.join(dir, "out");
  const themes = await generate({ dir, out });
  assert.deepEqual(
    themes.map(({ id }) => id),
    ["classic", "example"],
  );
  const css = await readFile(path.join(out, "themes.css"), "utf8");
  assert.match(css, /^:root \{$/m);
  assert.match(css, /^\.dark \{$/m);
  assert.match(css, /^:root\[data-theme="example"\] \{$/m);
  assert.match(css, /^:root\[data-theme="example"\]\.dark \{$/m);
  assert.match(
    await readFile(path.join(out, "registry.ts"), "utf8"),
    /\{ id: "classic", name: "Classic", font: "font-mono" \},\s+\{ id: "example", name: "Example" \}/,
  );
  await generate({ dir, out, check: true });
  await rm(path.join(dir, "example.css"));
  await assert.rejects(generate({ dir, out, check: true }), /stale/);
});

test("rejects themes the generator cannot vouch for", async (t) => {
  const cases = [
    ["Bad-ID", theme("Bad"), /Unsafe theme filename/],
    ["duplicate", theme("Classic"), /Duplicate theme name/],
    ["no-dark", theme("No dark").replace(/\.dark \{[^}]*\}/, ".dark {}"), /missing required/],
    ["typo", theme("Typo", "  --backgruond: #fff;"), /Classic does not define --backgruond/],
    ["selector", theme("Selector") + "body { color: red; }", /only :root and \.dark/],
    ["import", '@import "https://example.com/a.css";\n' + theme("Import"), /only :root/],
    ["url", theme("Url", "  --background: url(https://example.com);"), /unsupported/],
    ["important", theme("Important", "  --background: #fff !important;"), /unsupported/],
    ["font-route", theme("Route", "  --font-sans: var(--font-mono);"), /route it to --font-mono/],
    ["class-rule", theme("Class") + ':root [class*="uppercase"] { color: red; }', /not by class/],
    ["radix-rule", theme("Radix") + ':root [data-state="checked"] { color: red; }', /Radix/],
    ["global-rule", theme("Global") + "h1, :root h2 { color: red; }", /only :root/],
  ];
  for (const [id, source, error] of cases) {
    const dir = await workspace(t, { [`${id}.css`]: source });
    await assert.rejects(loadThemes(dir), error, id);
  }
});

test("each miniature carries every value, whatever theme is selected", async (t) => {
  const dir = await workspace(t, {
    "example.css": theme("Example", "  --chart-stone: #abcdef;"),
  });
  const out = path.join(dir, "out");
  await generate({ dir, out });
  const css = await readFile(path.join(out, "themes.css"), "utf8");
  const block = (selector) =>
    css.slice(css.indexOf(`${selector} {`), css.indexOf("}", css.indexOf(`${selector} {`)));
  const light = block('\n[data-theme-preview="example"]');
  const dark = block('.dark [data-theme-preview="example"]');
  // Its own values, Classic's for the rest (status surfaces), and the default fonts.
  assert.match(light, /--background: #123456;/);
  assert.match(light, /--success-subtle: var\(--color-green-50\);/);
  assert.match(light, /--font-sans:\s+"Inter Variable", "Inter", "Rubik Arabic"/);
  // Classic's dark values, except where the theme sets one in light mode.
  assert.match(dark, /--success-subtle: var\(--color-green-950\);/);
  assert.doesNotMatch(dark, /--chart-stone/);
  // Classic's own miniature keeps its whole dark mode.
  assert.match(block('.dark [data-theme-preview="classic"]'), /--chart-stone: hsl/);
});

test("theme rules are element defaults below every class, never in Classic", async (t) => {
  const rules = ".dark h1, :root h2 { font-weight: 600; }";
  const dir = await workspace(t, { "example.css": theme("Example") + rules });
  const out = path.join(dir, "out");
  await generate({ dir, out });
  const css = await readFile(path.join(out, "themes.css"), "utf8");
  const layer = css.slice(css.indexOf("@layer base {"));
  assert.match(
    layer,
    /^ {2}:root\[data-theme="example"\]\.dark h1,\n {2}:root\[data-theme="example"\] h2 \{$/m,
  );
  assert.equal(css.indexOf("h2 {"), css.indexOf("@layer base {") + layer.indexOf("h2 {"));
  const component = await workspace(t, {
    "component.css": theme("Component") + ':root [data-slot="card"] { border-width: 0; }',
  });
  await assert.rejects(loadThemes(component), /through the tokens it reads/);
  const classic = await workspace(t, {});
  await writeFile(
    path.join(classic, "classic.css"),
    (await readFile(path.join(dir, "classic.css"), "utf8")) + rules,
  );
  await assert.rejects(loadThemes(classic), /base theme holds variables only/);
});

test("font stacks keep Rubik Arabic ahead of fonts that draw Arabic", async (t) => {
  const stack = (value) => theme("Fonts", `  --font-sans: ${value};`);
  const accepted = [
    '"Inter Variable", "Inter", "Rubik Arabic", ui-sans-serif, system-ui, sans-serif',
    '"Rubik Arabic", -apple-system, BlinkMacSystemFont, system-ui, sans-serif',
  ];
  for (const value of accepted) {
    const dir = await workspace(t, { "fonts.css": stack(value) });
    await loadThemes(dir);
  }
  const rejected = [
    // Without Rubik, Arabic falls back to a system font.
    '"Inter Variable", "Inter", ui-sans-serif, system-ui, sans-serif',
    // A system font before Rubik draws Arabic itself.
    '-apple-system, "Rubik Arabic", system-ui, sans-serif',
    // A sans role must still end with a sans generic.
    '"Inter", "Rubik Arabic", serif',
  ];
  for (const value of rejected) {
    const dir = await workspace(t, { "fonts.css": stack(value) });
    await assert.rejects(loadThemes(dir), /--font-sans must/, value);
  }
  // Dark mode inherits a light stack, and a stack reached through a helper
  // variable is checked too.
  const dir = await workspace(t, {
    "fonts.css": theme("Fonts", "  --chart-stone: #000;", {
      dark: '  --chart-stone: "Inter", serif;\n  --font-serif: var(--chart-stone);',
    }),
  });
  await assert.rejects(loadThemes(dir), /fonts\/dark: --font-serif must list "Rubik Arabic"/);
});

test("the committed themes are valid and the output is current", async () => {
  const themes = await generate({ check: true });
  assert.equal(themes[0].id, "classic");
  assert.equal(themes.length, 1);
});
