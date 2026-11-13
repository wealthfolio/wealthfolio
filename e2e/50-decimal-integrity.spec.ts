import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test.use({ locale: "ar-EG", permissions: ["clipboard-read", "clipboard-write"] });

for (const region of ["DE", "system"] as const) {
  for (const direction of ["ltr", "rtl"] as const) {
    test(`decimal grid copy/edit persists under ${region} in ${direction}`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: 1600, height: 1000 });
      await completeOnboardingIfNeeded(page);
      const api = `${BASE_URL}/api/v1`;
      const settings = await page.request.put(`${api}/settings`, {
        data: { formattingRegion: region },
      });
      expect(settings.ok(), await settings.text()).toBeTruthy();
      const account = await page.request.post(`${api}/accounts`, {
        data: {
          name: `Decimal ${region} ${direction} ${Date.now()}`,
          accountType: "SECURITIES",
          currency: "USD",
          isDefault: false,
          isActive: true,
          isArchived: false,
          trackingMode: "TRANSACTIONS",
        },
      });
      expect(account.ok(), await account.text()).toBeTruthy();
      const { id: accountId } = (await account.json()) as { id: string };
      const marker = `decimal-${region}-${direction}-${Date.now()}`;
      for (const [suffix, amount] of [
        ["source", "1.125"],
        ["target", "2.5"],
      ] as const) {
        const created = await page.request.post(`${api}/activities`, {
          data: {
            accountId,
            activityType: "DEPOSIT",
            activityDate: "2026-05-11T10:00:00Z",
            currency: "USD",
            amount,
            comment: `${marker}-${suffix}`,
          },
        });
        expect(created.ok(), await created.text()).toBeTruthy();
      }

      await gotoAppPath(page, `/activities?dir=${direction}`);
      await expect(page.locator("html")).toHaveAttribute("dir", direction);
      await page.getByTestId("edit-mode-toggle").click();
      const source = page.locator('[data-slot="grid-row"]').filter({ hasText: `${marker}-source` });
      const target = page.locator('[data-slot="grid-row"]').filter({ hasText: `${marker}-target` });
      const sourceAmount = source.locator('[data-column-id="amount"]');
      const targetAmount = target.locator('[data-column-id="amount"]');
      await expect(sourceAmount).toBeVisible({ timeout: 30_000 });
      await sourceAmount.click();
      await page.evaluate(() => navigator.clipboard.writeText(""));
      await page.keyboard.press("ControlOrMeta+c");
      const localized = region === "DE" ? "1,125" : "١٫١٢٥";
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(localized);
      await targetAmount.click();
      await page.keyboard.press("ControlOrMeta+v");
      await targetAmount.dblclick();
      await expect(targetAmount.getByRole("textbox")).toHaveValue(localized);
      await page.keyboard.press("Escape");
      await expect(page.locator('[data-slot="grid-cell-wrapper"][data-focused]')).toBeFocused();

      await sourceAmount.click();
      await expect(sourceAmount.locator('[data-slot="grid-cell-wrapper"]')).toBeFocused();
      await page.keyboard.press("F2");
      const input = sourceAmount.getByRole("textbox");
      await expect(input).toHaveValue(localized);
      if (region === "system") {
        await input.fill(".١٢٥");
        await input.press("Tab");
        await expect(page.locator('[data-slot="grid-cell-wrapper"][data-focused]')).toBeFocused();
        await sourceAmount.click();
        await expect(sourceAmount.locator('[data-slot="grid-cell-wrapper"]')).toBeFocused();
        await page.keyboard.press("F2");
        await expect(input).toHaveValue(localized);
      }
      await input.fill(region === "DE" ? "1,126" : "١٫١٢٦");
      await input.press("Tab");
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Save changes", exact: true }),
      ).not.toBeVisible();
      await page.reload();

      await expect
        .poll(async () => {
          const response = await page.request.post(`${api}/activities/search`, {
            data: { page: 0, pageSize: 10, accountIdFilter: [accountId] },
          });
          expect(response.ok()).toBeTruthy();
          const { data } = (await response.json()) as {
            data: { comment: string; amount: string }[];
          };
          return Object.fromEntries(
            data.map((activity) => [activity.comment, Number(activity.amount)]),
          );
        })
        .toEqual({ [`${marker}-source`]: 1.126, [`${marker}-target`]: 1.125 });
    });
  }
}
