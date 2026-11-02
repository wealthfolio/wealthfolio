// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import englishTaxonomies from "@/i18n/locales/en/taxonomies.json";
import englishSpending from "@/i18n/locales/en/spending.json";

const migrations = fileURLToPath(
  new URL("../../../../crates/storage-sqlite/migrations/", import.meta.url),
);
let db: DatabaseSync;

beforeAll(() => {
  // Use the actual ordered migrations, including later seed updates, rather than
  // copying seed fixtures or parsing SQL. Node 24 is pinned in .node-version/CI.
  // This database is disposable and never touches a user's profile.
  db = new DatabaseSync(":memory:");
  const directories = readdirSync(migrations, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  expect(directories.length).toBeGreaterThan(0);
  for (const directory of directories) {
    db.exec(readFileSync(join(migrations, directory, "up.sql"), "utf8"));
  }
});
afterAll(() => db?.close());

function names(query: string): Record<string, string> {
  return Object.fromEntries(
    db
      .prepare(query)
      .all()
      .map((row) => [String(row.id), String(row.name)]),
  );
}

describe("English display catalogs match persisted seed identities", () => {
  // Whole-map equality is intentional: catch missing, extra, renamed and moved
  // IDs, not merely the intersection. Exact seed names protect user renames in
  // the display helpers; they must not silently drift from backend defaults.
  it("matches every seeded taxonomy ID and exact English name", () => {
    expect(englishTaxonomies.taxonomyNames).toEqual(names("SELECT id, name FROM taxonomies"));
  });

  it("matches every seeded category by taxonomy ID, category ID and exact name", () => {
    const categories: Record<string, Record<string, string>> = {};
    for (const row of db.prepare("SELECT taxonomy_id, id, name FROM taxonomy_categories").all()) {
      const taxonomyId = String(row.taxonomy_id);
      (categories[taxonomyId] ??= {})[String(row.id)] = String(row.name);
    }
    expect(englishTaxonomies.categoryNames).toEqual(categories);
  });

  it("matches every seeded budget-group ID and exact English name", () => {
    expect(englishSpending.budgetGroupNames).toEqual(names("SELECT id, name FROM budget_groups"));
  });

  it("matches every seeded event-type ID and exact English name", () => {
    expect(englishSpending.eventTypeNames).toEqual(
      names("SELECT id, name FROM spending_event_types"),
    );
  });
});
