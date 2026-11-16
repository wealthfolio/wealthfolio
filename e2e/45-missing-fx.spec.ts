import { expect, test, type Page } from "./fixtures";
import { api, createAccount, deposit, uniqueName, updateSettings } from "./api";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

interface Valued {
  valueStatus: string;
  missingFx: { itemId: string; fromCurrency: string; toCurrency: string }[];
}

async function selectRateCurrency(page: Page, label: string, code: string) {
  const form = page.getByRole("dialog", { name: "Add exchange rate", exact: true });
  await form.getByRole("combobox", { name: label, exact: true }).click();
  const picker = page.locator('[data-slot="popover-content"][data-open]');
  await picker.getByPlaceholder("Search currency...").fill(code);
  await picker
    .getByRole("option")
    .filter({ hasText: `(${code})` })
    .click();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
}

// Keep later missing-rate cases independent of earlier cases' recovered FX routes.
for (const [direction, width, currency] of [
  ["ltr", 1440, "COP"],
  ["rtl", 1440, "CLP"],
  ["ltr", 390, "KRW"],
  ["rtl", 390, "IDR"],
] as const) {
  test(`missing FX stays unavailable and recovers across both dashboards (${direction}, ${width}px)`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 1000 });
    await completeOnboardingIfNeeded(page);
    const providers = await api<{ id: string; priority: number; enabled: boolean }[]>(
      page,
      "GET",
      "/providers/settings",
    );
    for (const provider of providers.filter((provider) => provider.enabled)) {
      await api(page, "PUT", "/providers/settings", {
        providerId: provider.id,
        priority: provider.priority,
        enabled: false,
      });
    }
    const previous = await updateSettings(page, { baseCurrency: "AED" });
    let accountId: string | undefined;
    let assetId: string | undefined;
    let rateId: string | undefined;
    const date = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    try {
      const account = await createAccount(page, {
        name: uniqueName(`Missing FX ${currency}`),
        currency,
        accountType: "CASH",
      });
      accountId = account.id;
      await deposit(page, account.id, 5_000_000, currency, `${date}T12:00:00Z`);
      const property = await api<{ assetId: string }>(page, "POST", "/alternative-assets", {
        kind: "property",
        name: uniqueName(`${currency} property`),
        currency,
        currentValue: "330000000",
        valueDate: date,
      });
      assetId = property.assetId;
      const current = () =>
        api<{ summary: Valued & { totalValueBase: number }; accounts: { totalValue: number }[] }>(
          page,
          "POST",
          "/valuations/current/query",
          { filter: { type: "accounts", accountIds: [account.id] }, includeAccounts: true },
        );
      const netWorth = () => api<Valued & { netWorth: number }>(page, "GET", "/net-worth");
      const history = () =>
        api<(Valued & { netWorth: number })[]>(
          page,
          "GET",
          `/net-worth/history?startDate=${date}&endDate=${today}`,
        );
      await expect.poll(async () => (await current()).summary.valueStatus).toBe("unavailable");
      // The existing sync job registers bridges even with all providers disabled.
      // They have no quotes yet, so merely registering them cannot fabricate values.
      await expect
        .poll(async () => {
          const assets = await api<{ instrumentKey: string | null }[]>(page, "GET", "/assets");
          const keys = assets.map((asset) => asset.instrumentKey);
          return keys.includes(`FX:${currency}/USD`) && keys.includes("FX:USD/AED");
        })
        .toBe(true);
      const missing = await current();
      expect(missing.summary.totalValueBase).toBe(0);
      expect(missing.accounts[0].totalValue).toBe(5_000_000);
      expect(missing.summary.missingFx).toContainEqual(
        expect.objectContaining({ fromCurrency: currency, toCurrency: "AED" }),
      );
      await expect.poll(async () => (await netWorth()).valueStatus).toBe("unavailable");
      const incompleteHistory = await history();
      expect(incompleteHistory.length).toBeGreaterThan(0);
      expect(incompleteHistory.every((point) => point.valueStatus === "unavailable")).toBe(true);
      await api(page, "POST", "/health/check");
      await gotoAppPath(page, `/dashboard?dir=${direction}`);
      await expect(page.getByTestId("portfolio-balance").first()).toHaveText("N/A");
      await expect(
        page.getByRole("status").filter({ hasText: "Total unavailable" }).first(),
      ).toHaveCount(0);
      await expect(page.getByText(/Some historical values are unavailable/)).toHaveCount(0);
      await expect(page.getByRole("link", { name: `${currency} → AED`, exact: true })).toHaveCount(
        0,
      );
      for (const close of await page
        .getByRole("button", { name: "Close toast", exact: true })
        .all()) {
        await close.click();
      }
      await page.screenshot({ path: test.info().outputPath("investments.png"), fullPage: true });
      await page.getByRole("button", { name: "Net Worth", exact: true }).click();
      await expect(
        page.getByTestId("portfolio-balance").filter({ hasText: "N/A" }).last(),
      ).toBeVisible();
      const attention = page.getByRole("region", { name: "Needs attention" });
      await expect(page.getByText("Known subtotal")).toBeVisible();
      await expect(page.getByText("0.0%", { exact: true })).toHaveCount(0);
      await expect(page.getByText("—", { exact: true }).last()).toBeVisible();
      const review = attention.getByRole("link", {
        name: `Missing exchange rate: ${currency} → AED`,
      });
      await expect(review).toHaveCount(1);
      await expect(review).toHaveAttribute("href", "/health");
      await expect(
        page.getByText(/Total unavailable|Some historical values are unavailable/),
      ).toHaveCount(0);
      await expect(page.getByRole("link", { name: `${currency} → AED`, exact: true })).toHaveCount(
        0,
      );
      await review.scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: test.info().outputPath("net-worth.png"), fullPage: true });
      await attention.screenshot({
        path: test.info().outputPath("attention.png"),
        animations: "disabled",
      });
      await review.click();
      await expect(page).toHaveURL(/\/health/);
      await page.getByText(`Missing exchange rate for ${currency}`, { exact: true }).click();
      const details = page.getByRole("dialog");
      const openRates = details.getByRole("link", { name: "Open General Settings", exact: true });
      await expect(openRates).toHaveAttribute("href", "/settings/general");
      await details.screenshot({
        path: test.info().outputPath("health-rate-details.png"),
        animations: "disabled",
      });
      await openRates.click();
      await expect(page).toHaveURL(/\/settings\/general/);
      await page.getByRole("button", { name: "Add rate", exact: true }).first().click();
      const form = page.getByRole("dialog", { name: "Add exchange rate", exact: true });
      await selectRateCurrency(page, "From currency", currency);
      await selectRateCurrency(page, "To currency", "AED");
      const rateInput = form.getByRole("textbox", { name: "Exchange rate", exact: true });
      await rateInput.fill("0.001");
      const save = form.getByRole("button", { name: "Add exchange rate", exact: true });

      if (width === 1440 && direction === "ltr") {
        // Simulate a persistence failure at the HTTP boundary; a retry still uses the real API.
        let failSave: () => void = () => {};
        const pending = new Promise<void>((resolve) => {
          failSave = resolve;
        });
        await page.route(
          "**/api/v1/exchange-rates",
          async (route) => {
            await pending;
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({ message: "Test save failure" }),
            });
          },
          { times: 1 },
        );
        const failed = page.waitForResponse(
          (response) =>
            response.status() === 500 &&
            new URL(response.url()).pathname === "/api/v1/exchange-rates",
        );
        await save.click();
        try {
          await expect(save).toBeDisabled();
          await expect(rateInput).toBeDisabled();
          await expect(form.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
          await form.screenshot({
            path: test.info().outputPath("rate-save-pending.png"),
            animations: "disabled",
          });
        } finally {
          failSave();
        }
        await failed;
        await expect(save).toBeEnabled();
        await expect(form).toBeVisible();
        await expect(rateInput).toHaveValue("0.001");
        await expect(
          form.getByRole("combobox", { name: "From currency", exact: true }),
        ).toContainText(currency);
        await expect(
          form.getByRole("combobox", { name: "To currency", exact: true }),
        ).toContainText("AED");
        await page.screenshot({
          path: test.info().outputPath("rate-save-failed.png"),
          fullPage: true,
          animations: "disabled",
        });
      }
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/v1/exchange-rates",
      );
      await save.click();
      const response = await saved;
      expect(response.ok()).toBe(true);
      rateId = (await response.json()).id;
      await expect(form).not.toBeVisible();
      await expect.poll(async () => (await current()).summary.totalValueBase).toBe(5000);
      await expect.poll(async () => (await netWorth()).valueStatus).toBe("complete");
      expect((await netWorth()).netWorth).toBe(335000);
      await expect
        .poll(async () =>
          (await history()).every(
            (point) => point.valueStatus === "complete" && point.netWorth === 335000,
          ),
        )
        .toBe(true);
      // Reload to check the actual adapter responses render after recovery.
      await gotoAppPath(page, `/dashboard?dir=${direction}`);
      await expect(page.getByTestId("portfolio-balance-value").first()).toContainText("5,000");
      await page.getByRole("button", { name: "Net Worth", exact: true }).click();
      await expect(
        page
          .getByTestId("portfolio-balance-value")
          .filter({ hasText: width < 768 ? "335K" : "335,000" })
          .last(),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: /Missing exchange rate:|Review valuation issues/ }),
      ).toHaveCount(0);
      await expect(page.getByText("Known subtotal")).toHaveCount(0);
      await page.screenshot({
        path: test.info().outputPath("net-worth-recovered.png"),
        fullPage: true,
        animations: "disabled",
      });
    } finally {
      if (assetId) await api(page, "DELETE", `/alternative-assets/${assetId}`);
      if (accountId) await api(page, "DELETE", `/accounts/${accountId}`);
      if (rateId) await api(page, "DELETE", `/exchange-rates/${rateId}`);
      await updateSettings(page, previous);
      for (const provider of providers.filter((provider) => provider.enabled)) {
        await api(page, "PUT", "/providers/settings", {
          providerId: provider.id,
          priority: provider.priority,
          enabled: true,
        });
      }
    }
  });
}
