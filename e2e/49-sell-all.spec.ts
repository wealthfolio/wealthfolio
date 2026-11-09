import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";

test.describe.configure({ mode: "serial" });

for (const scenario of [
  { name: "desktop LTR", width: 1280, height: 900, dir: "ltr", quantity: "1.12345678" },
  { name: "desktop RTL", width: 1280, height: 900, dir: "rtl", quantity: "0.000001" },
  { name: "phone LTR", width: 390, height: 844, dir: "ltr", quantity: "0.00000001" },
  { name: "phone RTL", width: 390, height: 844, dir: "rtl", quantity: "125.12345678" },
  {
    name: "desktop account context",
    width: 1280,
    height: 900,
    dir: "ltr",
    quantity: "2.00000001",
    fromAccount: true,
  },
]) {
  test(`${scenario.name}: Sell all closes the fractional holding in its owning account`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await completeOnboardingIfNeeded(page);
    const runId = `${Date.now()}-${scenario.dir}-${scenario.width}`;

    async function createAccount(name: string, accountType: string) {
      const response = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
        data: {
          name: `${name} ${runId}`,
          accountType,
          currency: "USD",
          isDefault: false,
          isActive: true,
          isArchived: false,
          trackingMode: "TRANSACTIONS",
        },
      });
      expect(response.ok(), await response.text()).toBeTruthy();
      return (await response.json()) as { id: string; name: string };
    }

    const spending = await createAccount("Spending", "CASH");
    const brokerage = await createAccount("Brokerage", "SECURITIES");
    // A security no other spec holds: with a second owner (the conversion spec keeps
    // AAPL), Sell from the holding page rightly asks which account sells.
    const symbol = `SELLALL${Date.now().toString(36).toUpperCase()}`;
    const assetResponse = await page.request.post(`${BASE_URL}/api/v1/assets`, {
      data: {
        kind: "INVESTMENT",
        name: `Sell all ${symbol}`,
        displayCode: symbol,
        instrumentSymbol: symbol,
        instrumentType: "EQUITY",
        quoteMode: "MANUAL",
        quoteCcy: "USD",
      },
    });
    expect(assetResponse.ok(), await assetResponse.text()).toBeTruthy();
    const assetId = ((await assetResponse.json()) as { id: string }).id;
    const buyResponse = await page.request.post(`${BASE_URL}/api/v1/activities`, {
      data: {
        accountId: brokerage.id,
        activityType: "BUY",
        activityDate: "2026-01-05T15:00:00.000Z",
        currency: "USD",
        quantity: scenario.quantity,
        unitPrice: "100",
        fee: "0",
        needsReview: false,
        asset: { id: assetId },
      },
    });
    expect(buyResponse.ok(), await buyResponse.text()).toBeTruthy();
    const otherOwner =
      "fromAccount" in scenario ? await createAccount("Other brokerage", "SECURITIES") : null;
    if (otherOwner) {
      const otherBuy = await page.request.post(`${BASE_URL}/api/v1/activities`, {
        data: {
          accountId: otherOwner.id,
          activityType: "BUY",
          activityDate: "2026-01-05T15:00:00.000Z",
          currency: "USD",
          quantity: "0.5",
          unitPrice: "100",
          fee: "0",
          needsReview: false,
          asset: { id: assetId },
        },
      });
      expect(otherBuy.ok(), await otherBuy.text()).toBeTruthy();
    }

    async function holdings(accountId: string) {
      const response = await page.request.get(
        `${BASE_URL}/api/v1/holdings?accountId=${encodeURIComponent(accountId)}`,
      );
      // Holdings answer 400 while the account is still being recalculated.
      if (!response.ok()) return null;
      return (await response.json()) as Array<{
        instrument?: { id: string };
        quantity: number;
      }>;
    }

    await expect
      .poll(
        async () => {
          const position = (await holdings(brokerage.id))?.find(
            (h) => h.instrument?.id === assetId,
          );
          return position?.quantity;
        },
        { timeout: 60_000 },
      )
      .toBe(Number(scenario.quantity));

    if (otherOwner) {
      await page.goto(`${BASE_URL}/accounts/${brokerage.id}?dir=${scenario.dir}`);
      await page.getByText(symbol, { exact: true }).first().click();
      await expect(page).toHaveURL(new RegExp(`/holdings/${encodeURIComponent(assetId)}`));
    } else {
      await page.goto(`${BASE_URL}/holdings/${encodeURIComponent(assetId)}?dir=${scenario.dir}`);
    }
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await page.getByRole("button", { name: "Sell", exact: true }).click();
    await expect(page).toHaveURL(/activities\/manage.*type=SELL/);
    await expect(page.locator("html")).toHaveAttribute("dir", scenario.dir);

    const account = page.getByTestId("account-select");
    if (scenario.width >= 768) {
      await expect(account).toContainText(brokerage.name);
    } else {
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect(page.getByRole("combobox", { name: "Account", exact: true })).toContainText(
        brokerage.name,
      );
    }
    const sellAll = page.getByRole("button", { name: "Sell all", exact: true });
    await expect(sellAll).toBeEnabled();
    await sellAll.click();
    const quantity =
      scenario.width >= 768
        ? page.getByTestId("quantity-input")
        : page.getByRole("textbox", { name: "Shares", exact: true });
    await expect(quantity).toHaveValue(
      new Intl.NumberFormat("en-US", { maximumFractionDigits: 8 }).format(
        Number(scenario.quantity),
      ),
    );

    const price =
      scenario.width >= 768
        ? page.getByTestId("price-input")
        : page.getByRole("textbox", { name: "Price", exact: true });
    await price.fill("100");
    await price.blur();
    await quantity.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("sell-all.png"), fullPage: true });
    const responsePromise = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/v1/activities") && response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: scenario.width >= 768 ? /^Add Sell$/i : /^Add Activity$/i })
      .click();
    const response = await responsePromise;
    expect(response.ok(), await response.text()).toBeTruthy();
    const sale = (await response.json()) as {
      accountId: string;
      assetId: string;
      quantity: string;
    };
    expect(sale.accountId).toBe(brokerage.id);
    expect(sale.assetId).toBe(assetId);
    expect(Number(sale.quantity)).toBe(Number(scenario.quantity));

    await expect
      .poll(
        async () => {
          const list = await holdings(brokerage.id);
          return list && (list.find((h) => h.instrument?.id === assetId)?.quantity ?? 0);
        },
        { timeout: 60_000 },
      )
      .toBe(0);
    await expect
      .poll(async () => (await holdings(spending.id))?.some((h) => h.instrument?.id === assetId))
      .toBe(false);
    if (otherOwner) {
      await expect
        .poll(
          async () =>
            (await holdings(otherOwner.id))?.find((h) => h.instrument?.id === assetId)?.quantity,
        )
        .toBe(0.5);
    }
  });
}
