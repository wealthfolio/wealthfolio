import { expect, test } from "./fixtures";
import { api, createAccount, deposit, uniqueName, updateSettings } from "./api";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

interface Valued {
  valueStatus: string;
  missingFx: { itemId: string; fromCurrency: string; toCurrency: string }[];
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
      const review = attention.getByRole("link", { name: "Review valuation issues" });
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
      await review.click();
      await expect(page).toHaveURL(/\/health/);
      await expect(page.getByText(/Missing exchange rate[s]? for/).first()).toBeVisible();
      const rate = await api<{ id: string }>(page, "POST", "/exchange-rates", {
        fromCurrency: currency,
        toCurrency: "AED",
        rate: 0.001,
        source: "MANUAL",
      });
      rateId = rate.id;
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
      await expect(page.getByRole("link", { name: "Review valuation issues" })).toHaveCount(0);
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
