import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test.describe.configure({ mode: "serial" });

for (const direction of ["ltr", "rtl"] as const) {
  test(`MOEX provider icon, search, and symbol guidance (${direction})`, async ({ page }) => {
    test.setTimeout(120_000);
    await completeOnboardingIfNeeded(page);

    const settings = await page.request.get(`${BASE_URL}/api/v1/providers/settings`);
    const moex = (await settings.json()).find((provider: { id: string }) => provider.id === "MOEX");
    expect(moex.enabled).toBe(false);
    await gotoAppPath(page, `/settings/market-data?dir=${direction}`);
    await page.getByRole("button", { name: "Add provider", exact: true }).click();
    const catalog = page.getByRole("dialog");
    await expect(catalog.locator('img[src="/market-data/moex.svg"]')).toBeVisible();
    await catalog.getByRole("button", { name: "Add Moscow Exchange", exact: true }).click();
    await expect(catalog).not.toBeVisible();
    await expect
      .poll(async () => {
        const response = await page.request.get(`${BASE_URL}/api/v1/providers/settings`);
        return (await response.json()).find((provider: { id: string }) => provider.id === "MOEX")
          .enabled;
      })
      .toBe(true);

    const search = await page.request.get(`${BASE_URL}/api/v1/market-data/search?query=MAIL`);
    expect(search.ok()).toBeTruthy();
    expect(await search.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerId: "MOEX", exchangeMic: "MISX", currency: "RUB" }),
      ]),
    );

    await gotoAppPath(page, `/settings/market-data?dir=${direction}`);
    const logo = page.locator('img[src="/market-data/moex.svg"]').filter({ visible: true });
    await expect(logo).toBeVisible();
    await expect
      .poll(() => logo.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBeGreaterThan(0);
    await expect(
      page.getByText("Stocks • ETFs • Funds • Depositary receipts", { exact: true }).first(),
    ).toBeVisible();
    await page.screenshot({ path: `test-results/moex-settings-${direction}.png`, fullPage: true });

    const created = await page.request.post(`${BASE_URL}/api/v1/assets`, {
      data: {
        kind: "INVESTMENT",
        name: "MOEX Mapping Test",
        displayCode: "AFLT",
        quoteMode: "MARKET",
        quoteCcy: "RUB",
        instrumentType: "EQUITY",
        instrumentSymbol: "AFLT",
        instrumentExchangeMic: "MISX",
      },
    });
    expect(created.ok()).toBeTruthy();
    const asset = await created.json();
    expect(asset.providerConfig.preferred_provider).toBe("MOEX");

    await gotoAppPath(page, `/settings/securities?dir=${direction}`);
    await expect(page.getByRole("heading", { name: "Securities", exact: true })).toBeVisible();
    const reset = page.getByRole("button", { name: "Reset", exact: true });
    if (await reset.isVisible()) await reset.click();
    const row = page.getByRole("row").filter({ hasText: "AFLT" }).first();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Open actions" }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const sheet = page.getByRole("dialog").first();
    await expect(sheet).toBeVisible();
    await sheet.getByRole("tab", { name: "Market data" }).click();
    await sheet.getByRole("button", { name: "Add", exact: true }).click();
    const mapping = sheet
      .locator("table")
      .filter({ has: page.getByRole("columnheader", { name: "Provider" }) })
      .locator("tbody tr")
      .last();
    await mapping.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "Moscow Exchange", exact: true }).click();
    const input = mapping.getByPlaceholder("e.g. SBER, AFLT");
    await expect(input).toBeVisible();
    await expect(
      mapping.getByText(
        "Use a MOEX security code without a prefix or suffix. Set the exchange to Moscow Exchange (MISX).",
        { exact: true },
      ),
    ).toBeVisible();
    await input.fill("AFLT");
    await expect(mapping.getByTestId("symbol-validation-valid")).toBeVisible({ timeout: 20_000 });
    await page.screenshot({
      path: `test-results/moex-symbol-guidance-${direction}.png`,
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    expect((await page.request.delete(`${BASE_URL}/api/v1/assets/${asset.id}`)).ok()).toBeTruthy();
    expect(
      (
        await page.request.put(`${BASE_URL}/api/v1/providers/settings`, {
          data: { providerId: "MOEX", priority: moex.priority, enabled: false },
        })
      ).ok(),
    ).toBeTruthy();
  });
}

test("disabled MOEX provider contributes no search results", async ({ page }) => {
  await completeOnboardingIfNeeded(page);
  const settings = await page.request.get(`${BASE_URL}/api/v1/providers/settings`);
  const providers = await settings.json();
  const moex = providers.find((provider: { id: string }) => provider.id === "MOEX");
  try {
    expect(
      (
        await page.request.put(`${BASE_URL}/api/v1/providers/settings`, {
          data: { providerId: "MOEX", priority: moex.priority, enabled: false },
        })
      ).ok(),
    ).toBeTruthy();
    const search = await page.request.get(`${BASE_URL}/api/v1/market-data/search?query=MAIL`);
    expect(search.ok()).toBeTruthy();
    const results = await search.json();
    expect(Array.isArray(results)).toBe(true);
    expect(results).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ providerId: "MOEX" })]),
    );
  } finally {
    await page.request.put(`${BASE_URL}/api/v1/providers/settings`, {
      data: { providerId: "MOEX", priority: moex.priority, enabled: moex.enabled },
    });
  }
});
