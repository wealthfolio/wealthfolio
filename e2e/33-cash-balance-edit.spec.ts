import { expect, test } from "./fixtures";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test.describe.configure({ mode: "serial" });

for (const scenario of [
  {
    name: "desktop deposit",
    viewport: { width: 1440, height: 1000 },
    target: 110,
    type: "DEPOSIT",
  },
  {
    name: "mobile withdrawal",
    viewport: { width: 390, height: 844 },
    target: 90,
    type: "WITHDRAWAL",
  },
]) {
  test(`cash adjustment preserves the other currency (${scenario.name})`, async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(scenario.viewport);
    await completeOnboardingIfNeeded(page);

    // Use a known local rate. Adjustment arithmetic must use valueLocal, not FX totals.
    const rateResponse = await page.request.post(`${BASE_URL}/api/v1/exchange-rates`, {
      data: { fromCurrency: "USD", toCurrency: "HKD", rate: 7.8, source: "MANUAL" },
    });
    expect(rateResponse.ok()).toBeTruthy();
    const accountResponse = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
      data: {
        name: `Cash adjustment ${scenario.name} ${Date.now()}`,
        accountType: "SECURITIES",
        currency: "HKD",
        isDefault: false,
        isActive: true,
        isArchived: false,
        trackingMode: "TRANSACTIONS",
      },
    });
    expect(accountResponse.ok()).toBeTruthy();
    const { id: accountId } = (await accountResponse.json()) as { id: string };
    for (const [currency, amount] of [
      ["HKD", 1000],
      ["USD", 100],
    ] as const) {
      const response = await page.request.post(`${BASE_URL}/api/v1/activities`, {
        data: {
          accountId,
          activityType: "DEPOSIT",
          activityDate: new Date(Date.now() - 86_400_000).toISOString(),
          currency,
          amount,
        },
      });
      expect(response.ok()).toBeTruthy();
    }

    async function nativeBalances() {
      const response = await page.request.post(`${BASE_URL}/api/v1/valuations/current/query`, {
        data: { filter: { type: "account", accountId }, includeAccounts: true },
      });
      expect(response.ok()).toBeTruthy();
      const valuation = (await response.json()) as {
        summary: { cashCurrencySplit: { currency: string; valueLocal: number }[] };
      };
      return Object.fromEntries(
        valuation.summary.cashCurrencySplit.map(({ currency, valueLocal }) => [
          currency,
          valueLocal,
        ]),
      );
    }

    await expect.poll(nativeBalances, { timeout: 60_000 }).toEqual({ HKD: 1000, USD: 100 });
    await gotoAppPath(page, `/accounts/${accountId}`);
    await expect(page.getByRole("button", { name: "Adjust cash balance" })).toBeEnabled({
      timeout: 30_000,
    });
    await expect(page.getByTestId("account-cash-balance-value").locator("input")).toHaveCount(0);
    await page.getByRole("button", { name: "Adjust cash balance" }).click();
    const dialog = page.getByRole("dialog", { name: "Adjust cash balance" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("combobox", { name: "Currency" }).click();
    await page.getByRole("option", { name: "USD", exact: true }).click();
    await expect(dialog.getByLabel("New balance")).toHaveValue("100");
    await dialog.getByLabel("New balance").fill(String(scenario.target));

    const savedResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/activities") && response.request().method() === "POST",
    );
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    const response = await savedResponse;
    expect(response.ok()).toBeTruthy();
    const saved = await response.json();
    expect(saved).toMatchObject({
      accountId,
      currency: "USD",
      activityType: scenario.type,
    });
    expect(Number(saved.amount)).toBe(10);
    await expect(dialog).not.toBeVisible();
    await expect
      .poll(nativeBalances, { timeout: 60_000 })
      .toEqual({ HKD: 1000, USD: scenario.target });

    // Re-read after reload: no optimistic balance write can satisfy this check.
    await page.reload();
    await page.getByRole("button", { name: "Adjust cash balance" }).click();
    await dialog.getByRole("combobox", { name: "Currency" }).click();
    await page.getByRole("option", { name: "USD", exact: true }).click();
    await expect(dialog.getByLabel("New balance")).toHaveValue(String(scenario.target));
    await dialog.getByRole("combobox", { name: "Currency" }).click();
    await page.getByRole("option", { name: "HKD", exact: true }).click();
    await expect(dialog.getByLabel("New balance")).toHaveValue("1000");
    await expect(dialog.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

    const activitiesResponse = await page.request.post(`${BASE_URL}/api/v1/activities/search`, {
      data: { page: 0, pageSize: 20, accountIdFilter: [accountId] },
    });
    expect(activitiesResponse.ok()).toBeTruthy();
    const { data: activities } = (await activitiesResponse.json()) as {
      data: { id: string; comment?: string }[];
    };
    expect(activities).toHaveLength(3);
    expect(activities.filter(({ comment }) => comment === "Balance updated manually")).toHaveLength(
      1,
    );
  });
}
