import { expect, test, type Page, type Response } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

function allTimeResponse(page: Page, itemId: string) {
  return page.waitForResponse((response: Response) => {
    if (!response.url().endsWith("/performance/history") || !response.ok()) return false;
    const body = response.request().postDataJSON();
    return (
      body.itemType === "account" && body.itemId === itemId && !body.startDate && !body.endDate
    );
  });
}

for (const mobile of [false, true]) {
  for (const direction of ["ltr", "rtl"] as const) {
    test(`Performance ALL calendar preserves its selection on ${mobile ? "mobile" : "desktop"} in ${direction}`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: mobile ? 393 : 1440, height: 900 });
      await completeOnboardingIfNeeded(page);
      const account = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
        data: {
          name: `Calendar ${mobile}-${direction}`,
          accountType: "SECURITIES",
          currency: "USD",
          isDefault: false,
          isActive: true,
          trackingMode: "TRANSACTIONS",
        },
      });
      expect(account.ok()).toBeTruthy();
      const { id } = await account.json();
      const deposit = await page.request.post(`${BASE_URL}/api/v1/activities`, {
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
      expect(deposit.ok()).toBeTruthy();
      // The account's history is calculated in the background after the deposit.
      await expect
        .poll(
          async () => {
            const history = await page.request.post(`${BASE_URL}/api/v1/performance/history`, {
              data: { itemType: "account", itemId: id, filter: { type: "account", accountId: id } },
            });
            return history.ok() ? (await history.json()).period?.startDate : null;
          },
          { timeout: 60_000 },
        )
        .toMatch(/^2024-01-/);
      // Earlier specs leave older activities in the shared profile: chart only this account.
      const state = await (
        await page.request.post(`${BASE_URL}/api/v1/profiles/get_profile_state`, { data: {} })
      ).json();
      await page.addInitScript(
        ({ profileId, item }) => {
          const key = (name: string) => `profile:${profileId}:${name}`;
          localStorage.setItem(key("performance:selectedItems"), JSON.stringify([item]));
          localStorage.setItem(key("performance:selectedItemId"), JSON.stringify(item.id));
        },
        {
          profileId: state.session?.profileId ?? state.profiles[0].id,
          item: {
            id,
            type: "account",
            name: `Calendar ${mobile}-${direction}`,
            accountScope: { type: "account", accountId: id },
          },
        },
      );
      await gotoAppPath(page, `/insights?tab=performance&dir=${direction}`);
      const all = page.getByRole("button", { name: "ALL", exact: true }).filter({ visible: true });
      const responsePromise = allTimeResponse(page, id);
      await all.click();
      const response = await responsePromise;
      const { period } = await response.json();
      expect(period.startDate).toMatch(/^2024-01-/);
      const calendar = page
        .getByRole("button", { name: "Choose custom date range" })
        .filter({ visible: true });
      await calendar.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("January 2024", { exact: true })).toBeVisible();
      await expect(dialog.locator(`button[data-day="${period.startDate}"]`)).toHaveAttribute(
        "data-range-start",
        "true",
      );
      if (mobile) {
        await dialog.getByRole("button", { name: "Done", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        // Reload crosses the persistence boundary and starts a fresh query.
        const persisted = allTimeResponse(page, id);
        await page.reload();
        await persisted;

        await page
          .getByRole("button", { name: "1Y", exact: true })
          .filter({ visible: true })
          .click();
        await calendar.click();
        await dialog.getByRole("button", { name: "Clear", exact: true }).click();
        await dialog.getByRole("button", { name: "Done", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        const cleared = allTimeResponse(page, id);
        await page.reload();
        await cleared;
      } else {
        await page.keyboard.press("Escape");
      }
      await expect(all).toHaveAttribute("aria-pressed", "true");
    });
  }
}
