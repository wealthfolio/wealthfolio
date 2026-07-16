// @vitest-environment node

import { describe, expect, it } from "vitest";
import { rewriteModuleSpecifiers } from "./addon-module-rewriter";

const replacements: Record<string, string> = {
  "./feature.js": "blob:feature",
  "./side-effect.js": "blob:side-effect",
  "chunk.js": "blob:chunk",
  react: "blob:react",
};

function shouldRewriteStaticSpecifier(specifier: string) {
  return specifier.startsWith(".") || specifier === "react";
}

function rewrite(code: string, importerPath = "dist/addon.js") {
  return rewriteModuleSpecifiers(
    importerPath,
    code,
    (_importerPath, specifier) => replacements[specifier] ?? specifier,
    shouldRewriteStaticSpecifier,
  );
}

describe("addon module rewriter", () => {
  it("rewrites static imports, re-exports, and side-effect imports", () => {
    const source = [
      `import React from "react";`,
      `import { feature } from "./feature.js";`,
      `export { value } from "./feature.js";`,
      `export * from "./feature.js";`,
      `export * as featureModule from "./feature.js";`,
      `import "./side-effect.js";`,
      `import untouched from "other-package";`,
      `import localCollision from "chunk.js";`,
    ].join("\n");

    expect(rewrite(source)).toBe(
      [
        `import React from "blob:react";`,
        `import { feature } from "blob:feature";`,
        `export { value } from "blob:feature";`,
        `export * from "blob:feature";`,
        `export * as featureModule from "blob:feature";`,
        `import "blob:side-effect";`,
        `import untouched from "other-package";`,
        `import localCollision from "chunk.js";`,
      ].join("\n"),
    );
  });

  it("rewrites normal dynamic import expressions", () => {
    expect(
      rewrite(
        [
          `const literal = import("./feature.js");`,
          `const expression = import(moduleName);`,
          `const commented = import /* webpackIgnore: true */ (moduleName);`,
        ].join("\n"),
      ),
    ).toBe(
      [
        `const literal = globalThis.__wealthfolioImport("dist/addon.js", "./feature.js");`,
        `const expression = globalThis.__wealthfolioImport("dist/addon.js", moduleName);`,
        `const commented = globalThis.__wealthfolioImport("dist/addon.js", moduleName);`,
      ].join("\n"),
    );
  });

  it("leaves import method calls unchanged", () => {
    const source = [
      `await ctx.api.activities.import(activities);`,
      `await ctx.api.activities?.import(activities);`,
      `await ctx.api.activities["import"](activities);`,
      `const { import: importActivities } = ctx.api.activities;`,
    ].join("\n");

    expect(rewrite(source)).toBe(source);
  });

  it("leaves import-like text in strings, templates, and comments unchanged", () => {
    const source = [
      `const doubleQuoted = "import('./feature.js')";`,
      `const singleQuoted = 'import("./feature.js")';`,
      "const template = `import('./feature.js')`;",
      `const pattern = /import\\(.*\\)/;`,
      `// import("./feature.js")`,
      `/* import("./feature.js") */`,
    ].join("\n");

    expect(rewrite(source)).toBe(source);
  });

  it("rewrites dynamic imports inside template expressions only", () => {
    const source = "const template = `import('./fake.js') ${import('./feature.js')}`;";

    expect(rewrite(source)).toBe(
      "const template = `import('./fake.js') ${globalThis.__wealthfolioImport(\"dist/addon.js\", './feature.js')}`;",
    );
  });

  it("leaves identifiers and import.meta unchanged", () => {
    const source = [
      `someimport("./feature.js");`,
      `$import("./feature.js");`,
      `const url = import.meta.url;`,
    ].join("\n");

    expect(rewrite(source)).toBe(source);
  });

  it("escapes resolved static specifiers for their original quote style", () => {
    const source = `import first from "./first.js";\nimport second from './second.js';`;
    const result = rewriteModuleSpecifiers(
      "addon.js",
      source,
      (_importerPath, specifier) =>
        specifier === "./first.js" ? 'blob:value"one' : "blob:value'two",
      () => true,
    );

    expect(result).toBe(
      `import first from "blob:value\\"one";\nimport second from 'blob:value\\'two';`,
    );
  });

  it("reports malformed addon modules with their path and lexer offset", () => {
    expect(() => rewrite(`import(`, "chunks/broken.js")).toThrowError(
      /Failed to parse addon module 'chunks\/broken\.js': Parse error.*offset 0/,
    );
  });

  it.each([
    ["import.source", `import.source("./feature.js")`],
    ["import.defer", `import.defer("./feature.js")`],
  ])("rejects unsupported %s expressions clearly", (syntax, source) => {
    expect(() => rewrite(source)).toThrowError(
      `Unsupported ${syntax}() in addon module 'dist/addon.js' at offset 0`,
    );
  });
});
