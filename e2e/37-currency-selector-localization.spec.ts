import { expect, test } from "@playwright/test";
import zhActivity from "../apps/frontend/src/i18n/locales/zh/activity.json" with { type: "json" };
import zhCommon from "../apps/frontend/src/i18n/locales/zh/common.json" with { type: "json" };
import zhSettings from "../apps/frontend/src/i18n/locales/zh/settings.json" with { type: "json" };
import { BASE_URL, completeOnboardingIfNeeded, createAccount } from "./helpers";

for (const direction of ["ltr", "rtl"] as const) {
  test(`currency selectors localize names while retaining codes in ${direction}`, async ({
    page,
  }) => {
    test.setTimeout(120000);
    await completeOnboardingIfNeeded(page);
    const accountName = `Currency localization ${direction}`;
    await createAccount(page, accountName, "USD");
    const settingsUrl = `${BASE_URL}/api/v1/settings`;
    const saved = await page.request.put(settingsUrl, { data: { language: "zh" } });
    expect(saved.ok()).toBe(true);
    try {
      await page.goto(`${BASE_URL}/settings/general?dir=${direction}`);
      await expect(page.locator("html")).toHaveAttribute("dir", direction);
      await page.getByRole("button", { name: zhSettings.fx_add, exact: true }).first().click();
      const dialog = page.getByRole("dialog", { name: zhSettings.fx_add_title });
      const from = dialog.getByRole("combobox", { name: zhSettings.fx_from_currency });
      await from.click();
      await page
        .getByPlaceholder(zhSettings.fx_search_currency)
        .filter({ visible: true })
        .fill("人民币");
      await page.getByRole("option", { name: "人民币 (CNY)", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(from).toHaveText("人民币 (CNY)");
      await dialog.getByRole("combobox", { name: zhSettings.fx_to_currency }).click();
      await page
        .getByPlaceholder(zhSettings.fx_search_currency)
        .filter({ visible: true })
        .fill("United States");
      await page.getByRole("option", { name: "美元 (USD)", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(dialog.getByRole("combobox", { name: zhSettings.fx_to_currency })).toHaveText(
        "美元 (USD)",
      );
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();

      await page.goto(`${BASE_URL}/import?dir=${direction}`);
      await page.getByRole("combobox", { name: zhCommon.component.select_an_account }).click();
      await page.getByRole("option", { name: new RegExp(accountName) }).click();
      await page.locator('input[type="file"]').setInputFiles({
        name: "currency-localization.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(
          "date,symbol,instrumentType,quantity,activityType,unitPrice,currency,fee,amount,fxRate,subtype\n2026-05-10,,,1,DEPOSIT,1,USD,0,100,,\n",
        ),
      });
      await page
        .getByRole("button", { name: zhActivity.import.toolbar.configureMapping, exact: true })
        .click();
      await page
        .getByRole("button", { name: zhActivity.import.steps.reviewAssets, exact: true })
        .click();
      await page
        .getByRole("button", { name: zhActivity.import.steps.reviewActivities, exact: true })
        .click();
      const selection = page.getByRole("checkbox", {
        name: zhActivity.import.columns.selectRow,
        exact: true,
      });
      await selection.check();
      await page
        .getByTitle(zhActivity.import.reviewToolbar.setCurrencyTooltip, { exact: true })
        .click();
      await page.getByPlaceholder(zhActivity.import.reviewToolbar.searchCurrencies).fill("人民币");
      await page.getByRole("menuitem", { name: /CNY.*人民币/ }).click();
      await expect(selection).toBeChecked();
      await expect(page.getByRole("gridcell").getByText("CNY", { exact: true })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("dir", direction);
    } finally {
      const restored = await page.request.put(settingsUrl, { data: { language: "en" } });
      expect(restored.ok()).toBe(true);
    }
  });
}
