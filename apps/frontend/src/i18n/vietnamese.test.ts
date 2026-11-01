import { describe, expect, it } from "vitest";
import { NAMESPACES } from "./locales";

type Translation = string | { [key: string]: Translation };

const english = import.meta.glob<Translation>("./locales/en/*.json", {
  eager: true,
  import: "default",
});
const vietnamese = import.meta.glob<Translation>("./locales/vi/*.json", {
  eager: true,
  import: "default",
});

function flatten(value: Translation, prefix = ""): Map<string, string> {
  if (typeof value === "string") return new Map([[prefix, value]]);

  return new Map(
    Object.entries(value).flatMap(([key, nested]) => [
      ...flatten(nested, prefix ? `${prefix}.${key}` : key).entries(),
    ]),
  );
}

function interpolations(value: string) {
  return [...value.matchAll(/{{[^}]+}}/g)].map((match) => match[0]).sort();
}

/** Every vi string as `namespace:key` -> value, for whole-catalog sweeps. */
const allStrings = new Map<string, string>(
  Object.entries(vietnamese).flatMap(([path, translation]) => {
    const namespace = path.replace("./locales/vi/", "").replace(".json", "");
    return [...flatten(translation).entries()].map(
      ([key, value]) => [`${namespace}:${key}`, value] as const,
    );
  }),
);

function offenders(term: string, allowed: ReadonlySet<string> = new Set()) {
  return [...allStrings]
    .filter(([key, value]) => value.includes(term) && !allowed.has(key))
    .map(([key, value]) => `${key} = ${value}`);
}

/**
 * Glossary test asserting standard financial and investment terminology in Vietnamese.
 */
const GLOSSARY: readonly {
  concept: string;
  use: string;
  insteadOf: readonly string[];
  note?: string;
}[] = [
  { concept: "Portfolio", use: "Danh mục", insteadOf: [] },
  { concept: "Holdings", use: "Vị thế", insteadOf: [] },
  { concept: "Dividend", use: "Cổ tức", insteadOf: [] },
  { concept: "Performance", use: "Hiệu suất", insteadOf: [] },
  { concept: "Cost basis", use: "Giá vốn", insteadOf: [] },
];

describe("Vietnamese translations", () => {
  it("matches every English namespace, key, and interpolation", () => {
    expect(Object.keys(vietnamese)).toHaveLength(NAMESPACES.length);

    for (const namespace of NAMESPACES) {
      const englishFile = flatten(english[`./locales/en/${namespace}.json`]);
      const vietnameseFile = flatten(vietnamese[`./locales/vi/${namespace}.json`]);

      expect([...vietnameseFile.keys()].sort()).toEqual([...englishFile.keys()].sort());

      for (const [key, source] of englishFile) {
        expect(interpolations(vietnameseFile.get(key) ?? "")).toEqual(interpolations(source));
      }
    }
  });

  it.each(GLOSSARY)("says $concept as $use everywhere", ({ use, insteadOf, note }) => {
    expect(offenders(use).length, `expected the catalog to use ${use}`).toBeGreaterThan(0);

    for (const alternate of insteadOf) {
      const found = offenders(alternate);
      expect(found, `use ${use}${note ? ` — ${note}` : ""}:\n  ${found.join("\n  ")}`).toEqual([]);
    }
  });

  it("labels trade cash totals correctly", () => {
    expect(allStrings.get("activity:form.total_debit")).toBe("Tổng ghi nợ");
    expect(allStrings.get("activity:form.total_credit")).toBe("Tổng ghi có");
  });
});
