import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { modes, openGallery, overlays, settle } from "./gallery";

// WCAG 2.1 A/AA scan of the gallery at rest and with each overlay open. The
// primitives do not pass cleanly today, so each state records which rules fail
// on how many elements; a change shows up as a difference from the baseline.

const tags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

// Legacy mode collects results inside the page. The default opens a blank page per
// scan, and in WebKit those leftover pages stall a later navigation.
const axe = (page: Page) => new AxeBuilder({ page }).setLegacyMode().withTags(tags);

function count(results: Awaited<ReturnType<AxeBuilder["analyze"]>>, suffix = "") {
  return results.violations.map(({ id, nodes }) => [`${id}${suffix}`, nodes.length] as const);
}

function summary(entries: (readonly [string, number])[]) {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : 1));
  return `${JSON.stringify(Object.fromEntries(sorted), null, 2)}\n`;
}

for (const mode of modes) {
  test(`gallery accessibility, ${mode}`, async ({ page }) => {
    await openGallery(page, { mode });
    await settle(page);
    const results = await axe(page).analyze();
    expect(summary(count(results))).toMatchSnapshot(`a11y-gallery-${mode}.json`);
  });
}

for (const overlay of overlays) {
  test(`${overlay.name} open accessibility`, async ({ page }) => {
    await openGallery(page);
    await overlay.open(page);
    const content = overlay.content(page);
    await expect(content).toBeVisible();
    await settle(page);
    // Contrast behind a backdrop depends on how the engine composites it and is
    // never read, so contrast is checked inside the overlay only.
    await content.evaluate((element) => element.setAttribute("data-axe-scope", ""));
    const overlayResults = await axe(page)
      .withRules(["color-contrast"])
      .include("[data-axe-scope]")
      .analyze();
    const pageResults = await axe(page).disableRules(["color-contrast"]).analyze();
    expect(
      summary([...count(pageResults), ...count(overlayResults, " (overlay)")]),
    ).toMatchSnapshot(`a11y-${overlay.name}.json`);
  });
}
