import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";

// Issue #2262: a row whose symbol can't be mapped kept the import at Mapping, even when that
// row wasn't wanted. Unticking a row there must leave it out of the import.

function csv(symbols: string[]) {
  const rows = symbols.map(
    (symbol, index) =>
      `2024-01-0${index + 2},${symbol},${/^[A-Z]+$/.test(symbol) ? "EQUITY" : ""},${index + 3},BUY,${50 + index}.5,USD,0,`,
  );
  return (
    [
      "date,symbol,instrumentType,quantity,activityType,unitPrice,currency,fee,amount",
      ...rows,
    ].join("\n") + "\n"
  );
}

async function openMapping(page: Page, symbols: string[]) {
  await completeOnboardingIfNeeded(page);
  const accountResponse = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
    data: {
      name: `Skip rows ${Date.now().toString(36)}`,
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      isArchived: false,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(accountResponse.ok(), await accountResponse.text()).toBeTruthy();
  const accountId = ((await accountResponse.json()) as { id: string }).id;

  await page.goto(`${BASE_URL}/import?account=${accountId}`, { waitUntil: "domcontentloaded" });
  await page.locator('input[type="file"]').setInputFiles({
    name: "skip-rows.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv(symbols)),
  });
  const configureMapping = page.getByRole("button", { name: /Configure Mapping/i });
  await expect(configureMapping).toBeEnabled({ timeout: 10_000 });
  await configureMapping.click();
  return accountId;
}

// Continues from Mapping through the import and returns the imported symbols.
async function importFromMapping(page: Page, accountId: string, expectedCount: number) {
  await page.getByRole("button", { name: /Review Assets/i }).click();
  const reviewActivities = page.getByRole("button", { name: /Review Activities/i });
  await expect(reviewActivities).toBeEnabled({ timeout: 30_000 });
  await reviewActivities.click();
  const continueToImport = page.getByRole("button", { name: /Continue to Import/i });
  await expect(continueToImport).toBeEnabled({ timeout: 30_000 });
  await continueToImport.click();
  const importButton = page.getByRole("button", {
    name: new RegExp(`Import ${expectedCount} Activit`, "i"),
  });
  await expect(importButton).toBeEnabled({ timeout: 10_000 });
  await importButton.click();
  await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 60_000 });

  const searchResponse = await page.request.post(`${BASE_URL}/api/v1/activities/search`, {
    data: { page: 0, pageSize: 10, accountIdFilter: [accountId] },
  });
  expect(searchResponse.ok()).toBe(true);
  const { data: activities } = (await searchResponse.json()) as {
    data: { assetSymbol: string }[];
  };
  return activities.map((activity) => activity.assetSymbol).sort();
}

test("unticking a row with an unmapped symbol imports the other rows", async ({ page }) => {
  test.setTimeout(180_000);
  const accountId = await openMapping(page, [
    "AAPL",
    "UNLISTED SMALL CAP FUND - DIRECT PLAN",
    "SHOP",
  ]);

  const symbolsCard = page.getByRole("alert").filter({ hasText: "Symbols" });
  const reviewAssets = page.getByRole("button", { name: /Review Assets/i });
  await expect(symbolsCard).toContainText("2 of 3 mapped", { timeout: 15_000 });
  await expect(reviewAssets).toBeDisabled();

  await page.getByRole("checkbox", { name: "Include row 2" }).click();
  await expect(symbolsCard).toContainText("2 of 2 mapped");
  await expect(page.getByText("3 total rows · 1 skipped")).toBeVisible();
  await expect(reviewAssets).toBeEnabled();

  expect(await importFromMapping(page, accountId, 2)).toEqual(["AAPL", "SHOP"]);
});

// With Review Assets already enabled, unticking a row changes nothing else the step reads,
// so this catches a Next handler that still holds the previous skips.
test("unticking a row while Review Assets is enabled leaves it out", async ({ page }) => {
  test.setTimeout(180_000);
  const accountId = await openMapping(page, ["AAPL", "SHOP", "MSFT"]);

  const reviewAssets = page.getByRole("button", { name: /Review Assets/i });
  await expect(reviewAssets).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("checkbox", { name: "Include row 2" }).click();
  await expect(page.getByText("3 total rows · 1 skipped")).toBeVisible();
  await expect(reviewAssets).toBeEnabled();

  expect(await importFromMapping(page, accountId, 2)).toEqual(["AAPL", "MSFT"]);
});
