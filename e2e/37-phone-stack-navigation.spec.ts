import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

// The phone layout stacks the screens of Holdings and Settings: a pushed screen
// slides over the one it came from, which stays mounted, and back returns to it
// as it was left. Runs on an iPhone-sized screen with real touch input, so the
// browser's touch handling applies; `?swipe=app` (development builds only)
// turns on the swipe back the iOS app has.
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

test.use({ viewport: { width: 390, height: 844 }, userAgent: IPHONE_UA, hasTouch: true });

test.beforeEach(async ({ page }) => {
  await completeOnboardingIfNeeded(page);
});

const pathOf = (page: Page) => page.evaluate(() => location.pathname);
const historyIndex = (page: Page) =>
  page.evaluate(() => (window.history.state as { idx?: number } | null)?.idx);

/** Id of the screen on top, and of every screen still mounted. */
const screens = (page: Page) =>
  page.evaluate(() => {
    const all = [...document.querySelectorAll("[data-stack-screen]")];
    const shown = all.filter((el) => getComputedStyle(el).display !== "none");
    return {
      top: shown[shown.length - 1]?.getAttribute("data-stack-screen") ?? null,
      mounted: all.map((el) => el.getAttribute("data-stack-screen")),
    };
  });

/** Scroll position of the page's scroll box inside a screen; sets it when `y` is given. */
const screenScroll = (page: Page, screenId: string, y?: number) =>
  page.evaluate(
    ([id, top]) => {
      const layer = document.querySelector(`[data-stack-screen="${id}"]`);
      const box = [layer, ...(layer?.querySelectorAll("*") ?? [])].find(
        (el): el is HTMLElement =>
          el instanceof HTMLElement &&
          el.scrollHeight > el.clientHeight + 20 &&
          /(auto|scroll)/.test(getComputedStyle(el).overflowY),
      );
      if (!box) return null;
      if (top !== undefined) box.scrollTop = top;
      return Math.round(box.scrollTop);
    },
    [screenId, y] as const,
  );

async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] });
  for (let step = 1; step <= 12; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: from.x + ((to.x - from.x) * step) / 12, y: from.y + ((to.y - from.y) * step) / 12 },
      ],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

// Exact: "Back" alone would also match the list's "Backup & Export" row.
const backButton = (page: Page) =>
  page.getByRole("button", { name: "Back", exact: true }).locator("visible=true").first();

async function openSettingsRow(page: Page, name: string) {
  // A finger taps a row on screen; clicking through the DOM keeps Playwright
  // from scrolling the list first.
  await page.evaluate((label) => {
    const row = [...document.querySelectorAll<HTMLElement>(`button[aria-label="${label}"]`)].find(
      (button) => button.offsetParent,
    );
    row?.click();
  }, name);
}

async function openSettings(page: Page, query = "?swipe=app") {
  await gotoAppPath(page, `/settings${query}`);
  await expect(page.getByRole("button", { name: "Portfolios", exact: true })).toBeVisible({
    timeout: 15_000,
  });
}

test("back returns to the same Settings list, where it was left, through history", async ({
  page,
}) => {
  await openSettings(page);
  const list = (await screens(page)).top;
  expect(list).not.toBeNull();
  expect(await screenScroll(page, list!, 200)).toBe(200);
  const listIndex = await historyIndex(page);

  await openSettingsRow(page, "Portfolios");
  await expect.poll(() => pathOf(page)).toBe("/settings/portfolios");
  // The list stays mounted under the pushed screen.
  await expect.poll(async () => (await screens(page)).mounted).toContain(list);

  await backButton(page).click();
  await expect.poll(() => pathOf(page)).toBe("/settings");
  // The screen leaving slides out first.
  await expect.poll(async () => (await screens(page)).top).toBe(list);
  expect(await screenScroll(page, list!)).toBe(200);
  // Back went back in history instead of adding an entry.
  expect(await historyIndex(page)).toBe(listIndex);
});

test("a swipe from the left edge goes back; a short one, a scroll or a tap does not", async ({
  page,
}) => {
  await openSettings(page);
  const list = (await screens(page)).top;

  // A vertical drag that starts at the edge scrolls the list.
  await touchDrag(page, { x: 6, y: 700 }, { x: 8, y: 300 });
  await expect.poll(() => screenScroll(page, list!)).toBeGreaterThan(100);
  await screenScroll(page, list!, 0);

  await openSettingsRow(page, "General");
  await expect.poll(() => pathOf(page)).toBe("/settings/general");
  await page.waitForTimeout(600);

  await touchDrag(page, { x: 4, y: 500 }, { x: 60, y: 500 });
  await page.waitForTimeout(800);
  expect(await pathOf(page)).toBe("/settings/general");

  await touchDrag(page, { x: 4, y: 500 }, { x: 304, y: 500 });
  await expect.poll(() => pathOf(page)).toBe("/settings");
  // The screen leaving slides out first.
  await expect.poll(async () => (await screens(page)).top).toBe(list);
});

test("a swipe released while moving back toward the edge stays on the screen", async ({ page }) => {
  await openSettings(page);
  await openSettingsRow(page, "General");
  await expect.poll(() => pathOf(page)).toBe("/settings/general");
  await page.waitForTimeout(600);

  // Past 60% of the width, then a quick flick back to 45% before lifting.
  const cdp = await page.context().newCDPSession(page);
  const point = (x: number) => ({ x, y: 500 });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(4)] });
  for (let x = 24; x <= 244; x += 20) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(x)] });
    await page.waitForTimeout(16);
  }
  for (const x of [220, 196, 175]) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(x)] });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();

  await page.waitForTimeout(800);
  expect(await pathOf(page)).toBe("/settings/general");
});

test("in right-to-left the swipe starts at the right edge", async ({ page }) => {
  await openSettings(page, "?dir=rtl&swipe=app");
  await openSettingsRow(page, "General");
  await expect.poll(() => pathOf(page)).toBe("/settings/general");
  await page.waitForTimeout(600);

  await touchDrag(page, { x: 4, y: 500 }, { x: 304, y: 500 });
  await page.waitForTimeout(800);
  expect(await pathOf(page)).toBe("/settings/general");

  await touchDrag(page, { x: 386, y: 500 }, { x: 86, y: 500 });
  await expect.poll(() => pathOf(page)).toBe("/settings");
});

test("leaving Settings and coming back shows the screen that was open", async ({ page }) => {
  await openSettings(page);
  const list = (await screens(page)).top;
  await openSettingsRow(page, "General");
  await expect.poll(() => pathOf(page)).toBe("/settings/general");
  await expect.poll(async () => (await screens(page)).top).not.toBe(list);
  const general = (await screens(page)).top;

  const nav = page.getByRole("navigation", { name: "Primary navigation" });
  await nav.locator("a").first().click();
  await expect.poll(() => pathOf(page)).toBe("/dashboard");
  await nav.getByLabel("More options").click();
  await page.getByRole("link", { name: /^Settings$/ }).click();
  await expect.poll(() => pathOf(page)).toBe("/settings/general");
  await expect.poll(async () => (await screens(page)).top).toBe(general);

  await backButton(page).click();
  await expect.poll(() => pathOf(page)).toBe("/settings");
  // The screen leaving slides out first.
  await expect.poll(async () => (await screens(page)).top).toBe(list);
});

test("a link to a nested page opens with its parent pages under it", async ({ page }) => {
  await gotoAppPath(page, "/settings/market-data/import");
  await expect.poll(async () => (await screens(page)).mounted.length, { timeout: 15_000 }).toBe(3);

  await backButton(page).click();
  await expect.poll(() => pathOf(page)).toBe("/settings/market-data");
  await backButton(page).click();
  await expect.poll(() => pathOf(page)).toBe("/settings");
});

test("a holding opens over the Holdings list and back returns to it", async ({ page }) => {
  test.setTimeout(120_000);
  const runId = Date.now().toString(36);
  const account = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
    data: {
      name: `Stack ${runId}`,
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
  const symbol = `STACK${runId.toUpperCase()}`;
  const buy = await page.request.post(`${BASE_URL}/api/v1/activities`, {
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
        name: "Stack asset",
        symbol,
        kind: "INVESTMENT",
        quoteCcy: "USD",
        quoteMode: "MANUAL",
      },
    },
  });
  expect(buy.ok(), await buy.text()).toBeTruthy();
  const assetId = ((await buy.json()) as { assetId: string }).assetId;
  await expect
    .poll(
      async () => {
        const response = await page.request.post(`${BASE_URL}/api/v1/holdings/list/query`, {
          data: { filter: { type: "account", accountId }, includeClosed: true },
        });
        const holdings = (await response.json()) as { instrument?: { id: string } }[];
        return holdings.some((holding) => holding.instrument?.id === assetId);
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  await gotoAppPath(page, "/holdings?swipe=app");
  const holding = page.getByText(symbol, { exact: true }).locator("visible=true").first();
  await expect(holding).toBeVisible({ timeout: 15_000 });
  const list = (await screens(page)).top;
  const listIndex = await historyIndex(page);

  // A double tap opens the holding once, also on a phone slow enough that the
  // second tap comes before the holding's page has rendered.
  await holding.scrollIntoViewIfNeeded();
  const box = await holding.boundingBox();
  const [x, y] = [box!.x + box!.width / 2, box!.y + box!.height / 2];
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  await page.touchscreen.tap(x, y);
  await page.waitForTimeout(80);
  await page.touchscreen.tap(x, y);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await cdp.detach();
  await expect.poll(() => pathOf(page)).toBe(`/holdings/${encodeURIComponent(assetId)}`);
  await page.waitForTimeout(600);
  expect(await historyIndex(page)).toBe(listIndex! + 1);

  await touchDrag(page, { x: 4, y: 600 }, { x: 304, y: 600 });
  await expect.poll(() => pathOf(page)).toBe("/holdings");
  // The screen leaving slides out first.
  await expect.poll(async () => (await screens(page)).top).toBe(list);
});
