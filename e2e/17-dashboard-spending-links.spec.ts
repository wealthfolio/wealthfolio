import { expect, Page, test } from "@playwright/test";
import {
  BASE_URL,
  completeOnboardingIfNeeded,
  gotoActivities,
  gotoAppPath,
  openAddActivitySheet,
  selectAccountOption,
  selectActivityType,
} from "./helpers";

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

  const pad = (value: number) => String(value).padStart(2, "0");
  const toLocalISO = (date: Date) =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("1. Setup: onboard and create a cash account", async () => {
    test.setTimeout(180000);
    await completeOnboardingIfNeeded(page);

    // Spending only classifies activities from CASH / CREDIT_CARD accounts, and
    // the account-creation UI defaults to a securities account — create via API.
    const response = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
      data: {
        name: ACCOUNT_NAME,
        accountType: "CASH",
        currency: ACCOUNT_CURRENCY,
        isDefault: false,
        isActive: true,
      },
    });
    expect(response.ok()).toBe(true);
    accountId = ((await response.json()) as { id: string }).id;
  });

  test("2. Create a withdrawal dated today", async () => {
    await gotoActivities(page);
    await openAddActivitySheet(page);
    await selectActivityType(page, "Withdrawal");
    // Select OUR account by name — earlier specs leave other accounts behind,
    // and "first account in the picker" lands the withdrawal in one of those
    // (often a securities account, whose activities spending ignores).
    await selectAccountOption(page, ACCOUNT_NAME, ACCOUNT_CURRENCY);

    // The form defaults to today's date, which lies inside every dashboard
    // interval (MTD/YTD/...), so we don't need to touch the date field.
    const dialog = page.getByRole("dialog", { name: "Add Activity" });
    const amountInput = dialog.getByTestId("amount-input");
    await expect(amountInput).toBeVisible({ timeout: 5000 });
    await amountInput.fill(String(WITHDRAWAL_AMOUNT));
    await amountInput.blur();

    const submitButton = page.getByRole("button", { name: /Add Withdrawal/i });
    await expect(submitButton).toBeEnabled({ timeout: 5000 });
    await submitButton.click();
    await expect(page.getByRole("heading", { name: "Add Activity" })).not.toBeVisible({
      timeout: 20000,
    });

    // Fail fast if the withdrawal landed in a different account — otherwise
    // the mistake only surfaces in test 4 as an opaque missing-row timeout.
    const searchResponse = await page.request.post(`${BASE_URL}/api/v1/activities/search`, {
      data: {
        page: 0,
        pageSize: 10,
        accountIdFilter: [accountId],
        activityTypeFilter: ["WITHDRAWAL"],
      },
    });
    expect(searchResponse.ok()).toBe(true);
    const { data: withdrawals } = (await searchResponse.json()) as {
      data: { amount: string | number }[];
    };
    expect(withdrawals).toHaveLength(1);
    expect(Number(withdrawals[0].amount)).toBeCloseTo(WITHDRAWAL_AMOUNT, 2);
  });

  test("3. Enroll the account for spending via API", async () => {
    // Enroll only the account this spec created: enrolling every account
    // would pull earlier specs' cash activities into the where-it-went
    // rollup and make the assertions below depend on unrelated test data.
    const updateResponse = await page.request.put(`${BASE_URL}/api/v1/spending/settings`, {
      data: { enabled: true, accountIds: [accountId] },
    });
    expect(updateResponse.ok()).toBe(true);
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
