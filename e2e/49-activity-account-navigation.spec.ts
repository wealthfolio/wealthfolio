import { api, type ApiAccount } from "./api";
import { expect, test } from "./fixtures";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

for (const direction of ["ltr", "rtl"] as const) {
  test(`manual holdings activity shortcut opens its account in ${direction}`, async ({ page }) => {
    await completeOnboardingIfNeeded(page);
    const name = `Activity shortcut ${direction} ${Date.now().toString(36)}`;
    const { id } = await api<ApiAccount>(page, "POST", "/accounts", {
      name,
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      isArchived: false,
      trackingMode: "HOLDINGS",
    });

    await gotoAppPath(page, `/activities/manage?account=${id}&dir=${direction}`);
    await expect(page.locator("html")).toHaveAttribute("dir", direction);
    await page.getByRole("button", { name: "Go to Account", exact: true }).click();

    await expect(page).toHaveURL(new RegExp(`/accounts/${id}(?:\\?|$)`));
    await expect(page.getByRole("button", { name: "Switch account", exact: true })).toContainText(
      name,
    );
  });
}
