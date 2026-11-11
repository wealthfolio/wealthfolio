import { expect, Page, test } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { createAccount, uniqueName } from "./api";
import { BASE_URL, loginIfNeeded } from "./helpers";

/**
 * Final-cash writer policy through the real CSV import path.
 *
 * Every row of the fixture exercises one row of the policy table in
 * activities_service.rs, and every assertion is against PERSISTED data
 * (amount + needsReview via the API), plus a fixture-computed cash total.
 * Deliberately no UI-vs-API comparison and no floor assertions — those
 * cannot fail when amounts are silently wrong (PR #1571 review, T3).
 */

test.describe.configure({ mode: "serial" });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLICY_CSV = path.join(__dirname, "fixtures", "final-cash-policy.csv");

const IMPORT_ACCOUNT = uniqueName("Final Cash Policy Account");

/** tag (from the comment column) → expected persisted state */
const EXPECTED_ROWS: Record<string, { amount: number; needsReview: boolean }> = {
  P1: { amount: 505, needsReview: false }, // derived: 10×50 + 5
  P2: { amount: 505, needsReview: false }, // exact final preserved
  P3: { amount: 505, needsReview: false }, // gross 500 canonicalized to final
  P4: { amount: 999, needsReview: true }, // contradicting total kept + flagged
  P5: { amount: 296, needsReview: false }, // derived: 5×60 − 3 − 1
  P6: { amount: 1000, needsReview: false }, // plain cash as stated
  P7: { amount: 9.99, needsReview: false }, // charge derived from fee column
};

/** signed cash effect per activity type — the fixture-computed ledger */
const SIGN: Record<string, number> = {
  BUY: -1,
  SELL: 1,
  DEPOSIT: 1,
  WITHDRAWAL: -1,
  FEE: -1,
  TAX: -1,
};

// −505 −505 −505 −999 +296 +1000 −9.99
const EXPECTED_CASH_TOTAL = -1227.99;

async function selectImportAccount(page: Page, accountName: string) {
  const selectorTrigger = page.getByRole("combobox", { name: /Select an account/i });
  await expect(selectorTrigger).toBeVisible({ timeout: 5000 });
  await selectorTrigger.click();
  await page.waitForTimeout(300);
  const searchInput = page.getByPlaceholder("Search accounts...");
  await searchInput.fill(accountName);
  await page.waitForTimeout(300);
  const accountOption = page.getByRole("option", { name: new RegExp(accountName, "i") }).first();
  await expect(accountOption).toBeVisible({ timeout: 5000 });
  await accountOption.click();
  await page.waitForTimeout(300);
}

test.describe("Final-cash import policy", () => {
  let page: Page;
  let accountId: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("1. Setup: login and create the policy account", async () => {
    test.setTimeout(180000);
    await loginIfNeeded(page);
    accountId = (await createAccount(page, { name: IMPORT_ACCOUNT })).id;
  });

  test("2. Import the policy fixture through the wizard", async () => {
    test.setTimeout(180000);

    await page.goto(`${BASE_URL}/import`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Import Activities/i })).toBeVisible({
      timeout: 10000,
    });
    await page.waitForTimeout(1000);

    await selectImportAccount(page, IMPORT_ACCOUNT);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(POLICY_CSV);
    await page.waitForTimeout(1000);
    await expect(page.getByText("CSV Preview")).toBeVisible({ timeout: 10000 });

    const continueBtn = page.getByRole("button", { name: /Configure Mapping/i });
    await expect(continueBtn).toBeEnabled({ timeout: 5000 });
    await continueBtn.click();
    await page.waitForTimeout(1000);

    const reviewAssetsBtn = page.getByRole("button", { name: /Review Assets/i });
    await expect(reviewAssetsBtn).toBeEnabled({ timeout: 10000 });
    await reviewAssetsBtn.click();
    await page.waitForTimeout(2000);

    const reviewActivitiesBtn = page.getByRole("button", { name: /Review Activities/i });
    await expect(reviewActivitiesBtn).toBeEnabled({ timeout: 30000 });
    await reviewActivitiesBtn.click();
    await page.waitForTimeout(2000);

    const continueToImportBtn = page.getByRole("button", { name: /Continue to Import/i });
    await expect(continueToImportBtn).toBeEnabled({ timeout: 30000 });
    await continueToImportBtn.click();
    await page.waitForTimeout(1000);

    const importBtn = page.getByRole("button", { name: /Import \d+ Activit/i });
    await expect(importBtn).toBeEnabled({ timeout: 10000 });
    await importBtn.click();
    await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 60000 });
  });

  test("3. Persisted amounts and review flags match the policy table", async () => {
    test.setTimeout(60000);

    const response = await page.request.post(`${BASE_URL}/api/v1/activities/search`, {
      // page is 0-based on this endpoint
      data: { page: 0, pageSize: 100, accountIdFilter: [accountId] },
    });
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as {
      data: Array<{
        activityType: string;
        amount: string | null;
        needsReview: boolean;
        comment: string | null;
      }>;
    };

    const rows = body.data;
    expect(rows.length).toBe(Object.keys(EXPECTED_ROWS).length);

    let cashTotal = 0;
    for (const row of rows) {
      const tag = row.comment?.split(" ")[0] ?? "";
      const expected = EXPECTED_ROWS[tag];
      expect(expected, `unknown fixture tag on row: ${row.comment}`).toBeTruthy();
      const stored = Number(row.amount);
      expect(
        stored,
        `${tag}: persisted amount must match the policy table (got ${row.amount})`,
      ).toBeCloseTo(expected.amount, 2);
      expect(row.needsReview, `${tag}: needsReview must match the policy table`).toBe(
        expected.needsReview,
      );
      cashTotal += (SIGN[row.activityType] ?? 0) * stored;
    }

    // The fixture-computed ledger: a hardcoded number derived from the CSV by
    // hand, never from the engine — so a silently wrong amount cannot agree
    // with it.
    expect(cashTotal).toBeCloseTo(EXPECTED_CASH_TOTAL, 2);
  });
});
