import { expect, test } from "@playwright/test";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";
import { api, createAccount, updateSettings } from "./api";

test.use({ locale: "ar-EG", permissions: ["clipboard-read", "clipboard-write"] });

for (const { region, switchRegion } of [
  { region: "DE", switchRegion: false },
  { region: "system", switchRegion: false },
  { region: "DE", switchRegion: true },
] as const) {
  for (const direction of ["ltr", "rtl"] as const) {
    test(`decimal grid copy/edit persists under ${region}${switchRegion ? " to US" : ""} in ${direction}`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: 1600, height: 1000 });
      await completeOnboardingIfNeeded(page);
      const original = await updateSettings(page, { formattingRegion: region });
      try {
        const { id: accountId } = await createAccount(page, {
          name: `Decimal ${region} ${direction} ${Date.now()}`,
        });
        const marker = `decimal-${region}-${direction}-${Date.now()}`;
        for (const [suffix, amount] of [
          ["source", "1.125"],
          ["target", "2.5"],
        ] as const) {
          await api(page, "POST", "/activities", {
            accountId,
            activityType: "DEPOSIT",
            activityDate: "2026-05-11T10:00:00Z",
            currency: "USD",
            amount,
            comment: `${marker}-${suffix}`,
          });
        }

        await gotoAppPath(page, `/activities?dir=${direction}`);
        await expect(page.locator("html")).toHaveAttribute("dir", direction);
        await page.getByTestId("edit-mode-toggle").click();
        const source = page
          .locator('[data-slot="grid-row"]')
          .filter({ hasText: `${marker}-source` });
        const target = page
          .locator('[data-slot="grid-row"]')
          .filter({ hasText: `${marker}-target` });
        const sourceAmount = source.locator('[data-column-id="amount"]');
        const targetAmount = target.locator('[data-column-id="amount"]');
        await expect(sourceAmount).toBeVisible({ timeout: 30_000 });
        await sourceAmount.click();
        await page.evaluate(() => navigator.clipboard.writeText(""));
        await page.keyboard.press("ControlOrMeta+c");
        let localized = region === "DE" ? "1,125" : "١٫١٢٥";
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(localized);
        if (switchRegion) {
          // Remount the grid as a settings route would, without reloading the
          // browser process that owns the in-memory clipboard source locale.
          await page.evaluate((path) => {
            window.history.pushState({}, "", path);
            window.dispatchEvent(new PopStateEvent("popstate"));
          }, `/settings/general?dir=${direction}`);
          const regionSelect = page.getByTestId("formatting-locale-select");
          await regionSelect.click();
          await page.getByPlaceholder("Search...").fill("United States");
          await page.getByRole("option", { name: "United States", exact: true }).click();
          await expect(regionSelect).toHaveText("United States");
          await page.evaluate((path) => {
            window.history.pushState({}, "", path);
            window.dispatchEvent(new PopStateEvent("popstate"));
          }, `/activities?dir=${direction}`);
          await page.getByTestId("edit-mode-toggle").click();
          localized = "1.125";
        }
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
        await input.fill(localized.replace(/5$/, "6").replace(/٥$/, "٦"));
        await input.press("Tab");
        await page.getByRole("button", { name: "Save changes", exact: true }).click();
        await expect(
          page.getByRole("button", { name: "Save changes", exact: true }),
        ).not.toBeVisible();
        await page.reload();

        await expect
          .poll(async () => {
            const { data } = await api<{
              data: { comment: string; amount: string }[];
            }>(page, "POST", "/activities/search", {
              page: 0,
              pageSize: 10,
              accountIdFilter: [accountId],
            });
            return Object.fromEntries(
              data.map((activity) => [activity.comment, Number(activity.amount)]),
            );
          })
          .toEqual({ [`${marker}-source`]: 1.126, [`${marker}-target`]: 1.125 });
      } finally {
        await api(page, "PUT", "/settings", original);
      }
    });
  }
}
