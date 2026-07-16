import { expect, Page, test } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { BASE_URL, createAccount, loginIfNeeded } from "./helpers";

test.describe.configure({ mode: "serial" });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const KWEB_NO_CURRENCY_CSV = path.join(FIXTURES, "cad-account-usd-symbol-import.csv");

const IMPORT_ACCOUNT = "Currency Resolution Import Account";

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

async function searchImportedKwebActivity(page: Page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/activities/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        page: 0,
        pageSize: 10,
        assetIdKeyword: "KWEB",
        sort: { id: "date", desc: true },
      }),
    });

    if (!response.ok) {
      throw new Error(`Activity search failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      data: Array<{
        accountName: string;
        accountCurrency: string;
        assetSymbol: string;
        currency: string;
        unitPrice: string | null;
        amount: string | null;
      }>;
    };

    return payload.data.find(
      (activity) =>
        activity.accountName === "Currency Resolution Import Account" &&
        activity.assetSymbol === "KWEB",
    );
  });
}

test.describe("CSV import currency resolution", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("imports USD-quoted KWEB into a CAD account without mixing activity currency", async () => {
    test.setTimeout(180000);

    await loginIfNeeded(page);
    await createAccount(page, IMPORT_ACCOUNT, "CAD", "Transactions");

    await page.goto(`${BASE_URL}/import`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Import Activities/i })).toBeVisible({
      timeout: 10000,
    });

    await selectImportAccount(page, IMPORT_ACCOUNT);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(KWEB_NO_CURRENCY_CSV);

    await expect(page.getByText("CSV Preview")).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/1 row/i)).toBeVisible({ timeout: 5000 });

    await page.getByRole("button", { name: /Configure Mapping/i }).click();
    await page.waitForTimeout(1000);

    await page.getByRole("button", { name: /Review Assets/i }).click();

    const assetRow = page.getByTestId("asset-review-row").filter({ hasText: "KWEB" }).first();
    await expect(assetRow).toContainText("KraneShares CSI China Internet ETF", {
      timeout: 60000,
    });
    await expect(assetRow).toContainText("USD");

    const reviewActivitiesBtn = page.getByRole("button", { name: /Review Activities/i });
    await expect(reviewActivitiesBtn).toBeEnabled({ timeout: 60000 });
    await reviewActivitiesBtn.click();

    const reviewGrid = page.getByRole("grid", { name: "Data grid" });
    await expect(
      reviewGrid.locator('[data-slot="grid-cell"][data-column-id="symbol"]'),
    ).toContainText("KWEB", { timeout: 30000 });
    await expect(
      reviewGrid.locator('[data-slot="grid-cell"][data-column-id="currency"]'),
    ).toContainText("USD", { timeout: 30000 });

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

    const imported = await searchImportedKwebActivity(page);
    expect(imported).toMatchObject({
      accountName: IMPORT_ACCOUNT,
      accountCurrency: "CAD",
      assetSymbol: "KWEB",
      currency: "USD",
      unitPrice: "28.50",
      amount: "285.00",
    });
  });
});
