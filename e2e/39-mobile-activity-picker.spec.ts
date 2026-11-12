import { devices, expect, test } from "@playwright/test";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test.use({
  viewport: { width: 390, height: 844 },
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  hasTouch: true,
});

test.beforeEach(async ({ browser, page }) => {
  const desktop = await browser.newContext({ ...devices["Desktop Chrome"] });
  await completeOnboardingIfNeeded(await desktop.newPage());
  await desktop.close();
  await completeOnboardingIfNeeded(page);
});

for (const scenario of [
  { width: 390, language: "en", direction: "ltr", largeText: false },
  { width: 320, language: "en", direction: "ltr", largeText: false },
  { width: 320, language: "de", direction: "ltr", largeText: true },
  { width: 320, language: "ar", direction: "rtl", largeText: true },
] as const) {
  test(`two-column picker remains usable at ${scenario.width}px, ${scenario.language}, ${scenario.largeText ? "large" : "default"} text`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: scenario.width, height: 844 });
    await gotoAppPath(page, `/activities/manage?dir=${scenario.direction}`);
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radio")).toHaveCount(11);
    const copy = await page.evaluate(async ({ language, largeText }) => {
      const { default: i18n } = await import(new URL("/src/i18n/i18n.ts", location.href).href);
      await i18n.changeLanguage(language);
      if (largeText) document.documentElement.dataset.textSize = "extra-large";
      return {
        buy: i18n.t("activity:type_buy"),
        sell: i18n.t("activity:type_sell"),
        next: i18n.t("activity:mobile_next"),
        back: i18n.t("activity:mobile_back"),
      };
    }, scenario);
    const grid = dialog.getByRole("radiogroup");
    const cards = grid.locator("label");
    const first = (await cards.nth(0).boundingBox())!;
    const second = (await cards.nth(1).boundingBox())!;
    expect(Math.abs(first.y - second.y)).toBeLessThan(1);
    expect(first.height).toBeGreaterThanOrEqual(64);
    expect(Math.abs(first.x - second.x)).toBeGreaterThan(80);
    expect(scenario.direction === "rtl" ? first.x > second.x : first.x < second.x).toBe(true);
    expect(
      await cards.evaluateAll((labels) =>
        labels.every((label) => {
          const text = label.querySelector("span")!;
          return (
            text.scrollWidth <= text.clientWidth + 1 && text.scrollHeight <= text.clientHeight + 1
          );
        }),
      ),
    ).toBe(true);
    const next = dialog.getByRole("button", { name: copy.next, exact: true });
    await expect(next).toBeDisabled();
    const nextBounds = (await next.boundingBox())!;
    if (scenario.width === 390 && !scenario.largeText) {
      const last = (await cards.last().boundingBox())!;
      expect(last.y + last.height).toBeLessThanOrEqual(nextBounds.y);
    }
    await expect(next).toBeInViewport();
    // The last option remains reachable even when translations and large text
    // make the sheet scroll. No type is hidden behind a disclosure control.
    await cards.last().scrollIntoViewIfNeeded();
    await expect(cards.last()).toBeInViewport();
    await expect(next).toBeInViewport();

    const buy = grid.getByRole("radio", { name: copy.buy, exact: true });
    await buy.focus();
    await page.keyboard.press(scenario.direction === "rtl" ? "ArrowLeft" : "ArrowRight");
    const sell = grid.getByRole("radio", { name: copy.sell, exact: true });
    await expect(sell).toHaveAttribute("aria-checked", "true");
    await expect(cards.nth(1)).toHaveCSS("outline-style", "solid");
    await expect(next).toBeEnabled();
    await next.click();
    await expect(grid).toBeHidden();
    await dialog.getByRole("button", { name: copy.back, exact: true }).click();
    await expect(sell).toHaveAttribute("aria-checked", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
