import { expect, Page, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { BASE_URL, createAccount, loginIfNeeded } from "./helpers";

test.describe.configure({ mode: "serial" });
test.skip(
  process.env.WF_E2E_ENABLE_AUSTRALIA_CGT_ADDON !== "true",
  "Australia CGT addon E2E requires the addon dev server; run pnpm test:e2e:australia-cgt-addon.",
);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "australia-cgt-addon.csv");
const ACCOUNT_NAME = "Australian Taxable";

async function completeAudOnboardingIfNeeded(page: Page) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  const continueButton = page.getByRole("button", { name: "Continue" });
  const loginInput = page.getByPlaceholder("Enter your password");
  const dashboardHeading = page.getByRole("heading", { name: "Dashboard" });
  const accountsHeading = page.getByRole("heading", { name: "Accounts" });

  await expect(continueButton.or(loginInput).or(dashboardHeading).or(accountsHeading)).toBeVisible({
    timeout: 120000,
  });

  if (await loginInput.isVisible()) {
    await loginIfNeeded(page);
    return;
  }

  if (!(await continueButton.isVisible())) return;

  await continueButton.click();
  await expect(page.getByTestId("currency-aud-button")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("currency-aud-button").click();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByTestId("theme-light-button")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("theme-light-button").click();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByTestId("onboarding-finish-button")).toBeVisible({ timeout: 15000 });
  await page.getByTestId("onboarding-finish-button").click();

  await page.waitForURL(new RegExp(`${BASE_URL}/settings/accounts`), { timeout: 15000 });
}

async function selectImportAccount(page: Page, accountName: string) {
  const selectorTrigger = page.getByRole("combobox", { name: /Select an account/i });
  await expect(selectorTrigger).toBeVisible({ timeout: 5000 });
  await selectorTrigger.click();

  const searchInput = page.getByPlaceholder("Search accounts...");
  await searchInput.fill(accountName);

  const accountOption = page.getByRole("option", { name: new RegExp(accountName, "i") }).first();
  await expect(accountOption).toBeVisible({ timeout: 5000 });
  await accountOption.click();
}

async function importCgtFixture(page: Page) {
  await page.goto(`${BASE_URL}/import`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /Import Activities/i })).toBeVisible({
    timeout: 10000,
  });

  await selectImportAccount(page, ACCOUNT_NAME);

  await page.locator('input[type="file"]').setInputFiles(FIXTURE);
  await expect(page.getByText("CSV Preview")).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(/3 row/i)).toBeVisible({ timeout: 5000 });

  await page.getByRole("button", { name: /Configure Mapping/i }).click();
  await expect(page.getByRole("button", { name: /Review Assets/i })).toBeEnabled({
    timeout: 10000,
  });
  await page.getByRole("button", { name: /Review Assets/i }).click();

  await expect(page.getByRole("button", { name: /Review Activities/i })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole("button", { name: /Review Activities/i }).click();

  await expect(page.getByRole("button", { name: /Continue to Import/i })).toBeEnabled({
    timeout: 30000,
  });
  await page.getByRole("button", { name: /Continue to Import/i }).click();

  const importButton = page.getByRole("button", { name: /Import \d+ Activit/i });
  await expect(importButton).toBeEnabled({ timeout: 10000 });
  await importButton.click();

  await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 60000 });
}

test.describe("Australia CGT addon", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("loads from addon dev mode and reports imported AUD CGT lots", async () => {
    test.setTimeout(240000);
    const browserErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        if (/^Failed to load resource: .* 404 \(Not Found\)$/.test(message.text())) {
          return;
        }
        browserErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      browserErrors.push(error.message);
    });

    await completeAudOnboardingIfNeeded(page);
    await createAccount(page, ACCOUNT_NAME, "AUD", "Transactions");
    await importCgtFixture(page);

    await page.goto(`${BASE_URL}/addons/australia-cgt`, { waitUntil: "domcontentloaded" });
    const cgtHeading = page.getByRole("heading", { name: "Australia CGT Planner" });
    const errorHeading = page.getByRole("heading", { name: "Something went wrong" });
    await expect(cgtHeading.or(errorHeading)).toBeVisible({ timeout: 30000 });
    if (await errorHeading.isVisible().catch(() => false)) {
      await page.getByRole("button", { name: "Show error details" }).click();
      const bodyText = await page.locator("body").innerText();
      throw new Error(
        `Australia CGT route rendered app error.\n\n${bodyText}\n\nBrowser errors:\n${browserErrors.join("\n")}`,
      );
    }
    await expect(cgtHeading).toBeVisible();

    const incomeYearSummary = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Income Year Summary" }),
    });
    const matchedLots = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Matched Lots" }),
    });

    await expect(incomeYearSummary.getByRole("row", { name: /2025-26/ })).toBeVisible();
    await expect(page.getByText("VAS").first()).toBeVisible();
    await expect(incomeYearSummary.getByRole("row", { name: /2025-26.*\$296/ })).toBeVisible();
    await expect(matchedLots.getByRole("columnheader", { name: "Pre-loss taxable" })).toBeVisible();

    await page.getByRole("button", { name: "Clear local tax data" }).click();
    await expect(page.getByText("AMMA statements: 0")).toBeVisible();
    await expect(page.getByText("Cached observations: 0")).toBeVisible();

    const firstDisposedParcelId = await page
      .locator('datalist#australia-cgt-all-parcels option[label*="2024-06-30"]')
      .first()
      .getAttribute("value");
    expect(firstDisposedParcelId).toBeTruthy();

    await page.getByLabel("AMMA parcel ID").fill(firstDisposedParcelId!);
    await page.getByLabel("AMMA income year").fill("2025-26");
    await page.getByLabel("AMMA taxable income").fill("300");
    await page.getByLabel("AMMA cash distribution").fill("280");
    await page.getByLabel("AMMA franking credits").fill("20");
    await page.getByLabel("AMIT cost base increase").fill("30");
    await page.getByRole("button", { name: "Save AMMA statement" }).click();
    await expect(page.getByText("AMMA statements: 1")).toBeVisible();
    await expect(page.getByText("AMIT adjustments: 1")).toBeVisible();
    await expect(incomeYearSummary.getByRole("row", { name: /2025-26.*\$281/ })).toBeVisible();
    await expect(page.getByText(/Taxable \$300 · Cash \$280 · Franking \$20/)).toBeVisible();
    await expect(page.getByRole("button", { name: /Delete AMMA .*:2025-26/ })).toBeVisible();

    await page.getByRole("button", { name: "Insert demo CPI row" }).click();
    await expect(page.getByText("Cached observations: 1")).toBeVisible();
    await expect(page.getByRole("button", { name: /Delete CPI 2027-Q3/ })).toBeVisible();

    const openParcelId = await page
      .locator('datalist#australia-cgt-open-parcels option[label*="VAS"]')
      .first()
      .getAttribute("value");
    expect(openParcelId).toBeTruthy();

    await page.getByLabel("Snapshot parcel ID").fill(openParcelId!);
    await page.getByLabel("Snapshot market value").fill("1600");
    await page.getByRole("button", { name: "Save 2027 snapshot" }).click();
    await expect(page.getByText("2027 snapshots: 1")).toBeVisible();
    await expect(page.getByRole("button", { name: /Delete snapshot/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "2027 Transition Parcels" })).toBeVisible();
    await expect(page.getByRole("cell", { name: openParcelId! }).first()).toBeVisible();
    await expect(page.getByText("$1,600").first()).toBeVisible();

    await page.getByLabel("Override parcel ID").fill("aggregated-VAS");
    await page.getByLabel("Override symbol").fill("VAS.AX");
    await page.getByLabel("Override account").fill(ACCOUNT_NAME);
    await page.getByLabel("Override acquisition date").fill("2021-07-01");
    await page.getByRole("button", { name: "Save acquisition date" }).click();
    await expect(page.getByText("Acquisition overrides: 1")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Delete acquisition override aggregated-VAS/ }),
    ).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(cgtHeading).toBeVisible({ timeout: 30000 });
    await expect(page.getByText("AMMA statements: 1")).toBeVisible();
    await expect(incomeYearSummary.getByRole("row", { name: /2025-26.*\$281/ })).toBeVisible();
    await expect(page.getByText("Cached observations: 1")).toBeVisible();
    await expect(page.getByText("2027 snapshots: 1")).toBeVisible();
    await expect(page.getByText("Acquisition overrides: 1")).toBeVisible();

    const exportButton = page.getByRole("button", { name: /Export CSV/i });
    await expect(exportButton).toBeEnabled();
    const downloadPromise = page.waitForEvent("download");
    await exportButton.click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const csv = await readFile(downloadPath!, "utf8");
    expect(csv).toContain("preLossDiscountEstimate,preLossTaxableGainEstimate");
    expect(csv).toContain('"2025-26","VAS"');
    expect(csv).toContain('"FIFO"');

    expect(browserErrors).toEqual([]);
  });
});
