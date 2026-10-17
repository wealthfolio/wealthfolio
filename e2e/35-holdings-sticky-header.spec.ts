import { expect, test, type Locator, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

const api = `${BASE_URL}/api/v1`;
const HOLDING_COUNT = 15;

// One account with enough manually priced holdings that its tables are taller than the window.
async function createHoldings(page: Page) {
  await completeOnboardingIfNeeded(page);
  const runId = Date.now().toString(36).toUpperCase();
  const accountResponse = await page.request.post(`${api}/accounts`, {
    data: {
      name: `Sticky holdings ${runId}`,
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(accountResponse.ok(), await accountResponse.text()).toBeTruthy();
  const accountId = ((await accountResponse.json()) as { id: string }).id;

  for (let i = 0; i < HOLDING_COUNT; i++) {
    const response = await page.request.post(`${api}/activities`, {
      data: {
        accountId,
        activityType: "BUY",
        activityDate: "2024-01-02T15:00:00Z",
        currency: "USD",
        fee: 0,
        needsReview: false,
        quantity: 10,
        unitPrice: 100 + i,
        asset: {
          name: `Sticky header asset ${i}`,
          symbol: `STICKY${i}X${runId}`,
          kind: "INVESTMENT",
          quoteCcy: "USD",
          quoteMode: "MANUAL",
        },
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  }

  await expect
    .poll(
      async () => {
        const holdingsResponse = await page.request.post(`${api}/holdings/list/query`, {
          data: { filter: { type: "account", accountId }, includeClosed: true },
        });
        expect(holdingsResponse.ok()).toBeTruthy();
        return ((await holdingsResponse.json()) as unknown[]).length;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(HOLDING_COUNT);
  return accountId;
}

// Wheel over the rows and report how far the header and the first row moved.
async function wheelOverRows(page: Page, table: Locator) {
  const header = table.locator("thead");
  const firstRow = table.locator("tbody tr").first();
  await header.scrollIntoViewIfNeeded();
  const before = { header: (await header.boundingBox())!, row: (await firstRow.boundingBox())! };

  await page.mouse.move(
    before.header.x + before.header.width / 2,
    before.header.y + before.header.height + 60,
  );
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => (await firstRow.boundingBox())!.y).toBeLessThan(before.row.y - 200);

  const after = { header: (await header.boundingBox())!, row: (await firstRow.boundingBox())! };
  const headerOnTop = await header.evaluate((thead) => {
    const rect = thead.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + 40, rect.top + rect.height / 2);
    return !!hit && thead.contains(hit);
  });
  return {
    headerMoved: after.header.y - before.header.y,
    rowMoved: after.row.y - before.row.y,
    headerOnTop,
  };
}

test("holdings and securities tables keep their header pinned while their rows scroll", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const accountId = await createHoldings(page);

  for (const [path, column] of [
    ["/holdings", "Position"],
    [`/accounts/${accountId}?tab=holdings`, "Position"],
    ["/settings/securities", "Security"],
  ]) {
    await gotoAppPath(page, path);
    const table = page
      .getByRole("table")
      .filter({ has: page.getByRole("columnheader", { name: column }) });
    // Wait past the loading skeleton's placeholder rows.
    await expect
      .poll(() => table.locator("tbody tr").count(), { message: path, timeout: 30_000 })
      .toBeGreaterThanOrEqual(HOLDING_COUNT);

    const result = await wheelOverRows(page, table);
    // Soft, so one run reports every page.
    expect.soft(result.rowMoved, path).toBeLessThan(-200);
    expect.soft(Math.abs(result.headerMoved), path).toBeLessThanOrEqual(1);
    expect.soft(result.headerOnTop, path).toBe(true);
  }
});
