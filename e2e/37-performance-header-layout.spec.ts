import { expect, test } from "./fixtures";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test("Performance filters stay clear of the page tabs at tablet and desktop widths", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await completeOnboardingIfNeeded(page);

  for (const direction of ["ltr", "rtl"]) {
    for (const width of [768, 1024, 1280, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await gotoAppPath(page, `/insights?tab=performance&dir=${direction}`);

      const incomeTab = page
        .getByRole("button", { name: "Income", exact: true })
        .filter({ visible: true });
      const scopeSelector = page
        .locator('[aria-label^="Select account scope:"]')
        .filter({ visible: true });
      await expect(incomeTab).toBeVisible();
      await expect(scopeSelector).toBeVisible();

      await expect(async () => {
        const navigation = await incomeTab.locator("xpath=..").boundingBox();
        const controls = await scopeSelector.locator("xpath=..").boundingBox();
        expect(navigation).not.toBeNull();
        expect(controls).not.toBeNull();
        if (!navigation || !controls) return;

        const overlapWidth = Math.max(
          0,
          Math.min(navigation.x + navigation.width, controls.x + controls.width) -
            Math.max(navigation.x, controls.x),
        );
        const overlapHeight = Math.max(
          0,
          Math.min(navigation.y + navigation.height, controls.y + controls.height) -
            Math.max(navigation.y, controls.y),
        );
        expect(overlapWidth * overlapHeight, `${width}px ${direction}`).toBe(0);
      }).toPass({ timeout: 5_000 });
    }
  }
});
