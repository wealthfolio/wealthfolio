import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

// Safari (WebKit) clamps a scroll position as soon as anything measures the
// layout. Switching an account's sections used to measure the page while one
// section was gone and the other not yet in, and the page kept the clamped,
// higher position. Chromium does not show it, so this file runs in WebKit.
test.use({
  browserName: "webkit",
  // The suite's project picks Chrome's channel; an empty one runs Playwright's WebKit.
  channel: "",
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
});

test("switching an account's sections keeps the page where it was", async ({ page }) => {
  test.setTimeout(120_000);
  await completeOnboardingIfNeeded(page);

  const runId = Date.now().toString(36).toUpperCase();
  const account = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
    data: {
      name: `Section scroll ${runId}`,
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      isArchived: false,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(account.ok(), await account.text()).toBeTruthy();
  const accountId = ((await account.json()) as { id: string }).id;

  // Enough holdings for the section to fill the screen below the switch.
  for (let index = 0; index < 10; index++) {
    const buy = await page.request.post(`${BASE_URL}/api/v1/activities`, {
      data: {
        accountId,
        activityType: "BUY",
        activityDate: "2024-01-02T15:00:00Z",
        currency: "USD",
        fee: 0,
        needsReview: false,
        quantity: 10,
        unitPrice: 100 + index,
        asset: {
          name: `Section scroll asset ${index}`,
          symbol: `SEC${runId}${index}`,
          kind: "INVESTMENT",
          quoteCcy: "USD",
          quoteMode: "MANUAL",
        },
      },
    });
    expect(buy.ok(), await buy.text()).toBeTruthy();
  }
  await expect
    .poll(
      async () => {
        const response = await page.request.post(`${BASE_URL}/api/v1/holdings/list/query`, {
          data: { filter: { type: "account", accountId }, includeClosed: true },
        });
        return ((await response.json()) as unknown[]).length;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(10);

  await gotoAppPath(page, `/accounts/${accountId}`);
  // On a phone the account page opens over the Dashboard, which stays mounted.
  const container = page.locator("[data-page-scroll-container]:visible");
  const activities = page.getByRole("button", { name: "Activities", exact: true });
  await expect(activities).toBeVisible({ timeout: 15_000 });
  await expect(container.getByText(`SEC${runId}9`, { exact: true })).toBeVisible();

  // Bring the section switch near the top, with the holdings filling the screen.
  const before = await container.evaluate((element) => {
    const toggle = [...element.querySelectorAll<HTMLElement>('[role="group"]')].find((group) =>
      /Activities/.test(group.textContent ?? ""),
    );
    const offset =
      (toggle?.getBoundingClientRect().top ?? 0) - element.getBoundingClientRect().top - 120;
    element.style.scrollBehavior = "auto";
    element.scrollTop += offset;
    element.style.scrollBehavior = "";
    return element.scrollTop;
  });
  expect(before).toBeGreaterThan(100);

  for (const section of ["Activities", "Holdings"] as const) {
    await page.getByRole("button", { name: section, exact: true }).click();
    await expect(page.getByRole("button", { name: section, exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Watch the whole settling interval, so a jump that stays also fails.
    const offsets = await container.evaluate(
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
    expect(Math.abs(offsets.min - before), `${section}: lowest offset`).toBeLessThanOrEqual(1);
    expect(Math.abs(offsets.max - before), `${section}: highest offset`).toBeLessThanOrEqual(1);
  }
});
