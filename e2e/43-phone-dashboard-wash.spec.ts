import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

const api = `${BASE_URL}/api/v1`;

async function seedCashAccount(page: Page) {
  const account = await page.request.post(`${api}/accounts`, {
    data: {
      name: `Dashboard wash ${Date.now().toString(36)}`,
      accountType: "CASH",
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

// Scrolls the visible dashboard tab to its end and measures its coloured wash.
async function measureWash(page: Page) {
  return page.evaluate(async () => {
    const pane = [...document.querySelectorAll<HTMLElement>("[data-virtual-scroll-parent]")].find(
      (element) => {
        const box = element.getBoundingClientRect();
        return (
          box.width > 0 && Math.abs(box.left) < 1 && element.querySelector('[style*="gradient"]')
        );
      },
    );
    if (!pane) return null;
    const wash = pane.querySelector<HTMLElement>('[style*="gradient"]')!;
    pane.scrollTop = pane.scrollHeight;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const nav = document.querySelector('nav[aria-label="Primary navigation"]')!;
    const cardBottoms = [...pane.querySelectorAll('[data-slot="card"]')].map(
      (card) => card.getBoundingClientRect().bottom,
    );
    return {
      scrolls: pane.scrollHeight > pane.clientHeight,
      bandBelowWash: pane.getBoundingClientRect().bottom - wash.getBoundingClientRect().bottom,
      lastCardBottom: cardBottoms.length ? Math.max(...cardBottoms) : null,
      navTop: nav.getBoundingClientRect().top,
    };
  });
}

test("phone dashboard tabs paint their wash down to the bottom of the screen", async ({ page }) => {
  test.setTimeout(120_000);
  await completeOnboardingIfNeeded(page);
  await seedCashAccount(page);

  for (const tab of ["investments", "net-worth"]) {
    for (const { viewport, scrolls } of [
      // Content longer than the screen: no plain band below the wash at the end.
      { viewport: { width: 375, height: 667 }, scrolls: true },
      // Content shorter than the screen: the wash still fills it.
      { viewport: { width: 393, height: 4000 }, scrolls: false },
    ]) {
      await page.setViewportSize(viewport);
      await gotoAppPath(page, `/dashboard?tab=${tab}`);
      await expect(async () => {
        const layout = await measureWash(page);
        expect(layout, `${tab} wash not found`).not.toBeNull();
        expect(layout!.scrolls).toBe(scrolls);
        expect(Math.abs(layout!.bandBelowWash)).toBeLessThanOrEqual(1);
        // The nav bar floats over the content: the last card must end above it.
        if (layout!.lastCardBottom !== null) {
          expect(layout!.lastCardBottom).toBeLessThanOrEqual(layout!.navTop + 1);
        }
      }, `${tab} at ${viewport.width}×${viewport.height}`).toPass({ timeout: 30_000 });
    }
  }
});
