import { expect, test } from "./fixtures";
import { api, createAccount, deposit, uniqueName, updateSettings } from "./api";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

interface Valued {
  valueStatus: string;
  missingFx: { itemId: string; fromCurrency: string; toCurrency: string }[];
}

for (const direction of ["ltr", "rtl"]) {
  test(`missing FX stays unavailable and recovers across both dashboards (${direction})`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
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
        name: uniqueName("Missing FX COP"),
        currency: "COP",
        accountType: "CASH",
      });
      accountId = account.id;
      await deposit(page, account.id, 5_000_000, "COP", `${date}T12:00:00Z`);
      const property = await api<{ assetId: string }>(page, "POST", "/alternative-assets", {
        kind: "property",
        name: uniqueName("COP property"),
        currency: "COP",
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
          return keys.includes("FX:COP/USD") && keys.includes("FX:USD/AED");
        })
        .toBe(true);
      const missing = await current();
      expect(missing.summary.totalValueBase).toBe(0);
      expect(missing.accounts[0].totalValue).toBe(5_000_000);
      expect(missing.summary.missingFx).toContainEqual(
        expect.objectContaining({ fromCurrency: "COP", toCurrency: "AED" }),
      );
      await expect.poll(async () => (await netWorth()).valueStatus).toBe("unavailable");
      const incompleteHistory = await history();
      expect(incompleteHistory.length).toBeGreaterThan(0);
      expect(incompleteHistory.every((point) => point.valueStatus === "unavailable")).toBe(true);
      await gotoAppPath(page, `/dashboard?dir=${direction}`);
      await expect(page.getByTestId("portfolio-balance").first()).toHaveText("N/A");
      await expect(
        page.getByRole("status").filter({ hasText: "Total unavailable" }).first(),
      ).toBeVisible();
      await page.getByRole("button", { name: "Net Worth", exact: true }).click();
      await expect(
        page.getByTestId("portfolio-balance").filter({ hasText: "N/A" }).last(),
      ).toBeVisible();
      const rate = await api<{ id: string }>(page, "POST", "/exchange-rates", {
        fromCurrency: "COP",
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
        page.getByTestId("portfolio-balance-value").filter({ hasText: "335,000" }).last(),
      ).toBeVisible();
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
