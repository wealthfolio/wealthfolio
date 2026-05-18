import { expect, Page, test } from "@playwright/test";
import { BASE_URL, loginIfNeeded } from "./helpers";

test.describe.configure({ mode: "serial" });

const CUSTOM_SYMBOL = "TESTASSET01";

test.describe("Asset Creation", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("1. Setup: login", async () => {
    test.setTimeout(180000);
    await loginIfNeeded(page);
    await page.goto(`${BASE_URL}/settings/securities`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Securities" })).toBeVisible({ timeout: 10000 });
  });

  test("2. Open Add Security dialog", async () => {
    await page.goto(`${BASE_URL}/settings/securities`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Securities" })).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "Add Security" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("heading", { name: "Add Security" })).toBeVisible({
      timeout: 3000,
    });
  });

  test("3. Create manual asset", async () => {
    await page.goto(`${BASE_URL}/settings/securities`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Securities" })).toBeVisible({ timeout: 10000 });

    // Skip if already exists
    const existingRow = page.getByRole("row").filter({ hasText: CUSTOM_SYMBOL });
    if (await existingRow.isVisible().catch(() => false)) {
      return;
    }

    await page.getByRole("button", { name: "Add Security" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5000 });

    // Fill Symbol
    const symbolInput = page.getByPlaceholder("e.g., AAPL");
    await symbolInput.fill(CUSTOM_SYMBOL);

    // Fill Name
    const nameInput = page.getByPlaceholder("e.g., Apple Inc.");
    await nameInput.fill("Test Asset");

    // Type should already be EQUITY (default)
    // Currency should already have a default

    // Click Create Security
    await page.getByRole("button", { name: "Create Security" }).click();

    // Dialog should close
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

    await page.waitForTimeout(1000);

    // Default filter shows only portfolio holdings — reset to show all assets
    const resetBtn = page.getByRole("button", { name: "Reset" });
    if (await resetBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await resetBtn.click();
      await page.waitForTimeout(500);
    }

    // Row should appear in table
    const assetRow = page.getByRole("row").filter({ hasText: CUSTOM_SYMBOL });
    await expect(assetRow.first()).toBeVisible({ timeout: 10000 });
  });

  test("4. Create from ticker search — AAPL", async () => {
    await page.goto(`${BASE_URL}/settings/securities`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Securities" })).toBeVisible({ timeout: 10000 });

    // Wait for table data to load before checking for existing assets
    await expect(page.getByRole("table")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Skip if AAPL already exists (likely from earlier specs like CSV import)
    const existingRow = page.getByRole("row").filter({ hasText: "AAPL" });
    if (await existingRow.isVisible().catch(() => false)) {
      return;
    }

    await page.getByRole("button", { name: "Add Security" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5000 });

    // Click the search combobox trigger to open the search popover
    const searchTrigger = page.getByRole("combobox", { name: /search/i });
    await searchTrigger.click();

    // Fill the actual CommandInput inside the popover
    const escapedSymbol = "AAPL".replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactSymbolPattern = new RegExp(`^${escapedSymbol}$`, "i");
    const searchInput = page.getByPlaceholder("Search for symbol");
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await searchInput.fill("AAPL");

    // Wait for search results to appear and select AAPL
    const suggestions = page.getByRole("listbox", { name: /Suggestions/i });
    await expect(suggestions).toBeVisible({ timeout: 10000 });
    const aaplOption = suggestions
      .getByRole("option")
      .filter({
        has: page.locator("span.font-mono").filter({ hasText: exactSymbolPattern }),
        hasNotText: /Create custom|manual/i,
      })
      .first();
    await expect(aaplOption).toBeVisible({ timeout: 30000 });
    await aaplOption.click();

    // Verify symbol field got auto-filled
    const symbolInput = page.getByPlaceholder("e.g., AAPL");
    await expect(symbolInput).toHaveValue(/AAPL/i);

    // Click Create Security
    await page.getByRole("button", { name: "Create Security" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 10000 });

    await page.waitForTimeout(1000);
    const aaplRow = page.getByRole("row").filter({ hasText: "AAPL" });
    await expect(aaplRow.first()).toBeVisible({ timeout: 10000 });
  });

  test("5. Edit asset — add notes", async () => {
    await page.goto(`${BASE_URL}/settings/securities`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Securities" })).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Clear portfolio filter if still active (only shows currently-held assets by default)
    const resetBtn = page.getByRole("button", { name: "Reset" });
    if (await resetBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await resetBtn.click();
      await page.waitForTimeout(500);
    }

    // Find the TESTASSET01 row
    const assetRow = page.getByRole("row").filter({ hasText: CUSTOM_SYMBOL });
    await expect(assetRow.first()).toBeVisible({ timeout: 10000 });

    // Open the actions dropdown for this row and click Edit
    const actionsBtn = assetRow.first().getByRole("button", { name: "Open actions" });
    await actionsBtn.click();
    await page.waitForTimeout(300);
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await page.waitForTimeout(500);

    // Edit sheet should open
    const editSheet = page.getByRole("dialog").or(page.locator('[role="sheet"]')).first();
    await expect(editSheet).toBeVisible({ timeout: 5000 });

    // Find and fill notes field
    const notesTextarea = page.getByPlaceholder("Any additional notes...");
    if (await notesTextarea.isVisible().catch(() => false)) {
      await notesTextarea.fill("E2E test notes for TESTASSET01");
    } else {
      // Notes may be on a different tab
      const notesTab = page.getByRole("tab", { name: /Notes|Details/i });
      if (await notesTab.isVisible().catch(() => false)) {
        await notesTab.click();
        await page.waitForTimeout(300);
        await page
          .getByPlaceholder("Any additional notes...")
          .fill("E2E test notes for TESTASSET01");
      }
    }

    // Save the edit
    const saveButton = page.getByRole("button", { name: /Save|Update/i }).last();
    if (await saveButton.isVisible().catch(() => false)) {
      await saveButton.click();
    }

    await page.waitForTimeout(500);

    // Close sheet if still open
    const closeButton = page
      .getByRole("button", { name: /close/i })
      .or(page.locator('[aria-label="Close"]'))
      .first();
    if (await closeButton.isVisible().catch(() => false)) {
      await closeButton.click();
    } else {
      await page.keyboard.press("Escape");
    }
    await page.waitForTimeout(500);
  });

  test("6. Validation — empty symbol and name shows errors", async () => {
    await page.goto(`${BASE_URL}/settings/securities`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Securities" })).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: "Add Security" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5000 });

    // Click Create without filling anything
    await page.getByRole("button", { name: "Create Security" }).click();
    await page.waitForTimeout(500);

    // Should show symbol and name errors
    await expect(page.getByText("Symbol is required")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Name is required")).toBeVisible({ timeout: 5000 });

    // Close dialog
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible({ timeout: 5000 });
  });
});
