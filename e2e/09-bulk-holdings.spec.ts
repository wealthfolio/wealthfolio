import { expect, Page, test } from "@playwright/test";
import { BASE_URL, createAccount, loginIfNeeded, waitForSyncToast } from "./helpers";

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
    await page.goto(`${BASE_URL}/activities`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible({ timeout: 10000 });

    // Open bulk holdings modal
    await page.getByRole("button", { name: "Add Activities" }).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Transfer Holdings" }).click();
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

    await page.goto(`${BASE_URL}/activities`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Filter by account
    const accountFilter = page.getByRole("button", { name: /Account/i });
    await accountFilter.click();
    await page.waitForTimeout(300);
    const filterOption = page.getByRole("option", { name: ACCOUNT_NAME }).first();
    await expect(filterOption).toBeVisible({ timeout: 5000 });
    await filterOption.click();
    await page.waitForTimeout(500);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Verify all 3 holdings appear
    await expect(page.getByText("AAPL").first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("MSFT").first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("MYASSET").first()).toBeVisible({ timeout: 5000 });

    // All should be Transfer In type
    const transferInCells = page.getByText("Transfer In");
    const count = await transferInCells.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });
});
