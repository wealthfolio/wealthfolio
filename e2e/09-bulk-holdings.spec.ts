import { expect, Page, test } from "@playwright/test";
import { createAccount, gotoActivities, loginIfNeeded, waitForSyncToast } from "./helpers";

test.describe.configure({ mode: "serial" });

const ACCOUNT_NAME = "Bulk Holdings Test";
const ACCOUNT_CURRENCY = "USD";

/** Search for a symbol in an open ticker search popover, wait for results, and click the match. */
async function searchAndSelectTicker(page: Page, query: string) {
  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactQueryPattern = new RegExp(`^${escapedQuery}$`, "i");
  const searchInput = page.getByPlaceholder("Search for symbol");
  await expect(searchInput).toBeVisible({ timeout: 5000 });
  await searchInput.fill(query);

  const suggestions = page.getByRole("listbox", { name: /Suggestions/i });
  await expect(suggestions).toBeVisible({ timeout: 10000 });
  const option = suggestions
    .getByRole("option")
    .filter({
      has: page.locator("span.font-mono").filter({ hasText: exactQueryPattern }),
      hasNotText: /Create custom|manual/i,
    })
    .first();
  await expect(option).toBeVisible({ timeout: 30000 });
  await option.click();
}

test.describe("Bulk Holdings (Add Existing Holdings)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("1. Login and create test account", async () => {
    test.setTimeout(120000);
    await loginIfNeeded(page);
    await createAccount(page, ACCOUNT_NAME, ACCOUNT_CURRENCY, "Transactions");
  });

  test("2. Add holdings and submit", async () => {
    test.setTimeout(120000);

    // Navigate to activities
    await gotoActivities(page);

    // Open bulk holdings modal
    await page.getByTestId("add-activities-button").click();
    await page.waitForTimeout(300);
    await page.getByTestId("transfer-holdings-action").click();
    await expect(page.getByRole("heading", { name: "Add Existing Holdings" })).toBeVisible({
      timeout: 5000,
    });

    // ── Select account ──
    const dialog = page.getByRole("dialog", { name: "Add Existing Holdings" });
    await dialog.getByRole("combobox").first().click();
    await page.waitForTimeout(300);
    const accountOption = page.getByRole("option", { name: ACCOUNT_NAME }).first();
    await expect(accountOption).toBeVisible({ timeout: 5000 });
    await accountOption.click();
    await page.waitForTimeout(300);

    // ── Row 0: AAPL (market holding) ──
    await page.getByTestId("bulk-holding-ticker-0").click();
    await page.waitForTimeout(300);
    await searchAndSelectTicker(page, "AAPL");

    const shares0 = page.getByTestId("bulk-holding-shares-0");
    await shares0.click();
    await shares0.fill("10");
    const cost0 = page.getByTestId("bulk-holding-cost-0");
    await cost0.click();
    await cost0.fill("150");
    await page.waitForTimeout(200);

    // ── Row 1: MSFT (market holding) ──
    await page.getByTestId("bulk-holdings-add-row").click();
    await page.waitForTimeout(300);

    await page.getByTestId("bulk-holding-ticker-1").click();
    await page.waitForTimeout(300);
    await searchAndSelectTicker(page, "MSFT");

    const shares1 = page.getByTestId("bulk-holding-shares-1");
    await shares1.click();
    await shares1.fill("5");
    const cost1 = page.getByTestId("bulk-holding-cost-1");
    await cost1.click();
    await cost1.fill("400");
    await page.waitForTimeout(200);

    // ── Row 2: MYASSET (custom manual holding) ──
    await page.getByTestId("bulk-holdings-add-row").click();
    await page.waitForTimeout(300);

    await page.getByTestId("bulk-holding-ticker-2").click();
    await page.waitForTimeout(300);

    const searchInput = page.getByPlaceholder("Search for symbol");
    await searchInput.fill("MYASSET");
    await page.waitForTimeout(1000);
    await expect(page.getByRole("progressbar"))
      .toBeHidden({ timeout: 15000 })
      .catch(() => {});
    await page.waitForTimeout(500);

    // Click "Create custom (manual)"
    const createCustom = page.getByRole("option", { name: /Create custom.*manual/i });
    await expect(createCustom).toBeVisible({ timeout: 5000 });
    await createCustom.click();
    await page.waitForTimeout(500);

    // Fill custom asset dialog
    await expect(page.getByRole("heading", { name: /Create Custom Asset/i })).toBeVisible({
      timeout: 5000,
    });
    const nameInput = page.getByLabel("Name");
    if (await nameInput.isVisible().catch(() => false)) {
      await nameInput.fill("My Custom Asset");
    }
    const createBtn = page.getByRole("button", { name: /Create/i }).last();
    await expect(createBtn).toBeEnabled({ timeout: 5000 });
    await createBtn.click();
    await expect(page.getByRole("heading", { name: /Create Custom Asset/i })).not.toBeVisible({
      timeout: 5000,
    });
    await page.waitForTimeout(300);

    const shares2 = page.getByTestId("bulk-holding-shares-2");
    await shares2.click();
    await shares2.fill("100");
    const cost2 = page.getByTestId("bulk-holding-cost-2");
    await cost2.click();
    await cost2.fill("25");
    await page.waitForTimeout(200);

    // ── Submit ──
    const confirmBtn = page.getByTestId("bulk-holdings-confirm");
    await expect(confirmBtn).toBeEnabled({ timeout: 5000 });
    await confirmBtn.click();

    await expect(page.getByText(/Holdings saved/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole("heading", { name: "Add Existing Holdings" })).not.toBeVisible({
      timeout: 5000,
    });

    await waitForSyncToast(page, 30000);
  });

  test("3. Verify activities in activity table", async () => {
    test.setTimeout(30000);

    await gotoActivities(page);

    // Filter by account. The control is a faceted-filter button titled "Account"; its
    // options render as role="option" inside the popover. It's multi-select, so it stays
    // open after a pick — Escape to close.
    await page.getByRole("button", { name: "Account" }).click();
    await page.getByRole("option", { name: ACCOUNT_NAME }).first().click();
    await page.keyboard.press("Escape");

    // The faceted trigger keeps the "Account" label, so assert on the observable outcome:
    // only the selected account's rows remain (this also web-first-waits for the refetch).
    const rows = page.getByRole("table").getByRole("row");
    await expect(rows.filter({ hasText: ACCOUNT_NAME })).not.toHaveCount(0);

    // All 3 holdings appear in the table, each as a single Transfer In row.
    await expect(rows.filter({ hasText: "AAPL" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "MSFT" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "MYASSET" })).toHaveCount(1);
    await expect(rows.filter({ hasText: "Transfer In" })).toHaveCount(3);
  });
});
