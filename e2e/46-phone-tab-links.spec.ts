import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

const api = `${BASE_URL}/api/v1`;

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
