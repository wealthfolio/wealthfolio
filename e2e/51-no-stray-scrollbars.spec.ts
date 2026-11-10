import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

// Up to 1024px, globals.css clips every .flex and .grid box sideways. With
// overflow-x: hidden that also made each box scroll vertically, so a button's tap
// layer or a glyph a few pixels past its box drew a thin scrollbar wherever
// scrollbars are always shown. A real scroll area moves far more than this.
const STRAY_OVERFLOW_PX = 12;

const api = `${BASE_URL}/api/v1`;

async function seedAccount(page: Page) {
  const account = await page.request.post(`${api}/accounts`, {
    data: {
      name: `Stray scrollbars ${Date.now().toString(36)}`,
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(account.ok(), await account.text()).toBeTruthy();
  const { id } = (await account.json()) as { id: string };
  const deposit = await page.request.post(`${api}/activities`, {
    data: {
      accountId: id,
      activityType: "DEPOSIT",
      activityDate: "2024-01-02T15:00:00Z",
      amount: 1000,
      currency: "USD",
      fee: 0,
      needsReview: false,
    },
  });
  expect(deposit.ok(), await deposit.text()).toBeTruthy();
}

/** Boxes that scroll by only a few pixels: the overflow is a stray, not content. */
function strayScrollers(page: Page, maxOverflow: number) {
  return page.evaluate((limit) => {
    return [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => {
        // A box that names its own overflow is meant to scroll; this checks the rule's boxes.
        if (String(element.className).includes("overflow")) return false;
        const style = getComputedStyle(element);
        if (!/(auto|scroll)/.test(style.overflowY)) return false;
        if (element.getBoundingClientRect().height === 0) return false;
        const overflow = element.scrollHeight - element.clientHeight;
        return overflow > 0 && overflow <= limit;
      })
      .map((element) => `${element.tagName}.${String(element.className).slice(0, 80)}`);
  }, maxOverflow);
}

const ROUTES = [
  "/dashboard",
  "/holdings",
  "/insights?tab=overview",
  "/insights?tab=performance",
  "/insights?tab=income",
  "/activities",
  "/settings/general",
];

test.describe("no stray scrollbars on narrow screens", () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    await completeOnboardingIfNeeded(page);
    await seedAccount(page);
    await page.close();
  });

  for (const width of [375, 800, 1024]) {
    test(`flex and grid boxes do not scroll a few pixels at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 812 });
      await completeOnboardingIfNeeded(page);
      for (const route of ROUTES) {
        await gotoAppPath(page, route);
        await page.waitForLoadState("networkidle");
        await expect
          .poll(() => strayScrollers(page, STRAY_OVERFLOW_PX), { message: route })
          .toEqual([]);
      }
    });
  }
});
