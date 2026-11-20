import { describe, expect, it } from "vitest";
import { NAMESPACES } from "./locales";

type Translation = string | { [key: string]: Translation };

const english = import.meta.glob<Translation>("./locales/en/*.json", {
  eager: true,
  import: "default",
});
const turkish = import.meta.glob<Translation>("./locales/tr/*.json", {
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

/** Every tr string as `namespace:key` -> value, for whole-catalog sweeps. */
const allStrings = new Map<string, string>(
  Object.entries(turkish).flatMap(([path, translation]) => {
    const namespace = path.replace("./locales/tr/", "").replace(".json", "");
    return [...flatten(translation).entries()].map(
      ([key, value]) => [`${namespace}:${key}`, value] as const,
    );
  }),
);

// Turkish has a dotted and a dotless i, so case-folding must use the tr locale.
const fold = (value: string) => value.replace(/{{[^}]+}}/g, "").toLocaleLowerCase("tr");

// Match at a word start only: "eşitle" must not flag "çeşitlendirilmiş".
function offenders(term: string, allowed: ReadonlySet<string> = new Set()) {
  const pattern = new RegExp(`(^|[^\\p{L}])${fold(term)}`, "u");
  return [...allStrings]
    .filter(([key, value]) => pattern.test(fold(value)) && !allowed.has(key))
    .map(([key, value]) => `${key} = ${value}`);
}

/**
 * The house glossary for this catalog: the term the catalog standardises on must
 * be present, and its known alternates absent, so a later contributor cannot
 * reintroduce a second word for the same concept.
 */
const GLOSSARY: readonly {
  concept: string;
  use: string;
  insteadOf: readonly string[];
  note?: string;
}[] = [
  { concept: "Sync", use: "senkroniz", insteadOf: ["eşitle", "eşzaman"] },
  { concept: "Token", use: "belirteç", insteadOf: ["jeton"] },
  { concept: "Add-on", use: "eklenti", insteadOf: ["add-on", "addon"] },
  { concept: "Snapshot", use: "anlık görüntü", insteadOf: ["snapshot"] },
  { concept: "Liability", use: "borç", insteadOf: ["yükümlülük"] },
  { concept: "Rebalancing", use: "yeniden dengele", insteadOf: ["rebalans"] },
  {
    concept: "Activity",
    use: "işlem",
    insteadOf: ["aktivite"],
    note: "an activity is a recorded transaction, not an activity in general",
  },
];

describe("Turkish translations", () => {
  it("matches every English namespace, key, and interpolation", () => {
    expect(Object.keys(turkish)).toHaveLength(NAMESPACES.length);

    for (const namespace of NAMESPACES) {
      const englishFile = flatten(english[`./locales/en/${namespace}.json`]);
      const turkishFile = flatten(turkish[`./locales/tr/${namespace}.json`]);

      expect([...turkishFile.keys()].sort()).toEqual([...englishFile.keys()].sort());

      for (const [key, source] of englishFile) {
        expect(interpolations(turkishFile.get(key) ?? "")).toEqual(interpolations(source));
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

  it("uses the standard financial terms for core labels", () => {
    expect(allStrings.get("common:holdings")).toBe("Varlıklar");
    expect(allStrings.get("common:performance")).toBe("Performans");
    expect(allStrings.get("taxonomies:categoryNames.asset_classes.RE_PUBLIC_REITS")).toBe(
      "Halka açık GYO'lar",
    );
    expect(allStrings.get("taxonomies:categoryNames.asset_classes.EQUITY_PRIVATE")).toBe(
      "Özel sermaye",
    );
  });
});
