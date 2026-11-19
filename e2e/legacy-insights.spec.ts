import { expect, test } from "./fixtures";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";

test("legacy bookmarks open the Insights tab and survive reload", async ({ page }) => {
  test.setTimeout(120000);
  await completeOnboardingIfNeeded(page);
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    for (const tab of ["income", "performance"]) {
      await page.goto(`${BASE_URL}/${tab}`);
      await expect(page).toHaveURL(`${BASE_URL}/insights?tab=${tab}`);
      await expect(page.getByRole("button", { name: new RegExp(`^${tab}$`, "i") })).toHaveAttribute(
        "aria-current",
        "page",
      );
      await page.reload();
      await expect(page).toHaveURL(`${BASE_URL}/insights?tab=${tab}`);
      await expect(page.getByRole("button", { name: new RegExp(`^${tab}$`, "i") })).toHaveAttribute(
        "aria-current",
        "page",
      );
    }
  }
});
