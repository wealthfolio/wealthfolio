import { expect, Page, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath, waitForSyncToast } from "./helpers";

test.describe.configure({ mode: "serial" });

const ASSET_SYMBOL = "SYMVAL_TEST";

test.describe("Symbol Mapping Validation", () => {
  let page: Page;

  test.use({ timeout: 120000 });

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    if (!page.isClosed()) {
      await resetTestAssetToManual().catch(() => {});
      await page.close();
    }
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  async function ensureAssetExists() {
    await gotoAppPath(page, "/settings/securities");
    await expect(page.getByRole("heading", { name: "Securities" })).toBeVisible({ timeout: 10000 });

    // Reset portfolio filter so all assets are visible
    const resetBtn = page.getByRole("button", { name: "Reset" });
    if (await resetBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await resetBtn.click();
      await page.waitForTimeout(500);
    }

    // Skip creation if asset already exists
    const existingRow = page.getByRole("row").filter({ hasText: ASSET_SYMBOL });
    if (await existingRow.isVisible({ timeout: 2000 }).catch(() => false)) return;

    await page.getByRole("button", { name: "Add Security" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5000 });

    await page.getByPlaceholder("e.g., AAPL").fill(ASSET_SYMBOL);
    await page.getByPlaceholder("e.g., Apple Inc.").fill("Symbol Validation Test Asset");
    await page.getByRole("button", { name: "Create Security" }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible({
      timeout: 10000,
    });

    // Reset filter again after creation
    const resetBtn2 = page.getByRole("button", { name: "Reset" });
    if (await resetBtn2.isVisible({ timeout: 2000 }).catch(() => false)) {
      await resetBtn2.click();
      await page.waitForTimeout(500);
    }

    await expect(page.getByRole("row").filter({ hasText: ASSET_SYMBOL }).first()).toBeVisible({
      timeout: 5000,
    });
  }

  async function openMarketDataTab() {
    await gotoAppPath(page, "/settings/securities");
    await expect(page.getByRole("heading", { name: "Securities" })).toBeVisible({ timeout: 10000 });

    // Reset filter
    const resetBtn = page.getByRole("button", { name: "Reset" });
    if (await resetBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await resetBtn.click();
      await page.waitForTimeout(500);
    }

    await waitForSyncToast(page, 60_000);

    // The table can re-render (quote updates) causing the dropdown to close before the click lands.
    // Retry opening the menu and clicking Edit as one atomic sequence so the menuitem cannot detach
    // between a visibility assertion and a later click.
    await expect(async () => {
      const assetRow = page.getByRole("row").filter({ hasText: ASSET_SYMBOL }).first();
      await expect(assetRow).toBeVisible({ timeout: 3000 });
      const actionsBtn = assetRow.getByRole("button", { name: "Open actions" });
      await actionsBtn.click();
      const editItem = page.getByRole("menuitem", { name: "Edit" });
      await expect(editItem).toBeVisible({ timeout: 2000 });
      await editItem.click();
      await expect(page.getByRole("dialog").first()).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 30_000 });

    const editSheet = page.getByRole("dialog").first();
    await expect(editSheet).toBeVisible({ timeout: 5000 });

    // Click the Market Data tab
    await page.getByRole("tab", { name: "Market Data" }).click();

    // Symbol Mapping section is only visible when pricing is Automatic.
    // If the asset is in Manual mode, enable Automatic pricing first.
    const pricingSwitch = editSheet.getByRole("switch").first();
    if (await pricingSwitch.isVisible({ timeout: 2000 }).catch(() => false)) {
      const isChecked = await pricingSwitch.getAttribute("aria-checked");
      if (isChecked === "false") {
        await pricingSwitch.click();
        // Confirm if a confirmation dialog appears
        // Using broad regex because the exact button label varies by app state
        const confirmBtn = page
          .getByRole("button")
          .filter({ hasText: /confirm|enable|yes/i })
          .first();
        if (await confirmBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await confirmBtn.click();
        }
      }
    }

    // Wait for the Symbol Mapping "Add" button to be visible
    await expect(page.getByRole("button", { name: "Add" })).toBeVisible({ timeout: 5000 });
  }

  async function openAssetMarketDataTab() {
    await openMarketDataTab();
    // Remove any leftover mapping rows from a previous partial run
    await clearAllMappings();
  }

  async function clearAllMappings() {
    const mappingTable = page.locator("table").filter({
      has: page.getByRole("columnheader", { name: "Provider" }),
    });
    const MAX_ROWS = 20;
    for (let i = 0; i < MAX_ROWS; i++) {
      const rows = mappingTable.locator("tbody tr");
      if ((await rows.count()) === 0) break;
      if (i === MAX_ROWS - 1)
        throw new Error("clearAllMappings: too many rows, possible infinite loop");
      const rowCountBefore = await rows.count();
      await rows.first().locator("button").last().click();
      await expect(mappingTable.locator("tbody tr")).not.toHaveCount(rowCountBefore, {
        timeout: 3000,
      });
    }
  }

  async function findTestAssetId() {
    const response = await page.request.get(`${BASE_URL}/api/v1/assets`);
    if (!response.ok()) {
      throw new Error(`Failed to load assets for cleanup: ${response.status()}`);
    }

    const assets = (await response.json()) as Array<{
      id: string;
      displayCode?: string | null;
      instrumentSymbol?: string | null;
    }>;

    return assets.find(
      (asset) => asset.displayCode === ASSET_SYMBOL || asset.instrumentSymbol === ASSET_SYMBOL,
    )?.id;
  }

  async function resetTestAssetToManual() {
    const assetId = await findTestAssetId();
    if (!assetId) return;

    const response = await page.request.put(`${BASE_URL}/api/v1/assets/pricing-mode/${assetId}`, {
      data: { quoteMode: "MANUAL" },
    });
    if (!response.ok()) {
      throw new Error(`Failed to reset ${ASSET_SYMBOL} to manual pricing: ${response.status()}`);
    }
  }

  async function setOpenSheetToManualPricing() {
    const editSheet = page.getByRole("dialog").first();
    const pricingSwitch = editSheet.getByRole("switch").first();
    if (!(await pricingSwitch.isVisible({ timeout: 2000 }).catch(() => false))) return;

    const isAutomatic = (await pricingSwitch.getAttribute("aria-checked")) === "true";
    if (!isAutomatic) return;

    await pricingSwitch.click();
    const confirmBtn = page.getByRole("button", { name: "Confirm" });
    await expect(confirmBtn).toBeVisible({ timeout: 3000 });
    await confirmBtn.click();
  }

  async function addMappingRow(provider: string, symbol: string) {
    // Scope to the mapping table (contains "Provider" column header)
    const mappingTable = page.locator("table").filter({
      has: page.getByRole("columnheader", { name: "Provider" }),
    });

    // Capture row count before clicking Add to get a stable nth() index
    const rowIndex = await mappingTable.locator("tbody tr").count();

    // Click Add to create a new mapping row
    await page.getByRole("button", { name: "Add" }).click();
    await expect(mappingTable.locator("tbody tr")).toHaveCount(rowIndex + 1, {
      timeout: 3000,
    });

    // The row's provider combobox defaults to YAHOO; change if needed
    if (provider !== "Yahoo Finance") {
      const newRow = mappingTable.locator("tbody tr").nth(rowIndex);
      const providerTrigger = newRow.getByRole("combobox").first();
      await providerTrigger.click();
      await expect(page.getByRole("listbox")).toBeVisible({ timeout: 3000 });
      await page.getByRole("option", { name: provider }).click();
      await expect(page.getByRole("listbox")).not.toBeVisible({ timeout: 3000 });
    }

    const newRow = mappingTable.locator("tbody tr").nth(rowIndex);
    const symbolInput = newRow.getByRole("textbox");
    await symbolInput.fill(symbol);

    return mappingTable.locator("tbody tr").nth(rowIndex);
  }

  async function waitForValidation(
    row: ReturnType<typeof page.locator>,
    expected: "valid" | "invalid",
    timeoutMs = 30000,
  ) {
    // Poll directly for the final icon scoped to the specific row
    await expect(row.getByTestId(`symbol-validation-${expected}`)).toBeVisible({
      timeout: timeoutMs,
    });
  }

  async function saveChanges() {
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText("Asset profile updated successfully")).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByRole("dialog").first()).not.toBeVisible({ timeout: 10000 });
  }

  async function removeMapping(symbol: string) {
    // Re-open the sheet and go to Market Data tab (without clearing mappings)
    await openMarketDataTab();

    const mappingTable = page.locator("table").filter({
      has: page.getByRole("columnheader", { name: "Provider" }),
    });

    // hasText doesn't match React controlled input values — iterate rows and compare inputValue()
    const rows = mappingTable.locator("tbody tr");
    const count = await rows.count();
    let found = false;
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const value = await row.getByRole("textbox").inputValue();
      if (value === symbol) {
        await row.locator("button").last().click();
        found = true;
        break;
      }
    }
    if (!found) throw new Error(`Mapping row for symbol "${symbol}" not found`);

    await setOpenSheetToManualPricing();

    // Save the removal and manual pricing change together so the asset is not synced unmapped.
    await saveChanges();
    await resetTestAssetToManual();
  }

  // ── setup ─────────────────────────────────────────────────────────────────

  test("0. Setup: login and create test asset", async () => {
    test.setTimeout(180000);

    await completeOnboardingIfNeeded(page);
    await ensureAssetExists();
  });

  // ── Yahoo Finance ─────────────────────────────────────────────────────────

  test("1. Yahoo Finance — valid symbol shows green check and price after save", async () => {
    await openAssetMarketDataTab();
    const row = await addMappingRow("Yahoo Finance", "AAPL");
    await waitForValidation(row, "valid", 30000);
    await saveChanges();

    // Re-open and verify the latest price card is shown
    await openAssetMarketDataTab();
    await expect(page.getByText("Latest price", { exact: true })).toBeVisible({ timeout: 30000 });

    await removeMapping("AAPL");
  });

  test("2. Yahoo Finance — invalid symbol shows red error and mapping is persisted after save", async () => {
    await openAssetMarketDataTab();
    const row = await addMappingRow("Yahoo Finance", "INVALID_TICKER_XYZ_E2E");
    await waitForValidation(row, "invalid", 30000);
    await saveChanges();

    // Re-open and verify the invalid mapping was persisted (removeMapping throws if not found)
    await removeMapping("INVALID_TICKER_XYZ_E2E");
  });

  // ── Börse Frankfurt ───────────────────────────────────────────────────────

  test("3. Börse Frankfurt — valid ISIN shows green check and price after save", async () => {
    await openAssetMarketDataTab();
    const row = await addMappingRow("Börse Frankfurt", "DE0007164600");
    await waitForValidation(row, "valid", 30000);
    await saveChanges();

    // Re-open and verify the latest price card is shown
    await openAssetMarketDataTab();
    await expect(page.getByText("Latest price", { exact: true })).toBeVisible({ timeout: 30000 });

    await removeMapping("DE0007164600");
  });

  test("4. Börse Frankfurt — invalid symbol shows red error and mapping is persisted after save", async () => {
    await openAssetMarketDataTab();
    const row = await addMappingRow("Börse Frankfurt", "INVALID_BF_XYZ_E2E");
    await waitForValidation(row, "invalid", 30000);
    await saveChanges();

    // Re-open and verify the invalid mapping was persisted (removeMapping throws if not found)
    await removeMapping("INVALID_BF_XYZ_E2E");
  });
});
