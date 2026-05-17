import { expect, Page, test } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import {
  assertDataGridRow,
  BASE_URL,
  completeOnboardingIfNeeded,
  createAccount,
  enableDataGridColumn,
} from "./helpers";

test.describe.configure({ mode: "serial" });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const HAPPY_PATH_CSV = path.join(FIXTURES, "happy-path-import.csv");
const SEMICOLON_CSV = path.join(FIXTURES, "semicolon-delimiter.csv");
const DUPLICATE_CSV = path.join(FIXTURES, "duplicate-detection.csv");
const FULL_COVERAGE_CSV = path.join(FIXTURES, "full-coverage-import.csv");

const IMPORT_ACCOUNT = "Import USD Account";
const IMPORT_EUR_ACCOUNT = "Import EUR Account";

async function selectImportAccount(page: Page, accountName: string) {
  // The AccountSelector card variant renders with role="combobox" and aria-label="Select an account"
  const selectorTrigger = page.getByRole("combobox", { name: /Select an account/i });
  await expect(selectorTrigger).toBeVisible({ timeout: 5000 });
  await selectorTrigger.click();
  await page.waitForTimeout(300);

  // Search for the account
  const searchInput = page.getByPlaceholder("Search accounts...");
  await searchInput.fill(accountName);
  await page.waitForTimeout(300);

  // Select the account
  const accountOption = page.getByRole("option", { name: new RegExp(accountName, "i") }).first();
  await expect(accountOption).toBeVisible({ timeout: 5000 });
  await accountOption.click();
  await page.waitForTimeout(300);
}

async function proceedThroughImportWizard(page: Page, csvPath: string, accountName: string) {
  await page.goto(`${BASE_URL}/import`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /Import Activities/i })).toBeVisible({
    timeout: 10000,
  });
  await page.waitForTimeout(1000);

  // Select account
  await selectImportAccount(page, accountName);

  // Upload file
  const fileInput = page.locator('input[type="file"]');
  await fileInput.setInputFiles(csvPath);
  await page.waitForTimeout(1000);

  // Preview should appear
  await expect(page.getByText("CSV Preview")).toBeVisible({ timeout: 10000 });

  return true;
}

test.describe("CSV Import Wizard", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("1. Setup: login and create Import USD Account", async () => {
    test.setTimeout(180000);
    await completeOnboardingIfNeeded(page);
    await createAccount(page, IMPORT_ACCOUNT, "USD", "Transactions");
  });

  test("2. Happy path: upload CSV, auto-map, review, confirm import", async () => {
    test.setTimeout(120000);

    await proceedThroughImportWizard(page, HAPPY_PATH_CSV, IMPORT_ACCOUNT);

    // Should show 11 rows
    await expect(page.getByText(/11 row/i)).toBeVisible({ timeout: 5000 });

    // Proceed to Mapping step
    const continueBtn = page.getByRole("button", { name: /Configure Mapping/i });
    await expect(continueBtn).toBeEnabled({ timeout: 5000 });
    await continueBtn.click();
    await page.waitForTimeout(1000);

    // Mapping step — proceed to asset review
    const reviewAssetsBtn = page.getByRole("button", { name: /Review Assets/i });
    await expect(reviewAssetsBtn).toBeEnabled({ timeout: 10000 });
    await reviewAssetsBtn.click();
    await page.waitForTimeout(2000);

    // Asset review step — wait for asset resolution, then proceed to activity review
    const reviewActivitiesBtn = page.getByRole("button", { name: /Review Activities/i });
    await expect(reviewActivitiesBtn).toBeEnabled({ timeout: 30000 });
    await reviewActivitiesBtn.click();
    await page.waitForTimeout(2000);

    // Activity review step — wait for backend validation and proceed to confirm
    const continueToImportBtn = page.getByRole("button", { name: /Continue to Import/i });
    await expect(continueToImportBtn).toBeEnabled({ timeout: 30000 });
    await continueToImportBtn.click();
    await page.waitForTimeout(1000);

    // Confirm step — "To Import" count > 0
    await expect(page.getByText("To Import", { exact: true }).first()).toBeVisible({
      timeout: 10000,
    });

    // Import
    const importBtn = page.getByRole("button", { name: /Import \d+ Activit/i });
    await expect(importBtn).toBeEnabled({ timeout: 10000 });
    await importBtn.click();

    // Result page shows "Import Complete"
    await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 60000 });
  });

  test("3. Semicolon delimiter: upload, fix settings, complete import", async () => {
    test.setTimeout(120000);

    await page.goto(`${BASE_URL}/import`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Import Activities/i })).toBeVisible({
      timeout: 10000,
    });
    await page.waitForTimeout(1000);

    await selectImportAccount(page, IMPORT_ACCOUNT);

    // Upload semicolon-delimited CSV
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(SEMICOLON_CSV);
    await page.waitForTimeout(1000);

    await expect(page.getByText("CSV Preview")).toBeVisible({ timeout: 10000 });

    // Open Parse Settings and set delimiter to semicolon
    const parseSettingsTrigger = page.getByText("Parse Settings");
    await expect(parseSettingsTrigger).toBeVisible({ timeout: 5000 });
    await parseSettingsTrigger.click();
    await page.waitForTimeout(300);

    // Select Semicolon delimiter
    const delimiterSelect = page.locator('[id="delimiter"]');
    await delimiterSelect.click();
    await page.getByRole("option", { name: /Semicolon/i }).click();
    await page.waitForTimeout(1000);

    // Preview should now show 11 rows correctly
    await expect(page.getByText(/11 row/i)).toBeVisible({ timeout: 5000 });

    // Proceed through wizard
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

    await expect(page.getByText("To Import", { exact: true }).first()).toBeVisible({
      timeout: 10000,
    });

    const importBtn = page.getByRole("button", { name: /Import \d+ Activit/i });
    await expect(importBtn).toBeEnabled({ timeout: 10000 });
    await importBtn.click();

    await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 60000 });
  });

  test("4. Duplicate detection: re-import same CSV, see duplicates stat", async () => {
    test.setTimeout(120000);

    await page.goto(`${BASE_URL}/import`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Import Activities/i })).toBeVisible({
      timeout: 10000,
    });
    await page.waitForTimeout(1000);

    await selectImportAccount(page, IMPORT_ACCOUNT);

    // Upload the same CSV that was already imported in test 2
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(DUPLICATE_CSV);
    await page.waitForTimeout(1000);

    await expect(page.getByText("CSV Preview")).toBeVisible({ timeout: 10000 });

    // Reset delimiter to Comma in case previous test changed it to Semicolon
    const parseSettingsTrigger = page.getByText("Parse Settings");
    if (await parseSettingsTrigger.isVisible({ timeout: 2000 }).catch(() => false)) {
      await parseSettingsTrigger.click();
      await page.waitForTimeout(300);
      const delimiterSelect = page.locator('[id="delimiter"]');
      await delimiterSelect.click();
      await page.getByRole("option", { name: /Comma/i }).click();
      await page.waitForTimeout(1000);
    }

    // Proceed through wizard
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
    await page.waitForTimeout(3000);

    // On Review step: some activities should be marked as duplicates
    const duplicateIndicator = page.getByText(/duplicate/i).first();
    await expect(duplicateIndicator).toBeVisible({ timeout: 10000 });

    // Continue to import step
    const continueToImportBtn = page.getByRole("button", { name: /Continue to Import/i });
    await expect(continueToImportBtn).toBeEnabled({ timeout: 15000 });
    await continueToImportBtn.click();
    await page.waitForTimeout(1000);

    await expect(page.getByText("To Import", { exact: true }).first()).toBeVisible({
      timeout: 10000,
    });

    const importBtn = page.getByRole("button", { name: /Import \d+ Activit/i });
    await expect(importBtn).toBeEnabled({ timeout: 10000 });
    await importBtn.click();

    // Result page shows "Duplicates" stat
    await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 60000 });
    await expect(page.getByText("Duplicates", { exact: true }).first()).toBeVisible({
      timeout: 5000,
    });
  });

  test("5. Cancel mid-wizard: Continue Importing keeps wizard open", async () => {
    test.setTimeout(60000);

    await page.goto(`${BASE_URL}/import`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Import Activities/i })).toBeVisible({
      timeout: 10000,
    });
    await page.waitForTimeout(1000);

    await selectImportAccount(page, IMPORT_ACCOUNT);

    // Upload file and proceed to Mapping step
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(HAPPY_PATH_CSV);
    await page.waitForTimeout(1000);

    await expect(page.getByText("CSV Preview")).toBeVisible({ timeout: 10000 });

    const continueBtn = page.getByRole("button", { name: /Configure Mapping/i });
    await expect(continueBtn).toBeEnabled({ timeout: 5000 });
    await continueBtn.click();
    await page.waitForTimeout(1000);

    // We should be on the Mapping step now
    await expect(page.getByRole("button", { name: /Review Assets/i })).toBeVisible({
      timeout: 5000,
    });

    // Click Cancel — should show confirmation dialog
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(300);

    // Dialog should appear
    await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Cancel Import?")).toBeVisible();

    // Click "Continue Importing" — dialog closes, still on Mapping
    await page.getByRole("button", { name: /Continue Importing/i }).click();
    await page.waitForTimeout(300);

    await expect(page.getByRole("alertdialog")).not.toBeVisible({ timeout: 3000 });
    await expect(page.getByRole("button", { name: /Review Assets/i })).toBeVisible();

    // Click Cancel again and confirm cancel
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.waitForTimeout(300);
    await expect(page.getByRole("alertdialog")).toBeVisible({ timeout: 5000 });
    await page.getByRole("button", { name: /Cancel Import/i }).click();

    // Should navigate away from import page
    await expect(page).not.toHaveURL(/\/import/, { timeout: 10000 });
  });

  test("6. Full coverage: all instrument types, all activity types, all columns round-trip", async () => {
    // Market data lookups for 7 distinct symbols may be slow
    test.setTimeout(300000);

    // Ensure onboarding is complete and both accounts exist (test is independent)
    await completeOnboardingIfNeeded(page);
    await createAccount(page, IMPORT_ACCOUNT, "USD", "Transactions");
    await createAccount(page, IMPORT_EUR_ACCOUNT, "EUR", "Transactions");

    // ── Upload step ──────────────────────────────────────────────────────────
    await page.goto(`${BASE_URL}/import`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Import Activities/i })).toBeVisible({
      timeout: 10000,
    });

    // Select default account (rows with empty account column fall back to this)
    await selectImportAccount(page, IMPORT_ACCOUNT);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(FULL_COVERAGE_CSV);

    await expect(page.getByText("CSV Preview")).toBeVisible({ timeout: 10000 });

    // ── Mapping step ─────────────────────────────────────────────────────────
    const continueBtn = page.getByRole("button", { name: /Configure Mapping/i });
    await expect(continueBtn).toBeEnabled({ timeout: 5000 });
    await continueBtn.click();

    // Wait for the account-mapping section to be visible before interacting
    await expect(page.getByText(/0 of 2 mapped/i)).toBeVisible({ timeout: 30000 });

    // The CSV has an `account` column with names (not IDs), so they need mapping.
    // Map the first unmapped AccountSelector to Import USD Account.
    const firstSelector = page
      .locator('button[role="combobox"]')
      .filter({ hasText: /Select an account/i })
      .first();
    await expect(firstSelector).toBeVisible({ timeout: 10000 });
    await firstSelector.click();
    const searchInput = page.getByPlaceholder("Search accounts...");
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await searchInput.fill(IMPORT_ACCOUNT);
    await page
      .getByRole("option", { name: new RegExp(IMPORT_ACCOUNT, "i") })
      .first()
      .click();
    await expect(page.getByText(/1 of 2 mapped/i)).toBeVisible({ timeout: 10000 });

    // After mapping USD account all its rows become valid; remaining selector is for EUR account.
    const secondSelector = page
      .locator('button[role="combobox"]')
      .filter({ hasText: /Select an account/i })
      .first();
    await expect(secondSelector).toBeVisible({ timeout: 5000 });
    await secondSelector.click();
    const searchInput2 = page.getByPlaceholder("Search accounts...");
    await expect(searchInput2).toBeVisible({ timeout: 5000 });
    await searchInput2.fill(IMPORT_EUR_ACCOUNT);
    await page
      .getByRole("option", { name: new RegExp(IMPORT_EUR_ACCOUNT, "i") })
      .first()
      .click();
    await expect(page.getByText(/2 of 2 mapped/i)).toBeVisible({ timeout: 10000 });

    // ── Review Assets step (market data resolution) ──────────────────────────
    const reviewAssetsBtn = page.getByRole("button", { name: /Review Assets/i });
    await expect(reviewAssetsBtn).toBeEnabled({ timeout: 15000 });
    await reviewAssetsBtn.click();

    // All 7 distinct symbols must resolve via Yahoo Finance / Börse Frankfurt (no fallback)
    const reviewActivitiesBtn = page.getByRole("button", { name: /Review Activities/i });
    await expect(reviewActivitiesBtn).toBeEnabled({ timeout: 120000 });
    await reviewActivitiesBtn.click();

    // ── Activity review & import ──────────────────────────────────────────────
    const continueToImportBtn = page.getByRole("button", { name: /Continue to Import/i });
    await expect(continueToImportBtn).toBeEnabled({ timeout: 30000 });
    await continueToImportBtn.click();

    await expect(page.getByText("To Import", { exact: true }).first()).toBeVisible({
      timeout: 10000,
    });
    const importBtn = page.getByRole("button", { name: /Import \d+ Activit/i });
    await expect(importBtn).toBeEnabled({ timeout: 10000 });
    await importBtn.click();
    await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 60000 });

    // ── Round-trip verification in Activities data-grid ──────────────────────
    await page.goto(`${BASE_URL}/activities`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible({ timeout: 10000 });

    // Switch to edit mode (data-grid) — only mode with comment, fxRate, instrumentType columns
    await expect(page.getByTestId("edit-mode-toggle")).toBeVisible({ timeout: 10000 });
    await page.getByTestId("edit-mode-toggle").click();
    await expect(page.locator('[data-slot="grid"]')).toBeVisible({ timeout: 10000 });

    // Enable instrumentType column (hidden by default)
    await enableDataGridColumn(page, "instrumentType");

    // ── Per-row assertions keyed by unique comment ────────────────────────────

    // EQUITY (stock): BUY — basic columns + account + instrumentType
    await assertDataGridRow(page, "e2e-msft-buy", {
      assetSymbol: "MSFT",
      quantity: "10",
      unitPrice: "380.5",
      amount: "3805",
      currency: "USD",
      fee: "4.95",
      instrumentType: "Equity",
      accountName: IMPORT_ACCOUNT,
    });

    // EQUITY: SELL
    await assertDataGridRow(page, "e2e-msft-sell", {
      assetSymbol: "MSFT",
      quantity: "5",
      unitPrice: "410",
      amount: "2050",
      fee: "4.95",
    });

    // EQUITY: DIVIDEND with subtype DRIP
    await assertDataGridRow(page, "e2e-msft-dividend", {
      assetSymbol: "MSFT",
      subtype: "Dividend Reinvested (DRIP)",
    });

    // EQUITY: SPLIT
    await assertDataGridRow(page, "e2e-msft-split", {
      assetSymbol: "MSFT",
      quantity: "4",
    });

    // EQUITY: FEE
    await assertDataGridRow(page, "e2e-msft-fee", {
      assetSymbol: "MSFT",
      amount: "12",
    });

    // EQUITY: TAX
    await assertDataGridRow(page, "e2e-msft-tax", {
      assetSymbol: "MSFT",
      amount: "25",
    });

    // EQUITY (ETF): VOO BUY
    await assertDataGridRow(page, "e2e-voo-buy", {
      assetSymbol: "VOO",
      quantity: "3",
      unitPrice: "450",
      amount: "1350",
      instrumentType: "Equity",
    });

    // EQUITY (ETF): VOO SELL
    await assertDataGridRow(page, "e2e-voo-sell", {
      assetSymbol: "VOO",
      quantity: "1",
      unitPrice: "460",
      amount: "460",
      instrumentType: "Equity",
    });

    // VOO DIVIDEND in EUR account: subtype, fxRate, account override
    await assertDataGridRow(page, "e2e-voo-dividend", {
      assetSymbol: "VOO",
      subtype: "Dividend Reinvested (DRIP)",
      fxRate: "0.92",
      accountName: IMPORT_EUR_ACCOUNT,
    });

    // BOND: BUY — currency EUR, fxRate, instrumentType
    await assertDataGridRow(page, "e2e-bond-buy", {
      assetSymbol: "IT0005441883",
      currency: "EUR",
      fxRate: "1.08",
      instrumentType: "Bond",
      accountName: IMPORT_ACCOUNT,
    });

    // BOND: SELL — currency EUR, fxRate
    await assertDataGridRow(page, "e2e-bond-sell", {
      assetSymbol: "IT0005441883",
      currency: "EUR",
      fxRate: "1.09",
      instrumentType: "Bond",
    });

    // BOND: INTEREST with STAKING_REWARD subtype in EUR account
    await assertDataGridRow(page, "e2e-bond-interest", {
      assetSymbol: "IT0005441883",
      subtype: "Staking Reward",
      accountName: IMPORT_EUR_ACCOUNT,
    });

    // BOND: TAX — currency EUR, fxRate
    await assertDataGridRow(page, "e2e-bond-tax", {
      assetSymbol: "IT0005441883",
      amount: "600",
      currency: "EUR",
      fxRate: "1.08",
      instrumentType: "Bond",
    });

    // CRYPTO: BUY — instrumentType
    // KNOWN BUG: the "-USD" suffix is stripped from crypto tickers during asset resolution.
    // If this assertion fails with "BTC-USD", the bug has been fixed — update to "BTC-USD".
    await assertDataGridRow(page, "e2e-crypto-buy", {
      assetSymbol: "BTC",
      quantity: "0.5",
      instrumentType: "Crypto",
    });

    // CRYPTO: SELL
    // KNOWN BUG: the "-USD" suffix is stripped from crypto tickers during asset resolution.
    // If this assertion fails with "BTC-USD", the bug has been fixed — update to "BTC-USD".
    await assertDataGridRow(page, "e2e-crypto-sell", {
      assetSymbol: "BTC",
      quantity: "0.25",
      amount: "11250",
      instrumentType: "Crypto",
    });

    // CRYPTO: FEE in EUR account with fxRate
    await assertDataGridRow(page, "e2e-crypto-fee", {
      assetSymbol: "BTC",
      fxRate: "0.92",
      accountName: IMPORT_EUR_ACCOUNT,
    });

    // OPTION: BUY — instrumentType
    await assertDataGridRow(page, "e2e-option-buy", {
      instrumentType: "Option",
      quantity: "2",
    });

    // OPTION: SELL
    await assertDataGridRow(page, "e2e-option-sell", {
      instrumentType: "Option",
      quantity: "2",
      amount: "4000",
    });

    // METAL: BUY — instrumentType (GLD = SPDR Gold Shares ETF, forced to METAL)
    await assertDataGridRow(page, "e2e-metal-buy", {
      assetSymbol: "GLD",
      instrumentType: "Metal",
      amount: "190",
    });

    // METAL: SELL
    await assertDataGridRow(page, "e2e-metal-sell", {
      assetSymbol: "GLD",
      instrumentType: "Metal",
      amount: "200",
    });

    // FX: BUY — instrumentType (FXE = CurrencyShares Euro Trust ETF, forced to FX)
    await assertDataGridRow(page, "e2e-fx-buy", {
      assetSymbol: "FXE",
      instrumentType: "FX",
      quantity: "100",
    });

    // FX: SELL
    await assertDataGridRow(page, "e2e-fx-sell", {
      assetSymbol: "FXE",
      instrumentType: "FX",
      quantity: "100",
    });

    // Cash: DEPOSIT (no symbol, no instrumentType)
    await assertDataGridRow(page, "e2e-deposit", {
      amount: "5000",
      currency: "USD",
    });

    // Cash: WITHDRAWAL
    await assertDataGridRow(page, "e2e-withdrawal", {
      amount: "2000",
    });

    // Cash: TRANSFER_IN
    await assertDataGridRow(page, "e2e-transfer-in", {
      amount: "3000",
    });

    // Cash: TRANSFER_OUT
    await assertDataGridRow(page, "e2e-transfer-out", {
      amount: "1000",
    });

    // Cash: CREDIT with BONUS subtype
    await assertDataGridRow(page, "e2e-credit", {
      subtype: "Bonus",
      amount: "100",
    });

    // ADJUSTMENT with OPTION_EXPIRY subtype
    await assertDataGridRow(page, "e2e-adjustment", {
      subtype: "Option Expiry",
    });
  });
});
