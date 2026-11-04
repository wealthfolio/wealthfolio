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

for (const dir of ["ltr", "rtl"]) {
  test(`Add Asset fits its content across steps and keyboard resizing in ${dir}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 1100 });
    await gotoAppPath(page, `/?tab=net-worth&dir=${dir}`);
    await page.getByRole("button", { name: "More options", exact: true }).first().click();
    await page.getByRole("button", { name: "Add Asset", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Add New Asset", exact: true })).toBeVisible();
    const kinds = dialog
      .locator("button")
      .filter({ hasText: /Property|Vehicle|Collectible|Precious Metal|Liability|Other Asset/ });
    await expect(kinds).toHaveCount(6);
    expect((await dialog.boundingBox())!.height).toBeLessThan(880);
    const lastKind = (await kinds.last().boundingBox())!;
    const next = dialog.getByRole("button", { name: "Continue", exact: true });
    expect((await next.boundingBox())!.y - lastKind.y - lastKind.height).toBeLessThan(64);
    await kinds.first().click();
    await next.click();
    await expect(dialog.getByRole("heading", { name: "Property", exact: true })).toBeVisible();
    const save = dialog.getByRole("button", { name: "Create Asset", exact: true });
    await expect(save).toBeInViewport();
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--keyboard-inset-bottom", "400px"),
    );
    await expect
      .poll(async () => {
        const bounds = (await save.boundingBox())!;
        return bounds.y + bounds.height;
      })
      .toBeLessThanOrEqual(700);
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--keyboard-inset-bottom", "0px"),
    );
    await dialog.getByRole("button", { name: "Back", exact: true }).click();
    await expect(kinds).toHaveCount(6);
    await expect(next).toBeInViewport();
    expect((await dialog.boundingBox())!.height).toBeLessThan(880);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
