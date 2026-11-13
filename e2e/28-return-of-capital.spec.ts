import { expect, test } from "./fixtures";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";

test("a closed asset counts return of capital once in total return", async ({ page }) => {
  test.setTimeout(180_000);
  await completeOnboardingIfNeeded(page);
  const accountResponse = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
    data: {
      name: `Closed ROC ${Date.now()}`,
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      isArchived: false,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(accountResponse.ok(), await accountResponse.text()).toBeTruthy();
  const accountId = ((await accountResponse.json()) as { id: string }).id;
  // The asset page totals every account that held the security, so use one no
  // other spec trades (shared AAPL brought in their dividends).
  const symbol = `ROC${Date.now().toString(36).toUpperCase()}`;
  const assetResponse = await page.request.post(`${BASE_URL}/api/v1/assets`, {
    data: {
      kind: "INVESTMENT",
      name: `Return of capital ${symbol}`,
      displayCode: symbol,
      instrumentSymbol: symbol,
      instrumentType: "EQUITY",
      quoteMode: "MANUAL",
      quoteCcy: "USD",
    },
  });
  expect(assetResponse.ok(), await assetResponse.text()).toBeTruthy();
  const assetId = ((await assetResponse.json()) as { id: string }).id;
  for (const activity of [
    { activityType: "BUY", activityDate: "2024-01-02", quantity: 10, unitPrice: 10 },
    {
      activityType: "DIVIDEND",
      subtype: "Return of Capital",
      activityDate: "2024-01-03",
      amount: 20,
    },
    { activityType: "SELL", activityDate: "2024-01-04", quantity: 10, unitPrice: 10 },
  ]) {
    const response = await page.request.post(`${BASE_URL}/api/v1/activities`, {
      data: {
        accountId,
        currency: "USD",
        fee: 0,
        needsReview: false,
        asset: { id: assetId },
        ...activity,
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  }

  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `${BASE_URL}/api/v1/holdings?accountId=${accountId}&includeClosed=true`,
        );
        if (!response.ok()) return null;
        const holdings = (await response.json()) as Array<{
          isClosed: boolean;
          instrument?: { symbol: string };
          income?: { local: string };
          totalReturn?: { local: string };
        }>;
        const closed = holdings.find((holding) => holding.instrument?.symbol === symbol);
        return (
          closed && {
            closed: closed.isClosed,
            income: Number(closed.income?.local),
            totalReturn: Number(closed.totalReturn?.local),
          }
        );
      },
      { timeout: 60_000, intervals: [1_000] },
    )
    .toEqual({ closed: true, income: 0, totalReturn: 20 });

  await page.goto(`${BASE_URL}/holdings/${encodeURIComponent(assetId)}`);
  const income = page.getByText("Income", { exact: true }).locator("..");
  const totalReturn = page.getByText("Total Return", { exact: true }).locator("..");
  await expect(income).toContainText("$0.00");
  await expect(totalReturn).toContainText("$20.00");
});
