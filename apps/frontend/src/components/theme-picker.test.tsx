import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import postcss from "postcss";
import { describe, expect, it, vi } from "vitest";
import { ThemePicker } from "@/components/theme-picker";
import previewTokens from "@/components/theme-preview-tokens.json";
import { fontLabelKeys, themeSelectionUpdate, type FontRole } from "@/themes/selection";
import { themes } from "@/themes/themes";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/**
 * The theme tokens each Tailwind class reads, from Tailwind's own output for
 * globals.css's theme, variants and utilities: `rounded-md` reads --radius,
 * `bg-foreground/45` --foreground, `font-mono` --font-mono.
 */
async function classReads(classes: string[]) {
  const require = createRequire(import.meta.url);
  const { compile } = require("tailwindcss") as typeof import("tailwindcss");
  const theme = postcss
    .parse(source("../globals.css"))
    .nodes.filter(
      (node): node is postcss.AtRule =>
        node.type === "atrule" && ["theme", "custom-variant", "utility"].includes(node.name),
    )
    .map((rule) => (rule.nodes ? rule.toString() : `${rule.toString()};`));
  const compiler = await compile(
    [
      '@import "tailwindcss/theme.css" layer(theme);',
      '@import "tailwindcss/utilities.css" layer(utilities);',
      ...theme,
    ].join("\n"),
    {
      loadStylesheet: async (id, base) => {
        const path = require.resolve(id);
        return { path, base, content: readFileSync(path, "utf8") };
      },
    },
  );
  const reads = new Map<string, { tokens: Set<string>; properties: Set<string> }>();
  postcss.parse(compiler.build(classes)).walkRules((rule) => {
    const name = /^\.((?:\\.|[\w-])+)/.exec(rule.selector)?.[1].replace(/\\(.)/g, "$1");
    if (!name) return;
    const entry = reads.get(name) ?? { tokens: new Set(), properties: new Set() };
    rule.walkDecls((decl) => {
      entry.properties.add(decl.prop);
      for (const [, token] of decl.value.matchAll(/var\(\s*--([\w-]+)/g)) entry.tokens.add(token);
    });
    reads.set(name, entry);
  });
  return reads;
}

describe("ThemePicker", () => {
  it("offers every theme, Classic first, and checks the saved one", () => {
    render(<ThemePicker value="ember" onChange={vi.fn()} />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => (radio as HTMLInputElement).value)).toEqual(
      themes.map(({ id }) => id),
    );
    expect(radios[0]).toHaveAccessibleName("Classic");
    expect(screen.getByRole("radio", { name: /Ember/ })).toBeChecked();
  });

  it("checks Classic for a missing or unknown theme", () => {
    const { rerender } = render(<ThemePicker onChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "Classic" })).toBeChecked();
    rerender(<ThemePicker value="from-a-newer-version" onChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "Classic" })).toBeChecked();
  });

  it("reports the picked theme and describes the mode a theme is designed for", () => {
    const onChange = vi.fn();
    render(<ThemePicker value="classic" onChange={onChange} />);
    const terminal = screen.getByRole("radio", { name: /Terminal/ });
    expect(terminal).toHaveAccessibleDescription("Terminal is designed for dark mode.");
    fireEvent.click(terminal);
    expect(onChange).toHaveBeenCalledWith("terminal");
  });

  it("draws each miniature in its own theme", () => {
    const { container } = render(<ThemePicker value="classic" onChange={vi.fn()} />);
    expect(
      [...container.querySelectorAll("[data-theme-preview]")].map((preview) =>
        preview.getAttribute("data-theme-preview"),
      ),
    ).toEqual(themes.map(({ id }) => id));
  });

  it("draws each miniature in a font role, the theme's or the user's", () => {
    const { container } = render(
      <ThemePicker value="cupertino" font="font-serif" onChange={vi.fn()} />,
    );
    const fonts = Object.fromEntries(
      [...container.querySelectorAll("[data-theme-preview]")].map((preview) => [
        preview.getAttribute("data-theme-preview"),
        ["font-sans", "font-serif", "font-mono"].find((role) => preview.classList.contains(role)),
      ]),
    );
    expect(fonts).toEqual({
      classic: "font-mono",
      ember: "font-serif",
      signature: "font-sans",
      cupertino: "font-sans",
      newspaper: "font-serif",
      cyber: "font-serif",
      terminal: "font-mono",
    });
  });
});

describe("theme-preview-tokens.json", () => {
  // The theme CSS gives a miniature only the listed tokens (and those their values
  // read). A token it draws but the list leaves out would show the selected
  // theme's value instead, so the list must match what the miniatures draw.
  it("lists every theme token a miniature draws, and nothing else", async () => {
    const elements: Element[] = [];
    for (const font of Object.keys(fontLabelKeys) as FontRole[]) {
      const { container } = render(<ThemePicker value="classic" font={font} onChange={vi.fn()} />);
      for (const preview of container.querySelectorAll("[data-theme-preview]"))
        elements.push(preview, ...preview.querySelectorAll("*"));
    }
    const classesOf = (element: Element) =>
      (element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    const reads = await classReads([...new Set(elements.flatMap(classesOf))]);
    // Classic defines every theme token; the font roles come from globals.css.
    const themeTokens = new Set([
      ...Object.keys(fontLabelKeys),
      ...[...source("../themes/definitions/classic.css").matchAll(/^\s*--([\w-]+)\s*:/gm)].map(
        ([, token]) => token,
      ),
    ]);

    const drawn = new Set<string>();
    for (const element of elements) {
      const classes = classesOf(element).map((name) => reads.get(name));
      for (const entry of classes) for (const token of entry?.tokens ?? []) drawn.add(token);
      for (const attribute of element.attributes)
        for (const [, token] of attribute.value.matchAll(/var\(\s*--([\w-]+)/g)) drawn.add(token);
      // globals.css gives every element border-color: var(--border).
      const sets = (property: RegExp) =>
        classes.some((entry) => [...(entry?.properties ?? [])].some((name) => property.test(name)));
      if (sets(/^border(-[a-z]+)*-width$/) && !sets(/^border(-[a-z]+)*-color$/))
        drawn.add("border");
    }
    expect([...drawn].filter((token) => themeTokens.has(token)).sort()).toEqual(
      [...previewTokens].sort(),
    );
  });
});

describe("themeSelectionUpdate", () => {
  it("saves the theme with the font it suggests, never the mode", () => {
    expect(themeSelectionUpdate("cupertino")).toEqual({
      themeId: "cupertino",
      font: "font-sans",
    });
    expect(themeSelectionUpdate("ember")).toEqual({ themeId: "ember" });
  });
});
