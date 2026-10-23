import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test("mobile asset sections preserve the page scroll position", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await completeOnboardingIfNeeded(page);

  const runId = Date.now().toString(36);
  const accountResponse = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
    data: {
      name: `Scroll regression ${runId}`,
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
  const buyResponse = await page.request.post(`${BASE_URL}/api/v1/activities`, {
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
        name: "Scroll regression asset",
        symbol: `SCROLL${runId.toUpperCase()}`,
        kind: "INVESTMENT",
        quoteCcy: "USD",
        quoteMode: "MANUAL",
      },
    },
  });
  expect(buyResponse.ok(), await buyResponse.text()).toBeTruthy();
  const assetId = ((await buyResponse.json()) as { assetId: string }).assetId;
  await expect
    .poll(
      async () => {
        const response = await page.request.post(`${BASE_URL}/api/v1/holdings/list/query`, {
          data: { filter: { type: "account", accountId }, includeClosed: true },
        });
        const holdings = (await response.json()) as { instrument?: { id: string } }[];
        return holdings.some((h) => h.instrument?.id === assetId);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await gotoAppPath(page, `/holdings/${encodeURIComponent(assetId)}`);
  await expect(page.getByRole("button", { name: "Go to Holdings", exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // The phone keeps the Holdings list mounted, hidden, under the asset screen.
  const scrollContainer = page.locator("[data-page-scroll-container]:visible");
  await expect(page.getByText("Book value", { exact: true })).toBeVisible();
  await scrollContainer.evaluate((element) => {
    element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
  });
  const before = await scrollContainer.evaluate((element) => element.scrollTop);
  expect(before).toBeGreaterThan(100);

  // Returning to About unmounts Activities; the next switch mounts it again.
  for (const section of ["Holdings", "About", "Holdings"] as const) {
    await page.getByRole("button", { name: `Go to ${section}`, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`tab=${section.toLowerCase()}`));
    await expect(page.getByRole("status")).toHaveText(section);

    // Observe through carousel settling and any smooth scroll the newly mounted
    // neighboring virtualizer might initiate, including temporary jumps.
    const offsets = await scrollContainer.evaluate(
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
    expect(Math.abs(offsets.min - before)).toBeLessThanOrEqual(1);
    expect(Math.abs(offsets.max - before)).toBeLessThanOrEqual(1);
  }

  await page.getByRole("button", { name: "Go to Activities", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Activities");
  await expect(page.getByRole("link").filter({ hasText: "Buy" })).toBeVisible();
});
