import { expect, Page, test } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { createAccount, uniqueName } from "./api";
import { BASE_URL, loginIfNeeded } from "./helpers";

test.describe.configure({ mode: "serial" });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const HAPPY_PATH_CSV = path.join(FIXTURES, "happy-path-import.csv");
const SEMICOLON_CSV = path.join(FIXTURES, "semicolon-delimiter.csv");
const DUPLICATE_CSV = path.join(FIXTURES, "duplicate-detection.csv");

const IMPORT_ACCOUNT = uniqueName("Import USD Account");

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
    await loginIfNeeded(page);
    await createAccount(page, { name: IMPORT_ACCOUNT });
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
});
