import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { getEffectiveType, hasUserOverride } from "./types";

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("effective activity type", () => {
  it("reads a blank override as none, as the backend does", () => {
    expect(getEffectiveType({ activityType: "DIVIDEND", activityTypeOverride: " " })).toBe(
      "DIVIDEND",
    );
    expect(hasUserOverride({ activityType: "DIVIDEND", activityTypeOverride: "" })).toBe(false);
    expect(getEffectiveType({ activityType: "BUY", activityTypeOverride: "SELL" })).toBe("SELL");
    expect(hasUserOverride({ activityType: "BUY", activityTypeOverride: "SELL" })).toBe(true);
  });

  it("reads every shared case as the backend does", () => {
    const cases = JSON.parse(
      readFileSync(
        join(SOURCE_ROOT, "../../../crates/core/src/activities/type_override_cases.json"),
        "utf8",
      ),
    ) as [string, string][];
    for (const [override, expected] of cases) {
      expect(getEffectiveType({ activityType: "DIVIDEND", activityTypeOverride: override })).toBe(
        expected,
      );
    }
  });

  it("is read only through getEffectiveType and hasUserOverride", () => {
    const rawRead = /activityTypeOverride\s*(\?\?|\|\||!==|===)/;
    const violations = sourceFiles(SOURCE_ROOT)
      .filter((path) => relative(SOURCE_ROOT, path) !== join("lib", "types.ts"))
      .filter((path) => rawRead.test(readFileSync(path, "utf8")))
      .map((path) => relative(SOURCE_ROOT, path));
    expect(violations).toEqual([]);
  });
});
