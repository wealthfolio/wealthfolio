import { expect, test } from "@playwright/test";
import {
  BASE_URL,
  completeOnboardingIfNeeded,
  gotoActivities,
  gotoAppPath,
  openAddActivitySheet,
  searchAndSelectSymbol,
  selectAccountOption,
  selectActivityType,
} from "./helpers";

interface AssetResponse {
  id: string;
  instrumentType?: string;
  instrumentSymbol?: string;
  quoteMode?: string;
  quoteCcy?: string;
  metadata?: {
    identifiers?: { isin?: string };
    bond?: {
      treasuryType?: string;
      couponRate?: number;
      maturityDate?: string;
      couponFrequency?: string;
      faceValue?: number;
    };
  };
}

interface QuoteResponse {
  close: number | string;
  currency: string;
  dataSource: string;
}

interface HoldingResponse {
  quantity: number | string;
  price?: number | string;
  localCurrency: string;
  marketValue: { local: number | string };
  costBasis?: { local: number | string };
}

const securities = [
  {
    label: "bill",
    cusip: "912797VR5",
    isin: "US912797VR56",
    type: "Bill",
    coupon: 0,
    maturity: "2027-05-12",
    frequency: "ZERO",
    price: 0.961025093433,
  },
  {
    label: "note",
    cusip: "91282CRF0",
    isin: "US91282CRF04",
    type: "Note",
    coupon: 0.04,
    maturity: "2036-05-12",
    frequency: "SEMI_ANNUAL",
    price: 1,
  },
  {
    label: "bond",
    cusip: "912810UW6",
    isin: "US912810UW61",
    type: "Bond",
    coupon: 0.05,
    maturity: "2056-05-11",
    frequency: "SEMI_ANNUAL",
    price: 1.173804433385,
  },
  {
    label: "tips",
    cusip: "91282CRE3",
    isin: "US91282CRE39",
    type: "TIPS",
    coupon: 0.02,
    maturity: "2036-05-12",
    frequency: "SEMI_ANNUAL",
    price: null,
  },
  {
    label: "frn",
    cusip: "91282CRD5",
    isin: "US91282CRD55",
    type: "FRN",
    coupon: null,
    maturity: "2028-05-12",
    frequency: "QUARTERLY",
    price: null,
  },
  {
    label: "corporate",
    cusip: "037833EZ9",
    isin: "US037833EZ91",
    type: null,
    coupon: null,
    maturity: null,
    frequency: null,
    price: null,
  },
] as const;

test("bond UI entry, identifier reuse, provider terms, prices, and holdings use fixtures", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await completeOnboardingIfNeeded(page);
  const api = `${BASE_URL}/api/v1`;
  const post = async <T>(path: string, data: Record<string, unknown>): Promise<T> => {
    const response = await page.request.post(`${api}${path}`, { data });
    expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
    return response.json() as Promise<T>;
  };
  const getAssets = async (): Promise<AssetResponse[]> => {
    const response = await page.request.get(`${api}/assets`);
    expect(response.ok()).toBeTruthy();
    return response.json();
  };
  const accountName = `Bond Fixtures ${Date.now()}`;
  const account = await post<{ id: string }>("/accounts", {
    id: `e2e-bond-fixtures-${Date.now()}`,
    name: accountName,
    accountType: "SECURITIES",
    currency: "USD",
    isDefault: false,
    isActive: true,
    isArchived: false,
    trackingMode: "TRANSACTIONS",
  });
  const assetIds: Record<string, string> = {};

  // Treasury and Börse do not offer ticker search. Enter a market-priced bond
  // through the real security dialog, then select the saved asset in the buy form.
  const note = securities[1];
  await gotoAppPath(page, "/settings/securities");
  await page.getByRole("button", { name: "Add Security", exact: true }).click();
  const securityDialog = page.getByRole("dialog", { name: "Add Security", exact: true });
  await expect(securityDialog).toBeVisible();
  await securityDialog.getByLabel("Symbol", { exact: true }).fill(note.cusip);
  await securityDialog.getByLabel("Name", { exact: true }).fill("Fixture Treasury Note");
  await securityDialog.getByRole("combobox", { name: "Type", exact: true }).click();
  await page.getByRole("option", { name: "Bond", exact: true }).click();
  await securityDialog.getByRole("combobox", { name: "Currency", exact: true }).click();
  await page.getByPlaceholder("Search currency...").fill("USD");
  await page.getByRole("option", { name: /USD/ }).first().click();
  await securityDialog.getByRole("combobox", { name: "Quote Mode", exact: true }).click();
  await page.getByRole("option", { name: "Market (auto-sync)", exact: true }).click();
  await securityDialog.getByRole("button", { name: "Create Security", exact: true }).click();
  await expect(securityDialog).not.toBeVisible();
  await expect
    .poll(async () => (await getAssets()).find((asset) => asset.instrumentSymbol === note.isin)?.id)
    .toBeTruthy();
  assetIds.note = (await getAssets()).find((asset) => asset.instrumentSymbol === note.isin)!.id;

  await gotoActivities(page);
  await openAddActivitySheet(page);
  await selectActivityType(page, "Buy");
  await page.getByRole("button", { name: "Bond", exact: true }).click();
  await selectAccountOption(page, accountName, "USD");
  await searchAndSelectSymbol(page, note.isin);
  // Use dates covered by the fixed upstream yield fixtures, independent of today.
  const dateField = page.getByTestId("date-picker");
  for (const [segment, value] of [
    ["month", "05"],
    ["day", "11"],
    ["year", "2026"],
  ]) {
    await dateField.locator(`[data-type="${segment}"]`).click();
    await page.keyboard.type(value);
  }
  await page.keyboard.press("Tab");
  await page.getByTestId("quantity-input").fill("1000");
  await page.getByTestId("quantity-input").blur();
  await page.getByTestId("price-input").fill("0.98");
  await page.getByTestId("price-input").blur();
  const savedActivity = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/activities") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Add Buy", exact: true }).click();
  const activityResponse = await savedActivity;
  expect(activityResponse.ok(), await activityResponse.text()).toBeTruthy();
  const activity = await activityResponse.json();
  expect(activity.assetId).toBe(assetIds.note);
  expect(Number(activity.quantity)).toBe(1000);
  expect(Number(activity.amount)).toBe(980);
  expect(activity.currency).toBe("USD");
  await expect(page.getByTestId("activity-form-dialog")).not.toBeVisible();

  const buy = (symbol: string, quantity: number, label: string) =>
    post<{ assetId: string }>("/activities", {
      id: `${account.id}-${label}`,
      accountId: account.id,
      activityType: "BUY",
      activityDate: "2026-05-11T10:00:00Z",
      asset: { symbol, quoteMode: "MARKET", quoteCcy: "USD", instrumentType: "BOND" },
      quantity,
      unitPrice: 0.98,
      amount: quantity * 0.98,
      currency: "USD",
      fee: 0,
      tax: 0,
      idempotencyKey: `${account.id}-${label}`,
    });
  for (const security of securities.filter((item) => item.label !== "note")) {
    assetIds[security.label] = (await buy(security.cusip, 1000, security.label)).assetId;
  }
  const alias = await buy("US037833EZ91", 500, "corporate-isin");
  expect(alias.assetId).toBe(assetIds.corporate);
  expect(new Set(Object.values(assetIds)).size).toBe(6);

  await expect
    .poll(
      async () => {
        const assets = await getAssets();
        return securities.map((security) => {
          const asset = assets.find((item) => item.id === assetIds[security.label]);
          return {
            symbol: asset?.instrumentSymbol,
            instrumentType: asset?.instrumentType,
            quoteMode: asset?.quoteMode,
            quoteCcy: asset?.quoteCcy,
            type: asset?.metadata?.bond?.treasuryType ?? null,
            coupon: asset?.metadata?.bond?.couponRate ?? null,
            maturity: asset?.metadata?.bond?.maturityDate ?? null,
            frequency: asset?.metadata?.bond?.couponFrequency ?? null,
            faceValue: asset?.metadata?.bond?.faceValue ?? null,
          };
        });
      },
      { timeout: 60_000 },
    )
    .toEqual(
      securities.map((security) => ({
        symbol: security.label === "corporate" ? security.cusip : security.isin,
        instrumentType: "BOND",
        quoteMode: "MARKET",
        quoteCcy: "USD",
        type: security.type,
        coupon: security.coupon,
        maturity: security.maturity,
        frequency: security.frequency,
        faceValue: security.label === "corporate" ? null : 1000,
      })),
    );
  const assets = await getAssets();
  expect(assets.find((item) => item.id === assetIds.corporate)?.metadata?.identifiers?.isin).toBe(
    "US037833EZ91",
  );

  const refresh = await page.request.post(`${api}/market-data/sync`, {
    data: { assetIds: Object.values(assetIds), refetchAll: true },
  });
  expect(refresh.status()).toBe(204);
  const latestQuotes = () =>
    post<Record<string, { quote?: QuoteResponse | null }>>("/market-data/quotes/latest", {
      assetIds: Object.values(assetIds),
    });
  await expect
    .poll(
      async () => {
        const quotes = await latestQuotes();
        return ["bill", "note", "bond", "corporate"].map(
          (label) => quotes[assetIds[label]]?.quote?.dataSource,
        );
      },
      { timeout: 60_000 },
    )
    .toEqual(["US_TREASURY_CALC", "US_TREASURY_CALC", "US_TREASURY_CALC", "BOERSE_FRANKFURT"]);
  const quotes = await latestQuotes();
  for (const security of securities) {
    const quote = quotes[assetIds[security.label]]?.quote;
    if (security.label === "tips" || security.label === "frn") {
      expect(quote, `${security.label} must not receive a nominal Treasury quote`).toBeFalsy();
    } else {
      expect(quote?.currency).toBe("USD");
      if (security.price !== null) expect(Number(quote?.close)).toBeCloseTo(security.price, 10);
      else {
        expect(Number(quote?.close)).toBeGreaterThan(0.5);
        expect(Number(quote?.close)).toBeLessThan(2);
      }
    }
  }

  const recalc = await page.request.post(`${api}/portfolio/recalculate`);
  expect(recalc.status()).toBe(202);
  for (const security of securities.filter((item) => !["tips", "frn"].includes(item.label))) {
    const quantity = security.label === "corporate" ? 1500 : 1000;
    const price = Number(quotes[assetIds[security.label]]!.quote!.close);
    await expect
      .poll(
        async () => {
          const params = new URLSearchParams({
            accountId: account.id,
            assetId: assetIds[security.label],
          });
          const response = await page.request.get(`${api}/holdings/item?${params}`);
          expect(response.ok()).toBeTruthy();
          const holding = (await response.json()) as HoldingResponse | null;
          // The jobs the purchases queued may not have written it yet.
          if (!holding) return null;
          return {
            quantity: Number(holding.quantity),
            price: Number(holding.price),
            currency: holding.localCurrency,
            value: Math.round(Number(holding.marketValue.local) * 100),
            cost: Math.round(Number(holding.costBasis?.local) * 100),
          };
        },
        { timeout: 60_000 },
      )
      .toEqual({
        quantity,
        price,
        currency: "USD",
        value: Math.round(quantity * price * 100),
        cost: quantity * 98,
      });
  }

  await gotoAppPath(page, "/holdings");
  const accountScope = page.getByRole("combobox").filter({ hasText: "All Accounts" });
  await expect(accountScope).toBeVisible({ timeout: 10_000 });
  await accountScope.click();
  await page.getByPlaceholder("Search accounts...").fill(accountName);
  await page.getByRole("option", { name: new RegExp(accountName) }).click();
  const rows = securities.map((security) => ({
    label: security.label,
    row: page
      .getByRole("row")
      .filter({ hasText: security.label === "corporate" ? security.cusip : security.isin })
      .first(),
  }));
  for (const { row } of rows) await expect(row).toBeVisible({ timeout: 60_000 });
  const typeFilter = page.getByRole("button", { name: /^Type/ });
  await expect(typeFilter).toBeVisible({ timeout: 5000 });
  await typeFilter.click();
  await expect(page.getByRole("option", { name: "BONDS 1", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "GOVERNMENT BOND 5", exact: true })).toBeVisible();
  await page.getByRole("option", { name: "BONDS 1", exact: true }).click();
  await page.keyboard.press("Escape");
  for (const { label, row } of rows) {
    if (label === "corporate") await expect(row).toBeVisible();
    else await expect(row).not.toBeVisible();
  }
  await typeFilter.click();
  await page.getByRole("option", { name: "BONDS 1", exact: true }).click();
  await page.getByRole("option", { name: "GOVERNMENT BOND 5", exact: true }).click();
  await page.keyboard.press("Escape");
  for (const { label, row } of rows) {
    if (label === "corporate") await expect(row).not.toBeVisible();
    else await expect(row).toBeVisible();
  }
});
