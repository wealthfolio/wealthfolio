import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

for (const direction of ["ltr", "rtl"]) {
  for (const activityType of ["FEE", "TAX"]) {
    test(`${direction}: an unrelated ${activityType} edit preserves the exact FX rate`, async ({
      page,
    }) => {
      await completeOnboardingIfNeeded(page);
      const api = `${BASE_URL}/api/v1`;
      const accountResponse = await page.request.post(`${api}/accounts`, {
        data: {
          name: `Charge FX ${direction} ${activityType} ${Date.now()}`,
          accountType: "SECURITIES",
          currency: "USD",
          isDefault: false,
          isActive: true,
          trackingMode: "TRANSACTIONS",
        },
      });
      expect(accountResponse.ok(), await accountResponse.text()).toBeTruthy();
      const account = (await accountResponse.json()) as { id: string };
      const fxRate = "1.234567890123456789";
      const createdResponse = await page.request.post(`${api}/activities`, {
        data: {
          accountId: account.id,
          activityType,
          activityDate: "2026-04-01T12:00:00Z",
          amount: "5",
          currency: "EUR",
          fxRate,
        },
      });
      expect(createdResponse.ok(), await createdResponse.text()).toBeTruthy();
      const created = (await createdResponse.json()) as { id: string; fxRate: string };
      expect(created.fxRate).toBe(fxRate);

      await gotoAppPath(
        page,
        `/activities?tab=investments&activity=${created.id}&dir=${direction}`,
      );
      await page.getByRole("button", { name: "Open", exact: true }).first().click();
      await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
      const dialog = page.getByTestId("activity-form-dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByTestId("advanced-options-button").click();
      await dialog.locator('textarea[name="comment"]').fill("Edited note only");
      const savedResponse = page.waitForResponse(
        (response) =>
          response.url().endsWith("/activities") && response.request().method() === "PUT",
      );
      await dialog.locator('button[type="submit"]').click();
      const saved = await savedResponse;
      expect(saved.ok(), await saved.text()).toBeTruthy();
      expect(saved.request().postDataJSON()).not.toHaveProperty("fxRate");
      await expect(dialog).toBeHidden();

      const storedResponse = await page.request.post(`${api}/activities/search`, {
        data: { page: 0, pageSize: 10, activityIdFilter: [created.id] },
      });
      expect(storedResponse.ok()).toBeTruthy();
      const stored = (await storedResponse.json()) as {
        data: Array<{ fxRate: string; comment: string }>;
      };
      expect(stored.data).toHaveLength(1);
      expect(stored.data[0]).toMatchObject({ fxRate, comment: "Edited note only" });
    });
  }
}
