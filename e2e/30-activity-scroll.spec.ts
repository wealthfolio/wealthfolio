import { expect, test, type Locator, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

const api = `${BASE_URL}/api/v1`;

async function createPortfolio(page: Page) {
  await completeOnboardingIfNeeded(page);
  const runId = Date.now().toString(36);
  const accountResponse = await page.request.post(`${api}/accounts`, {
    data: {
      name: `Desktop scroll ${runId}`,
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(accountResponse.ok(), await accountResponse.text()).toBeTruthy();
  const accountId = ((await accountResponse.json()) as { id: string }).id;
  // With only the BUY, the account's Activities tab is about as tall as its
  // Holdings tab, so a small layout change can make it too short for the
  // offset the test scrolls to and the browser clamps it. The deposits come
  // the day before the BUY, so the BUY stays the first row and the portfolio's
  // first activity doesn't move out of January 2024.
  for (let i = 0; i < 5; i++) {
    const deposit = await page.request.post(`${api}/activities`, {
      data: {
        accountId,
        activityType: "DEPOSIT",
        activityDate: "2024-01-01T15:00:00Z",
        // Identical deposits would be rejected as duplicates.
        amount: 100 + i,
        currency: "USD",
        fee: 0,
        needsReview: false,
      },
    });
    expect(deposit.ok(), await deposit.text()).toBeTruthy();
  }
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
        name: "Desktop scroll asset",
        symbol: `DESKSCROLL${runId.toUpperCase()}`,
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
  return { accountId, assetId };
}

async function scrollNearBottom(container: Locator) {
  await container.evaluate((element) => {
    element.scrollTo({
      top: element.scrollHeight - element.clientHeight - 60,
      behavior: "instant",
    });
  });
  // Let the browser finish layout and scroll anchoring before recording the
  // starting position; the preservation check starts before the tab click.
  const offset = await container.evaluate(
    (element) =>
      new Promise<number>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(element.scrollTop)));
      }),
  );
  expect(offset).toBeGreaterThan(100);
  return offset;
}

async function expectScrollPreserved(container: Locator, offset: number, tolerance = 1) {
  // Watch the whole settling interval so a temporary smooth scroll also fails.
  const range = await container.evaluate(
    (element) =>
      new Promise<{ min: number; max: number }>((resolve) => {
        const start = performance.now();
        let min = element.scrollTop;
        let max = min;
        const sample = () => {
          min = Math.min(min, element.scrollTop);
          max = Math.max(max, element.scrollTop);
          if (performance.now() - start < 1000) requestAnimationFrame(sample);
          else resolve({ min, max });
        };
        sample();
      }),
  );
  expect(Math.abs(range.min - offset)).toBeLessThanOrEqual(tolerance);
  expect(Math.abs(range.max - offset)).toBeLessThanOrEqual(tolerance);
}

test.use({ viewport: { width: 1280, height: 600 } });

for (const context of ["asset", "account"] as const) {
  test(`desktop ${context} activities preserve page scroll when mounted`, async ({ page }) => {
    test.setTimeout(120_000);
    const { accountId, assetId } = await createPortfolio(page);
    await gotoAppPath(
      page,
      context === "asset" ? `/holdings/${assetId}` : `/accounts/${accountId}`,
    );
    const activities = page.getByRole("button", { name: "Activities", exact: true });
    await expect(activities).toBeVisible();
    await expect(
      page.getByText(context === "asset" ? "Book value" : "Holdings", { exact: true }).first(),
    ).toBeVisible();
    const container = page.locator("[data-page-scroll-container]");
    const offset = await scrollNearBottom(container);
    // Keep the real response pending long enough to observe the loading layout.
    await page.route("**/api/v1/activities/search", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 350));
      await route.continue();
    });
    await Promise.all([expectScrollPreserved(container, offset), activities.click()]);
    await expect(page).toHaveURL(/tab=activities/);
    await expect(page.getByRole("columnheader", { name: "Date" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "Buy", exact: true })).toBeVisible();
  });
}

test("Spending preserves scroll during selection and mobile tab switching", async ({ page }) => {
  test.setTimeout(120_000);
  await completeOnboardingIfNeeded(page);
  const response = await page.request.post(`${api}/accounts`, {
    data: {
      name: `Scroll spending cash ${Date.now().toString(36)}`,
      accountType: "CASH",
      currency: "USD",
      isDefault: false,
      isActive: true,
    },
  });
  expect(response.ok()).toBeTruthy();
  const accountId = ((await response.json()) as { id: string }).id;
  for (let i = 1; i <= 30; i++) {
    const activity = await page.request.post(`${api}/activities`, {
      data: {
        accountId,
        activityType: "WITHDRAWAL",
        activityDate: "2026-10-01T15:00:00Z",
        amount: i,
        currency: "USD",
        fee: 0,
        needsReview: false,
        comment: `Scroll expense ${i}`,
      },
    });
    expect(activity.ok(), await activity.text()).toBeTruthy();
  }
  const settings = await page.request.put(`${api}/spending/settings`, {
    data: { enabled: true, accountIds: [accountId] },
  });
  expect(settings.ok()).toBeTruthy();
  await gotoAppPath(page, "/activities?tab=spending");
  // Rows sharing a timestamp list newest-created first, so the last one is on top.
  await expect(page.getByText("Scroll expense 30", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  const container = page.locator("[data-page-scroll-container]");
  await container.evaluate((element) => element.scrollTo({ top: 300, behavior: "instant" }));
  const offset = await container.evaluate((element) => element.scrollTop);
  expect(offset).toBe(300);
  // The tenth row from the top, already in view, so checking it scrolls nothing.
  const row = page
    .getByRole("row")
    .filter({ has: page.getByText("Scroll expense 21", { exact: true }) });
  await row.getByRole("checkbox").check();
  await expect(row.getByRole("checkbox")).toBeChecked();
  // Selecting a row adds the bulk bar and remeasures rows; allow a few pixels
  // of measurement adjustment while still rejecting a reset to the top.
  await expectScrollPreserved(container, offset, 3);

  await page.setViewportSize({ width: 390, height: 844 });
  const spendingPane = page
    .locator("[data-virtual-scroll-parent]")
    .filter({ has: page.locator(".spending-activity-list") });
  await expect(spendingPane).toBeVisible();
  await spendingPane.evaluate((element) => element.scrollTo({ top: 500, behavior: "instant" }));
  const paneOffset = await spendingPane.evaluate((element) => element.scrollTop);
  expect(paneOffset).toBe(500);
  await page.getByRole("button", { name: "Investments", exact: true }).click();
  await expect(page).toHaveURL(/tab=investments/);
  await page.getByRole("button", { name: "Spending", exact: true }).click();
  await expect(page).toHaveURL(/tab=spending/);
  await expectScrollPreserved(spendingPane, paneOffset);
});
