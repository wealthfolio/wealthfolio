import { expect, test } from "./fixtures";
import { api, createAccount, deposit, uniqueName } from "./api";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";
import type { HealthIssue } from "../apps/frontend/src/lib/types";

for (const [direction, width, currency] of [
  ["ltr", 1440, "VND"],
  ["rtl", 390, "MYR"],
] as const) {
  test(`Health Center accepts stored inverse FX routes (${direction})`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 1000 });
    await completeOnboardingIfNeeded(page);
    const previous = await api<{ baseCurrency: string }>(page, "GET", "/settings");
    const providers = await api<{ id: string; priority: number; enabled: boolean }[]>(
      page,
      "GET",
      "/providers/settings",
    );
    const rateIds: string[] = [];
    let accountId: string | undefined;
    try {
      for (const provider of providers.filter((provider) => provider.enabled)) {
        await api(page, "PUT", "/providers/settings", {
          providerId: provider.id,
          priority: provider.priority,
          enabled: false,
        });
      }
      await api(page, "PUT", "/settings", { baseCurrency: "AED" });
      const account = await createAccount(page, {
        name: uniqueName(`${currency} route`),
        accountType: "CASH",
        currency,
      });
      accountId = account.id;
      const date = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
      await deposit(page, account.id, 100000, currency, `${date}T12:00:00Z`);
      let directId: string | undefined;
      await expect
        .poll(async () => {
          const assets = await api<{ id: string; instrumentKey: string | null }[]>(
            page,
            "GET",
            "/assets",
          );
          directId = assets.find((asset) => asset.instrumentKey === `FX:${currency}/AED`)?.id;
          return directId !== undefined;
        })
        .toBe(true);
      await api(page, "POST", "/market-data/sync", { assetIds: [directId], refetchAll: false });
      const health = () => api<{ issues: HealthIssue[] }>(page, "POST", "/health/check");
      const affectsDirect = (issue: HealthIssue) =>
        issue.affectedItems?.some((item) => item.id === directId);
      await expect
        .poll(async () =>
          (await health()).issues.some(
            (issue) => issue.code?.startsWith("quote_sync_") && affectsDirect(issue),
          ),
        )
        .toBe(true);
      await expect
        .poll(async () =>
          (await health()).issues.some(
            (issue) =>
              issue.code === "fx_missing" &&
              issue.affectedItems?.some((item) => item.id === `${currency}:AED`),
          ),
        )
        .toBe(true);
      // Store the first leg in reverse. The converter must use the same inverse
      // and USD bridge for valuation and for Health Center availability/freshness.
      for (const rate of [
        { fromCurrency: "USD", toCurrency: currency, rate: 4000 },
        { fromCurrency: "USD", toCurrency: "AED", rate: 4 },
      ]) {
        const saved = await api<{ id: string }>(page, "POST", "/exchange-rates", {
          ...rate,
          source: "MANUAL",
        });
        rateIds.push(saved.id);
      }
      await expect
        .poll(async () => {
          const result = await api<{ summary: { valueStatus: string; totalValueBase: number } }>(
            page,
            "POST",
            "/valuations/current/query",
            { filter: { type: "accounts", accountIds: [account.id] } },
          );
          return result.summary;
        })
        .toMatchObject({ valueStatus: "complete", totalValueBase: 100 });
      const remainingIssues = () =>
        health().then((status) =>
          status.issues.filter(
            (issue) =>
              (issue.code?.startsWith("quote_sync_") && affectsDirect(issue)) ||
              (issue.code?.startsWith("fx_") &&
                issue.affectedItems?.some((item) => item.id === `${currency}:AED`)),
          ),
        );
      await expect.poll(remainingIssues).toEqual([]);
      // The unsupported direct asset still exists with no quote. Health should
      // accept the real stored route rather than requiring a fabricated direct rate.
      const assets = await api<{ id: string }[]>(page, "GET", "/assets");
      expect(assets.some((asset) => asset.id === directId)).toBe(true);
      await gotoAppPath(page, `/health?dir=${direction}`);
      await expect(
        page.getByText(`Missing exchange rate for ${currency}`, { exact: true }),
      ).toHaveCount(0);
      await page.screenshot({
        path: test.info().outputPath("healthy-fx-route.png"),
        fullPage: true,
        animations: "disabled",
      });
    } finally {
      const cleanup = [
        ...(accountId ? [() => api(page, "DELETE", `/accounts/${accountId}`)] : []),
        ...rateIds.map((id) => () => api(page, "DELETE", `/exchange-rates/${id}`)),
        () => api(page, "PUT", "/settings", { baseCurrency: previous.baseCurrency }),
        ...providers
          .filter((provider) => provider.enabled)
          .map(
            (provider) => () =>
              api(page, "PUT", "/providers/settings", {
                providerId: provider.id,
                priority: provider.priority,
                enabled: true,
              }),
          ),
      ];
      const failures: unknown[] = [];
      for (const restore of cleanup) {
        try {
          await restore();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, "FX route cleanup failed");
    }
  });
}
