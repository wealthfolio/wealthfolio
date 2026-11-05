import { expect, test } from "@playwright/test";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

for (const direction of ["ltr", "rtl"] as const) {
  test(`account help uses the browser opener (${direction})`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.addInitScript(() => {
      const openedUrls: string[] = [];
      Object.defineProperty(window, "__openedExternalUrls", { value: openedUrls });
      window.open = (url) => {
        openedUrls.push(String(url));
        return null;
      };
    });
    await completeOnboardingIfNeeded(page);
    await gotoAppPath(page, `/settings/accounts?dir=${direction}`);
    await expect(page.locator("html")).toHaveAttribute("dir", direction);

    const accounts = page.getByTestId("settings-accounts-page").filter({ visible: true });
    await accounts.getByTestId("add-account-header-button").click();
    const form = page.getByTestId("account-modal").filter({ visible: true });
    const help = form.getByRole("link", { name: "Learn more", exact: true });
    await help.click();
    await form.getByTestId("tracking-mode-holdings").click();
    await help.click();

    expect(await page.evaluate(() => Reflect.get(window, "__openedExternalUrls"))).toEqual([
      "https://wealthfolio.app/docs/concepts/tracking-modes/",
      "https://wealthfolio.app/docs/concepts/tracking-modes/",
    ]);
    await expect(form).toBeVisible();
  });
}
