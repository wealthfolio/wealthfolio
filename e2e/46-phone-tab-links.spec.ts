import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

const api = `${BASE_URL}/api/v1`;

// Where the shown phone tab sits on screen (0 when aligned) and how far the carousel's
// clipping window has been scrolled sideways (always 0: the carousel moves its track).
function carouselPlacement(page: Page) {
  return page.evaluate(() => {
    const track = [...document.querySelectorAll<HTMLElement>(".touch-pan-y")].find(
      (element) => element.style.transform && element.firstElementChild?.matches(".basis-full"),
    );
    const shown = [...(track?.children ?? [])].find((slide) => !slide.hasAttribute("inert"));
    return {
      shownLeft: shown ? Math.round(shown.getBoundingClientRect().left) : null,
      windowScroll: track?.parentElement?.scrollLeft ?? null,
    };
  });
}

// Insights' Spending tab mounts beside Income and scrolls its stage pill into view. That
// scrolled the carousel's clipping window sideways too, leaving Income and Spending half on
// screen, and every later tab shifted by the same amount.
test("Insights' Income tab stays in place when the Spending tab mounts beside it", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await completeOnboardingIfNeeded(page);

  const previousSettings = await (await page.request.get(`${api}/spending/settings`)).json();
  try {
    const enable = await page.request.put(`${api}/spending/settings`, {
      data: { ...previousSettings, enabled: true },
    });
    expect(enable.ok(), await enable.text()).toBeTruthy();

    await gotoAppPath(page, "/insights?tab=income");
    // The Spending tab's stage pills: mounted beside Income, off screen.
    await expect(
      page
        .getByRole("navigation", { name: /stages/i })
        .or(page.getByText("Where I am"))
        .first(),
    ).toBeAttached();
    await page.waitForTimeout(1000);
    expect(await carouselPlacement(page)).toEqual({ shownLeft: 0, windowScroll: 0 });
  } finally {
    await page.request.put(`${api}/spending/settings`, { data: previousSettings });
  }
});

// Spending joins the dashboard's and Insights' tabs only once settings load, after the
// phone carousel is built. A link to it must still open it, not the tab before it.
test("phone links open the Spending tab of the dashboard and Insights", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await completeOnboardingIfNeeded(page);

  const previousSettings = await (await page.request.get(`${api}/spending/settings`)).json();
  try {
    const enable = await page.request.put(`${api}/spending/settings`, {
      data: { ...previousSettings, enabled: true },
    });
    expect(enable.ok(), await enable.text()).toBeTruthy();

    for (const path of ["/dashboard?tab=spending", "/insights?tab=spending"]) {
      await gotoAppPath(page, path);
      const spendingPill = page
        .getByRole("button", { name: "Spending", exact: true })
        .filter({ visible: true });
      await expect(spendingPill).toHaveAttribute("aria-current", "page");
      // The wrong tab took over about a second after load, once the carousel re-initialised.
      await page.waitForTimeout(1500);
      await expect(spendingPill).toHaveAttribute("aria-current", "page");
      expect(new URL(page.url()).search, path).toBe("?tab=spending");
    }
  } finally {
    await page.request.put(`${api}/spending/settings`, { data: previousSettings });
  }
});
