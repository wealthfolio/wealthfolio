import { expect, test, type Locator } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

const api = `${BASE_URL}/api/v1`;

async function heightOf(row: Locator) {
  return row.evaluate(
    (element) =>
      new Promise<number>((resolve) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve(element.getBoundingClientRect().height)),
        );
      }),
  );
}

test.use({ viewport: { width: 1280, height: 800 } });

// The row under the account value shows N/A until the period's performance loads, then
// the animated gain; hiding balances replaces the gain with dots. A change in its height
// moves everything below it, and scroll anchoring moves a page scrolled past it (#2438).
test("the account gain row keeps its height while the gain loads and when balances are hidden", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await completeOnboardingIfNeeded(page);
  const runId = Date.now().toString(36);
  const accountResponse = await page.request.post(`${api}/accounts`, {
    data: {
      name: `Gain row ${runId}`,
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(accountResponse.ok(), await accountResponse.text()).toBeTruthy();
  const accountId = ((await accountResponse.json()) as { id: string }).id;
  const response = await page.request.post(`${api}/activities`, {
    data: {
      accountId,
      activityType: "BUY",
      activityDate: "2024-01-02T15:00:00Z",
      currency: "USD",
      fee: 0,
      needsReview: false,
      quantity: 10,
      unitPrice: 100,
      asset: {
        name: "Gain row asset",
        symbol: `GAINROW${runId.toUpperCase()}`,
        kind: "INVESTMENT",
        quoteCcy: "USD",
        quoteMode: "MANUAL",
      },
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const assetId = ((await response.json()) as { assetId: string }).assetId;
  await expect
    .poll(
      async () => {
        const holdingsResponse = await page.request.post(`${api}/holdings/list/query`, {
          data: { filter: { type: "account", accountId }, includeClosed: true },
        });
        expect(holdingsResponse.ok()).toBeTruthy();
        const { holdings } = (await holdingsResponse.json()) as {
          holdings: { instrument?: { id: string } }[];
        };
        return holdings.some((holding) => holding.instrument?.id === assetId);
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  // Hold the performance history, which the default 3M gain comes from, so the row
  // shows N/A first.
  let releasePerformance = () => {};
  const performanceHeld = new Promise<void>((resolve) => {
    releasePerformance = resolve;
  });
  await page.route("**/api/v1/performance/history", async (route) => {
    await performanceHeld;
    await route.continue();
  });
  await gotoAppPath(page, `/accounts/${accountId}`);
  const row = page.getByTestId("account-gain-row");
  await expect(row.getByText("N/A", { exact: true })).toHaveCount(2);
  const height = await heightOf(row);

  releasePerformance();
  // NumberFlow loads on demand.
  await expect(row.locator("number-flow-react")).toBeAttached();
  expect(await heightOf(row), "loaded gain").toBe(height);

  const card = page.locator('[data-slot="card"]').filter({ has: row });
  await card.getByRole("button", { name: "Hide Balance", exact: true }).click();
  await expect(row).toContainText("••••");
  expect(await heightOf(row), "hidden balance").toBe(height);
});
