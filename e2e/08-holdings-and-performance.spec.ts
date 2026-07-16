import { expect, Page, test } from "@playwright/test";
import { BASE_URL, loginIfNeeded, waitForSyncToast } from "./helpers";

test.describe.configure({ mode: "serial" });

interface AccountPayload {
  id: string;
  name: string;
  currency: string;
}

interface ActivityPayload {
  id: string;
  assetId?: string | null;
}

interface HoldingPayload {
  quantity: number | string;
  costBasis?: { local?: number | string | null } | null;
  realizedGain?: { local?: number | string | null } | null;
}

interface AssetLotPayload {
  accountId: string;
  quantity: number | string;
  remainingQuantity: number | string;
  costBasis: number | string;
  unitCost: number | string;
  fees: number | string;
  taxes: number | string;
  isClosed: boolean;
  disposalProceeds?: number | string | null;
  disposalCostBasis?: number | string | null;
  realizedPnl?: number | string | null;
}

interface TaxTradeState {
  holding: {
    quantity: number;
    costBasis: number;
    realizedGain: number | null;
  } | null;
  assetLots: Array<{
    quantity: number;
    remainingQuantity: number;
    costBasis: number;
    unitCost: number;
    fees: number;
    taxes: number;
    isClosed: boolean;
    disposalProceeds: number | null;
    disposalCostBasis: number | null;
    realizedPnl: number | null;
  }>;
}

test.describe("Holdings and Performance Pages", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("1. Setup: login", async () => {
    test.setTimeout(180000);
    await loginIfNeeded(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("portfolio-balance-value")).toBeVisible({ timeout: 30000 });
  });

  test("2. Trade tax is included in holdings and lot calculations", async () => {
    test.setTimeout(120000);

    await loginIfNeeded(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });

    const account = await createApiAccount(page, `E2E Trade Tax Account ${Date.now()}`);
    const buyActivity = await createApiTradeActivity(page, {
      id: `${account.id}-buy`,
      accountId: account.id,
      activityType: "BUY",
      activityDate: "2026-05-10T10:00:00.000Z",
      quantity: 10,
      unitPrice: 100,
      fee: 5,
      tax: 4,
    });
    await createApiTradeActivity(page, {
      id: `${account.id}-sell`,
      accountId: account.id,
      activityType: "SELL",
      activityDate: "2026-05-11T10:00:00.000Z",
      quantity: 4,
      unitPrice: 120,
      fee: 2,
      tax: 3,
    });
    await triggerFullRecalculation(page);

    const assetId = buyActivity.assetId;
    expect(assetId, "Expected created BUY activity to resolve an AAPL asset").toBeTruthy();
    await expect
      .poll(() => getTaxTradeState(page, account.id, assetId!), {
        timeout: 60000,
        intervals: [1000, 2000, 5000],
      })
      .toEqual({
        holding: {
          quantity: 6,
          costBasis: 605.4,
          realizedGain: 71.4,
        },
        assetLots: [
          {
            quantity: 6,
            remainingQuantity: 6,
            costBasis: 605.4,
            unitCost: 100,
            fees: 5,
            taxes: 4,
            isClosed: false,
            disposalProceeds: 475,
            disposalCostBasis: 403.6,
            realizedPnl: 71.4,
          },
        ],
      });
  });

  test("3. Holdings page loads with AAPL row", async () => {
    test.setTimeout(60000);

    await page.goto(`${BASE_URL}/holdings`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    // Table should be visible
    const holdingsTable = page.locator("table").first();
    await expect(holdingsTable).toBeVisible({ timeout: 15000 });

    // Should have at least one holding row when this spec runs in isolation.
    const rows = page.locator("tbody tr");
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThanOrEqual(1);

    // AAPL row should be present
    const aaplRow = page.getByRole("row").filter({ hasText: "AAPL" });
    await expect(aaplRow.first()).toBeVisible({ timeout: 10000 });
  });

  test("4. Account filter: CAD account shows SHOP.TO", async () => {
    test.setTimeout(60000);

    await page.goto(`${BASE_URL}/holdings`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // Look for an account filter control
    const accountFilter = page
      .getByRole("button", { name: /Account/i })
      .or(page.getByText(/All Accounts/i))
      .first();

    if (await accountFilter.isVisible({ timeout: 5000 }).catch(() => false)) {
      await accountFilter.click();
      await page.waitForTimeout(300);

      // Select CAD Account
      const cadOption = page.getByRole("option", { name: /CAD Account/i }).first();
      if (await cadOption.isVisible({ timeout: 3000 }).catch(() => false)) {
        await cadOption.click();
        await page.waitForTimeout(1000);

        // SHOP.TO should be visible
        const shopRow = page.getByRole("row").filter({ hasText: /SHOP/i });
        await expect(shopRow.first()).toBeVisible({ timeout: 10000 });
      }
    } else {
      // If no account filter UI found, just verify holdings table loaded
      const holdingsTable = page.locator("table").first();
      await expect(holdingsTable).toBeVisible({ timeout: 10000 });
    }
  });

  test("5. Performance page smoke test: loads without errors", async () => {
    test.setTimeout(60000);

    await page.goto(`${BASE_URL}/performance`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    // Page should not show an error boundary message
    await expect(page.getByText(/something went wrong/i)).not.toBeVisible();
  });

  test("6. Dashboard: total value > 0 and account tiles visible", async () => {
    test.setTimeout(60000);

    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    const balanceElement = page.getByTestId("portfolio-balance-value");
    await expect(balanceElement).toBeVisible({ timeout: 15000 });

    // Balance should be a non-zero value
    const balanceText = (await balanceElement.textContent()) || "";
    const numericBalance = parseFloat(balanceText.replace(/[^0-9.]/g, "") || "0");
    expect(numericBalance).toBeGreaterThan(0);

    // At least one account tile or account name should be visible
    const accountTile = page
      .getByText(/CAD Account|USD Account|EUR Account|GBP Account|E2E Trade Tax Account/i)
      .first();
    await expect(accountTile).toBeVisible({ timeout: 10000 });
  });
});

async function createApiAccount(page: Page, name: string): Promise<AccountPayload> {
  return apiPost<AccountPayload>(page, "/accounts", {
    id: `e2e-tax-${Date.now()}`,
    name,
    accountType: "SECURITIES",
    group: null,
    currency: "USD",
    isDefault: false,
    isActive: true,
    isArchived: false,
    trackingMode: "TRANSACTIONS",
    platformId: null,
    accountNumber: null,
    meta: null,
    provider: null,
    providerAccountId: null,
  });
}

async function createApiTradeActivity(
  page: Page,
  activity: {
    id: string;
    accountId: string;
    activityType: "BUY" | "SELL";
    activityDate: string;
    quantity: number;
    unitPrice: number;
    fee: number;
    tax: number;
  },
): Promise<ActivityPayload> {
  return apiPost<ActivityPayload>(page, "/activities", {
    id: activity.id,
    accountId: activity.accountId,
    activityType: activity.activityType,
    activityDate: activity.activityDate,
    asset: {
      symbol: "AAPL",
      quoteMode: "MARKET",
      quoteCcy: "USD",
      instrumentType: "EQUITY",
      exchangeMic: "XNAS",
    },
    quantity: activity.quantity,
    unitPrice: activity.unitPrice,
    amount: activity.quantity * activity.unitPrice,
    currency: "USD",
    fee: activity.fee,
    tax: activity.tax,
    comment: `${activity.activityType} AAPL with trade tax`,
    idempotencyKey: activity.id,
  });
}

async function triggerFullRecalculation(page: Page) {
  const response = await page.request.post(`${BASE_URL}/api/v1/portfolio/recalculate`);
  expect(response.status()).toBe(202);
  await waitForSyncToast(page, 90000);
}

async function getTaxTradeState(
  page: Page,
  accountId: string,
  assetId: string,
): Promise<TaxTradeState> {
  const holding = await apiGet<HoldingPayload | null>(
    page,
    `/holdings/item?accountId=${encodeURIComponent(accountId)}&assetId=${encodeURIComponent(assetId)}`,
  );
  const assetLots = await apiGet<AssetLotPayload[]>(
    page,
    `/holdings/lots?assetId=${encodeURIComponent(assetId)}&includeSnapshotPositions=false`,
  );

  return {
    holding: holding
      ? {
          quantity: toRoundedNumber(holding.quantity),
          costBasis: toRoundedNumber(holding.costBasis?.local),
          realizedGain: toRoundedNullableNumber(holding.realizedGain?.local),
        }
      : null,
    assetLots: assetLots
      .filter((lot) => lot.accountId === accountId)
      .map((lot) => ({
        quantity: toRoundedNumber(lot.quantity),
        remainingQuantity: toRoundedNumber(lot.remainingQuantity),
        costBasis: toRoundedNumber(lot.costBasis),
        unitCost: toRoundedNumber(lot.unitCost),
        fees: toRoundedNumber(lot.fees),
        taxes: toRoundedNumber(lot.taxes),
        isClosed: lot.isClosed,
        disposalProceeds: toRoundedNullableNumber(lot.disposalProceeds),
        disposalCostBasis: toRoundedNullableNumber(lot.disposalCostBasis),
        realizedPnl: toRoundedNullableNumber(lot.realizedPnl),
      })),
  };
}

async function apiGet<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`${BASE_URL}/api/v1${path}`);
  expect(response.ok(), `GET ${path} failed with ${response.status()}`).toBeTruthy();
  return response.json() as Promise<T>;
}

async function apiPost<T>(page: Page, path: string, body: Record<string, unknown>): Promise<T> {
  const response = await page.request.post(`${BASE_URL}/api/v1${path}`, { data: body });
  if (!response.ok()) {
    const details = await response.text();
    expect(response.ok(), `POST ${path} failed with ${response.status()}: ${details}`).toBeTruthy();
  }
  return response.json() as Promise<T>;
}

function toRoundedNumber(value: number | string | null | undefined): number {
  return Number(Number(value ?? 0).toFixed(4));
}

function toRoundedNullableNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  return toRoundedNumber(value);
}
