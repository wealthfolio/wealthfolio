import { expect, Page, test } from "@playwright/test";
import {
  BASE_URL,
  completeOnboardingIfNeeded,
  createAccount,
  fillDateField,
  gotoActivities,
  gotoAppPath,
  openAddActivitySheet,
  searchAndSelectSymbol,
  selectAccountOption,
  selectActivityType,
  waitForSyncToast,
} from "./helpers";

test.describe.configure({ mode: "serial" });

test.describe("Stock split adjusts holdings shares", () => {
  let page: Page;

  // Use a dedicated account + symbol so this spec is isolated from others
  // (specs share a single fresh DB across the run).
  const ACCOUNT_NAME = "Split Test Account";
  const CURRENCY = "USD";
  const SYMBOL = "TSLA";
  const INITIAL_SHARES = 30;

  // Real TSLA corporate-action history. Using actual dates + ratios keeps the
  // test aligned with market data fetched from Yahoo (so the surrounding
  // quote/price calculations match real-world behaviour).
  const BUY_DATE = "2020-01-15"; // pre-dates every TSLA split
  const BUY_PRICE = 103; // actual TSLA close on 2020-01-15 (raw, pre-split)
  const FIRST_SPLIT = { date: "2020-08-31", ratio: 5 }; // 5:1 → 30 → 150
  const SECOND_SPLIT = { date: "2022-08-25", ratio: 3 }; // 3:1 → 150 → 450
  const DEPOSIT_DATE = "2020-01-01";

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  async function selectAccount(name: string, currency: string) {
    await selectAccountOption(page, name, currency);
  }

  async function fillTestId(testId: string, value: number) {
    const input = page.getByTestId(testId);
    await input.fill(String(value));
    await input.blur();
    await page.waitForTimeout(150);
  }

  async function submitForm(buttonName: RegExp) {
    const submit = page.getByRole("button", { name: buttonName });
    await expect(submit).toBeEnabled({ timeout: 5000 });
    await submit.click();
    await expect(page.getByRole("heading", { name: "Add Activity" })).not.toBeVisible({
      timeout: 20000,
    });
    await page.waitForTimeout(400);
  }

  async function gotoAccountPage() {
    await gotoAppPath(page, "/settings/accounts");
    const link = page.getByRole("link", { name: ACCOUNT_NAME });
    await expect(link).toBeVisible({ timeout: 10000 });
    await link.click();
    await expect(page).toHaveURL(/\/accounts\/[^/]+/, { timeout: 10000 });
    // Holdings table should appear (the account has at least one position once
    // we've executed the buy)
    await expect(page.locator("table").first()).toBeVisible({ timeout: 15000 });
  }

  /**
   * `fillDateField` from helpers.ts only accepts a relative `daysAgo`.
   * Convert an absolute YYYY-MM-DD (treated as 10:00 local time, matching the
   * helper) into the equivalent number of days from now.
   */
  function daysAgoFromIso(isoDate: string): number {
    const [y, m, d] = isoDate.split("-").map(Number);
    const target = new Date(y, m - 1, d, 10, 0, 0, 0);
    const now = new Date();
    return Math.round((now.getTime() - target.getTime()) / (1000 * 60 * 60 * 24));
  }

  async function addSplit(isoDate: string, ratio: number) {
    await gotoActivities(page);
    await openAddActivitySheet(page);
    await selectActivityType(page, "Split");
    await selectAccount(ACCOUNT_NAME, CURRENCY);
    await searchAndSelectSymbol(page, SYMBOL);
    await fillDateField(page, daysAgoFromIso(isoDate));
    await fillTestId("split-ratio-input", ratio);
    await submitForm(/Add Split/i);
    // Incremental snapshot updates do not retroactively re-apply split
    // factors to historical positions, so trigger a full recalculation
    // (BackfillHistory mode) before reading holdings.
    await triggerFullRecalculation();
  }

  /**
   * Calls POST /api/v1/portfolio/recalculate from the page context so the
   * backend rebuilds holdings snapshots from scratch — required after adding
   * a SPLIT activity that should retroactively scale prior buy quantities.
   */
  async function triggerFullRecalculation() {
    const response = await page.request.post(`${BASE_URL}/api/v1/portfolio/recalculate`);
    expect(response.status()).toBe(202);
    await waitForSyncToast(page, 90_000);
  }

  /**
   * Polls the account-holdings table until the symbol's row reports the
   * expected share count. Reloads between attempts so a stale react-query
   * cache cannot pin the assertion to an outdated value.
   */
  async function expectSharesInHoldings(expected: number) {
    await waitForSyncToast(page, 60_000);

    await expect
      .poll(
        async () => {
          await page.reload({ waitUntil: "domcontentloaded" });
          await waitForSyncToast(page, 30_000);
          const row = page.locator("tbody tr").filter({ hasText: SYMBOL }).first();
          if (!(await row.isVisible().catch(() => false))) return "";
          return (await row.textContent()) ?? "";
        },
        { timeout: 90_000, intervals: [2000, 3000, 5000] },
      )
      // Anchor with non-digit lookarounds so `30` doesn't match `130` etc.
      .toMatch(new RegExp(`(?<!\\d)${expected}(?!\\d)`));
  }

  test("1. Setup: ensure onboarding/login complete", async () => {
    test.setTimeout(180_000);

    await completeOnboardingIfNeeded(page);
  });

  test("2. Create dedicated split-test account", async () => {
    await createAccount(page, ACCOUNT_NAME, CURRENCY);
  });

  test("3. Deposit + buy seeds the position with 30 shares", async () => {
    test.setTimeout(120_000);

    // Deposit ahead of the buy
    await gotoActivities(page);
    await openAddActivitySheet(page);
    await selectActivityType(page, "Deposit");
    await selectAccount(ACCOUNT_NAME, CURRENCY);
    await fillDateField(page, daysAgoFromIso(DEPOSIT_DATE));
    await fillTestId("amount-input", 50_000);
    await submitForm(/Add Deposit/i);

    // Buy 30 TSLA at the actual pre-split close on 2020-01-15 (~$103).
    // Recording the real raw price means the snapshot's split-adjusted
    // average cost ($103 / 15 ≈ $6.87) lines up with Yahoo's adjusted history
    // and the displayed market value reflects TSLA's true run-up rather than
    // looking like the cost basis was multiplied by the split factor.
    await gotoActivities(page);
    await openAddActivitySheet(page);
    await selectActivityType(page, "Buy");
    await selectAccount(ACCOUNT_NAME, CURRENCY);
    await searchAndSelectSymbol(page, SYMBOL);
    await fillDateField(page, daysAgoFromIso(BUY_DATE));
    await fillTestId("quantity-input", INITIAL_SHARES);
    await fillTestId("price-input", BUY_PRICE);
    await submitForm(/Add Buy/i);

    await gotoAccountPage();
    await expectSharesInHoldings(INITIAL_SHARES);
  });

  test("4. Real 2020-08-31 5:1 split scales 30 → 150 shares", async () => {
    test.setTimeout(120_000);

    await addSplit(FIRST_SPLIT.date, FIRST_SPLIT.ratio);

    await gotoAccountPage();
    await expectSharesInHoldings(INITIAL_SHARES * FIRST_SPLIT.ratio);
  });

  test("5. Real 2022-08-25 3:1 split scales 150 → 450 shares", async () => {
    test.setTimeout(120_000);

    await addSplit(SECOND_SPLIT.date, SECOND_SPLIT.ratio);

    await gotoAccountPage();
    await expectSharesInHoldings(INITIAL_SHARES * FIRST_SPLIT.ratio * SECOND_SPLIT.ratio);
  });
});
