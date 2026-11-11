import { expect, Page, test } from "@playwright/test";
import {
  createAccount,
  createActivity,
  restoreSpendingSettings,
  type SpendingSettings,
  useSpendingAccounts,
} from "./api";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test.describe.configure({ mode: "serial" });

/**
 * Dashboard spending "Where it went" rows must deep-link to the activities
 * spending tab with the selected period's date range (`from`/`to`), so the
 * tab opens filtered to the same window the dashboard was showing.
 */
test.describe("Dashboard spending deep links", () => {
  let page: Page;

  const ACCOUNT_NAME = "Spending Link Account";
  const ACCOUNT_CURRENCY = "CAD";
  const WITHDRAWAL_AMOUNT = 123.45;
  let accountId: string;
  let previousSpending: SpendingSettings | undefined;

  const pad = (value: number) => String(value).padStart(2, "0");
  const toLocalISO = (date: Date) =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    if (previousSpending) await restoreSpendingSettings(page, previousSpending);
    await page.close();
  });

  test("1. Setup: onboard and create a cash account", async () => {
    test.setTimeout(180000);
    await completeOnboardingIfNeeded(page);

    // Spending only classifies activities from CASH / CREDIT_CARD accounts.
    accountId = (
      await createAccount(page, {
        name: ACCOUNT_NAME,
        accountType: "CASH",
        currency: ACCOUNT_CURRENCY,
      })
    ).id;
  });

  test("2. Create a withdrawal dated today", async () => {
    // Today lies inside every dashboard interval (MTD/YTD/...).
    await createActivity(page, {
      accountId,
      activityType: "WITHDRAWAL",
      activityDate: new Date().toISOString(),
      amount: WITHDRAWAL_AMOUNT,
      currency: ACCOUNT_CURRENCY,
    });
  });

  test("3. Enroll the account for spending via API", async () => {
    // Enroll only the account this spec created: enrolling every account
    // would pull earlier specs' cash activities into the where-it-went
    // rollup and make the assertions below depend on unrelated test data.
    previousSpending = await useSpendingAccounts(page, [accountId]);
  });

  test("4. Where-it-went row links carry the YTD date range", async () => {
    await gotoAppPath(page, "/dashboard?tab=spending&spendingInterval=YTD");

    // The withdrawal is uncategorized, so it surfaces as the uncategorized row.
    const row = page.locator('a[href*="status=uncategorized"]').first();
    await expect(row).toBeVisible({ timeout: 30000 });

    const today = new Date();
    const expectedFrom = `${today.getFullYear()}-01-01`;
    const expectedTo = toLocalISO(today);

    const href = await row.getAttribute("href");
    expect(href).not.toBeNull();
    const params = new URLSearchParams(href!.split("?")[1]);
    expect(params.get("tab")).toBe("spending");
    expect(params.get("status")).toBe("uncategorized");
    expect(params.get("from")).toBe(expectedFrom);
    expect(params.get("to")).toBe(expectedTo);

    await row.click();
    await page.waitForURL(/\/activities\?/, { timeout: 15000 });
    const url = new URL(page.url());
    expect(url.searchParams.get("tab")).toBe("spending");
    expect(url.searchParams.get("status")).toBe("uncategorized");
    expect(url.searchParams.get("from")).toBe(expectedFrom);
    expect(url.searchParams.get("to")).toBe(expectedTo);

    // The spending tab applied the filter and still shows today's withdrawal.
    await expect(page.getByText("123.45").first()).toBeVisible({ timeout: 15000 });
  });

  test("5. Month selection links carry that month's range", async () => {
    const today = new Date();
    const monthKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}`;
    await gotoAppPath(
      page,
      `/dashboard?tab=spending&spendingInterval=YTD&spendingMonth=${monthKey}`,
    );

    const row = page.locator('a[href*="status=uncategorized"]').first();
    await expect(row).toBeVisible({ timeout: 30000 });

    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

    const href = await row.getAttribute("href");
    expect(href).not.toBeNull();
    const params = new URLSearchParams(href!.split("?")[1]);
    expect(params.get("from")).toBe(toLocalISO(monthStart));
    expect(params.get("to")).toBe(toLocalISO(monthEnd));
  });
});
