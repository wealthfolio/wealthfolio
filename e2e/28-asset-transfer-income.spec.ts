import { expect, test } from "@playwright/test";
import {
  BASE_URL,
  completeOnboardingIfNeeded,
  fillDateField,
  gotoActivities,
  gotoAppPath,
  openAddActivitySheet,
  searchAndSelectSymbol,
  selectAccountOption,
  selectActivityType,
} from "./helpers";

test("asset overview retains historical income after a full securities transfer", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await completeOnboardingIfNeeded(page);

  const runId = Date.now().toString(36);
  const symbol = `INC1906${runId.toUpperCase()}`;
  const sender = { name: `Income sender ${runId}`, id: "" };
  const receiver = { name: `Income receiver ${runId}`, id: "" };
  for (const account of [sender, receiver]) {
    const response = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
      data: {
        name: account.name,
        accountType: "SECURITIES",
        currency: "USD",
        isDefault: false,
        isActive: true,
        isArchived: false,
        trackingMode: "TRANSACTIONS",
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    account.id = ((await response.json()) as { id: string }).id;
  }

  let assetId = "";
  for (const [activityType, activityDate, values] of [
    ["BUY", "2024-01-02T15:00:00Z", { quantity: 10, unitPrice: 100 }],
    ["DIVIDEND", "2024-02-01T15:00:00Z", { amount: 25 }],
  ] as const) {
    const response = await page.request.post(`${BASE_URL}/api/v1/activities`, {
      data: {
        accountId: sender.id,
        activityType,
        activityDate,
        currency: "USD",
        fee: 0,
        needsReview: false,
        asset: { symbol, kind: "INVESTMENT", quoteCcy: "USD", quoteMode: "MANUAL" },
        ...values,
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    assetId = ((await response.json()) as { assetId: string }).assetId;
  }

  interface HoldingResponse {
    isClosed: boolean;
    quantity: number;
    instrument?: { id: string };
    income?: { local: number };
    totalReturn?: { local: number };
  }
  async function assetHoldings(accountId: string) {
    const response = await page.request.post(`${BASE_URL}/api/v1/holdings/list/query`, {
      data: { filter: { type: "account", accountId }, includeClosed: true },
    });
    expect(response.ok()).toBeTruthy();
    return ((await response.json()) as HoldingResponse[]).filter(
      (holding) => holding.instrument?.id === assetId,
    );
  }
  const incomeRow = () => page.getByText("Income", { exact: true }).locator("..");

  await expect
    .poll(async () => (await assetHoldings(sender.id))[0]?.income?.local, { timeout: 60_000 })
    .toBe(25);
  await gotoAppPath(page, `/holdings/${encodeURIComponent(assetId)}`);
  await expect(incomeRow()).toContainText("25.00");

  await gotoActivities(page);
  await openAddActivitySheet(page);
  await selectActivityType(page, "Transfer");
  await page.getByRole("button", { name: "Securities" }).click();
  await selectAccountOption(
    page,
    sender.name,
    "USD",
    page.getByRole("combobox", { name: "From Account" }),
  );
  await selectAccountOption(
    page,
    receiver.name,
    "USD",
    page.getByRole("combobox", { name: "To Account" }),
  );
  await searchAndSelectSymbol(page, symbol);
  await fillDateField(page, 10);
  const quantity = page.getByTestId("quantity-input");
  await quantity.fill("10");
  await quantity.blur();
  await page.getByRole("button", { name: /^Transfer\s+/i }).click();
  await expect(page.getByRole("heading", { name: "Add Activity" })).not.toBeVisible({
    timeout: 20_000,
  });

  await expect
    .poll(
      async () => ({
        sender: (await assetHoldings(sender.id)).map((holding) => ({
          closed: holding.isClosed,
          quantity: holding.quantity,
          income: holding.income?.local,
        })),
        receiver: (await assetHoldings(receiver.id)).map((holding) => ({
          closed: holding.isClosed,
          quantity: holding.quantity,
          income: holding.income?.local,
        })),
      }),
      { timeout: 60_000 },
    )
    .toEqual({
      sender: [{ closed: true, quantity: 0, income: 25 }],
      receiver: [{ closed: false, quantity: 10, income: 0 }],
    });

  await gotoAppPath(page, `/holdings/${encodeURIComponent(assetId)}`);
  await expect(incomeRow()).toContainText("25.00");
  const receiverHolding = (await assetHoldings(receiver.id))[0];
  const senderHolding = (await assetHoldings(sender.id))[0];
  const totalReturn =
    Number(receiverHolding.totalReturn?.local) + Number(senderHolding.totalReturn?.local);
  await expect(page.getByText("Total Return", { exact: true }).locator("..")).toContainText(
    Math.abs(totalReturn).toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }),
  );
});
