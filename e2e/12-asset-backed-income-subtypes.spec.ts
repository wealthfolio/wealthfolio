import { expect, Page, test } from "@playwright/test";
import {
  BASE_URL,
  completeOnboardingIfNeeded,
  createAccount,
  fillDateField,
  gotoActivities,
  gotoAppPath,
  openAddActivitySheet,
  searchAndSelectSymbol,
  selectAccountOption,
  selectActivityType,
  waitForSyncToast,
} from "./helpers";

test.describe.configure({ mode: "serial" });

interface AccountResponse {
  id: string;
  name: string;
  currency: string;
}

interface HoldingLotResponse {
  quantity: number;
  costBasis: number;
  acquisitionPrice: number;
  acquisitionFees: number;
}

interface HoldingResponse {
  quantity: number;
  localCurrency: string;
  instrument?: {
    id?: string | null;
    symbol?: string | null;
  } | null;
  costBasis?: {
    local: number;
  } | null;
  lots?: HoldingLotResponse[] | null;
}

interface ExpectedHolding {
  symbol: string;
  quantity: number;
  costBasis: number;
  averageCost: number;
}

test.describe("Asset-backed income subtypes update holdings", () => {
  let page: Page;
  const runId = Date.now().toString(36);
  const accountName = `Asset-backed Income ${runId}`;
  const currency = "USD";

  const dividendInKind = {
    symbol: "MSFT",
    subtype: "In kind",
    tableSubtype: "Dividend in Kind",
    quantity: 0.125,
    unitPrice: 80,
    amount: 10,
    notes: "Dividend paid in shares",
  };

  const stakingReward = {
    symbol: "AAPL",
    subtype: "Staking reward",
    tableSubtype: "Staking Reward",
    quantity: 0.02,
    unitPrice: 200,
    amount: 4,
    notes: "Asset staking reward",
  };

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  function round(value: number | null | undefined, decimals: number) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }

  async function getAccountId() {
    const response = await page.request.get(`${BASE_URL}/api/v1/accounts`);
    expect(response.ok()).toBeTruthy();
    const accounts = (await response.json()) as AccountResponse[];
    const account = accounts.find(
      (item) => item.name === accountName && item.currency === currency,
    );
    expect(account, `Expected account ${accountName} to exist`).toBeTruthy();
    return account!.id;
  }

  async function getHoldings() {
    const accountId = await getAccountId();
    const response = await page.request.get(
      `${BASE_URL}/api/v1/holdings?accountId=${encodeURIComponent(accountId)}`,
    );
    expect(response.ok()).toBeTruthy();
    return (await response.json()) as HoldingResponse[];
  }

  async function getDetailedHolding(accountId: string, assetId: string) {
    const params = new URLSearchParams({ accountId, assetId });
    const response = await page.request.get(`${BASE_URL}/api/v1/holdings/item?${params}`);
    expect(response.ok()).toBeTruthy();
    return (await response.json()) as HoldingResponse | null;
  }

  async function selectAccount() {
    await selectAccountOption(page, accountName, currency);
  }

  async function selectSubtype(subtype: string) {
    const dialog = page.getByRole("dialog", { name: "Add Activity" });
    const subtypeRadio = dialog.getByRole("radio", { name: subtype, exact: true });
    await expect(subtypeRadio).toBeVisible({ timeout: 5000 });
    await subtypeRadio.click();
    await expect(subtypeRadio).toBeChecked();
  }

  async function fillNumber(testId: string, value: number) {
    const input = page.getByTestId(testId);
    await input.fill(String(value));
    await input.blur();
  }

  async function fillNotes(notes: string) {
    // Notes live inside the collapsible "Advanced & notes" section — expand it first.
    const input = page.getByTestId("notes-input");
    if (!(await input.isVisible().catch(() => false))) {
      await page.getByTestId("advanced-options-button").click();
      await expect(input).toBeVisible({ timeout: 5000 });
    }
    await input.fill(notes);
    await input.blur();
  }

  async function submitActivity(buttonName: RegExp) {
    const submitButton = page.getByRole("button", { name: buttonName });
    await expect(submitButton).toBeEnabled({ timeout: 5000 });
    await submitButton.click();
    await expect(page.getByRole("heading", { name: "Add Activity" })).not.toBeVisible({
      timeout: 20000,
    });
    await page.waitForTimeout(500);
  }

  async function expectActivityRow(type: string, subtype: string, symbol: string) {
    await expect(
      page
        .locator("tr")
        .filter({ hasText: type })
        .filter({ hasText: subtype })
        .filter({ hasText: symbol })
        .filter({ hasText: accountName }),
    ).toBeVisible({ timeout: 10000 });
  }

  async function expectHolding(expected: ExpectedHolding) {
    await waitForSyncToast(page, 60_000);

    await expect
      .poll(
        async () => {
          const accountId = await getAccountId();
          const holdings = await getHoldings();
          const listHolding = holdings.find(
            (item) => item.instrument?.symbol?.toUpperCase() === expected.symbol,
          );
          const assetId = listHolding?.instrument?.id;
          const holding = assetId ? await getDetailedHolding(accountId, assetId) : listHolding;
          const lot = holding?.lots?.[0];
          const costBasis = holding?.costBasis?.local;

          return {
            quantity: round(holding?.quantity, 4),
            costBasis: round(costBasis, 2),
            averageCost: round(
              typeof costBasis === "number" && holding?.quantity
                ? costBasis / holding.quantity
                : null,
              2,
            ),
            lotCount: holding?.lots?.length ?? 0,
            lotQuantity: round(lot?.quantity, 4),
            lotCostBasis: round(lot?.costBasis, 2),
            lotAcquisitionPrice: round(lot?.acquisitionPrice, 2),
            lotAcquisitionFees: round(lot?.acquisitionFees, 2),
          };
        },
        { timeout: 90_000, intervals: [1000, 2000, 5000] },
      )
      .toEqual({
        quantity: expected.quantity,
        costBasis: expected.costBasis,
        averageCost: expected.averageCost,
        lotCount: 1,
        lotQuantity: expected.quantity,
        lotCostBasis: expected.costBasis,
        lotAcquisitionPrice: expected.averageCost,
        lotAcquisitionFees: 0,
      });
  }

  async function expectHoldingVisibleInAccount(symbol: string, quantity: number) {
    await gotoAppPath(page, "/settings/accounts");
    const accountLink = page.getByRole("link", { name: accountName });
    await expect(accountLink).toBeVisible({ timeout: 10000 });
    await accountLink.click();
    await expect(page).toHaveURL(/\/accounts\/[^/]+/, { timeout: 10000 });

    const row = page.locator("tbody tr").filter({ hasText: symbol }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    const escapedQuantity = String(quantity).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await expect(row).toContainText(new RegExp(`(^|\\D)${escapedQuantity}(\\D|$)`));
  }

  test("1. Setup: login/onboard and create isolated account", async () => {
    test.setTimeout(180_000);

    await completeOnboardingIfNeeded(page);
    await createAccount(page, accountName, currency);
  });

  test("2. Dividend in kind creates shares with matching cost basis", async () => {
    test.setTimeout(120_000);

    await gotoActivities(page);
    await openAddActivitySheet(page);
    await selectActivityType(page, "Dividend");
    await selectAccount();
    await searchAndSelectSymbol(page, dividendInKind.symbol);
    await fillDateField(page, 10);
    await selectSubtype(dividendInKind.subtype);
    await fillNumber("received-quantity-input", dividendInKind.quantity);
    await fillNumber("fmv-per-unit-input", dividendInKind.unitPrice);
    await fillNumber("dividend-amount-input", dividendInKind.amount);
    await fillNotes(dividendInKind.notes);
    await submitActivity(/Add Dividend/i);

    await expectActivityRow("Dividend", dividendInKind.tableSubtype, dividendInKind.symbol);
    await expectHolding({
      symbol: dividendInKind.symbol,
      quantity: dividendInKind.quantity,
      costBasis: dividendInKind.amount,
      averageCost: dividendInKind.unitPrice,
    });
    await expectHoldingVisibleInAccount(dividendInKind.symbol, dividendInKind.quantity);
  });

  test("3. Staking reward creates reward units with matching cost basis", async () => {
    test.setTimeout(120_000);

    await gotoActivities(page);
    await openAddActivitySheet(page);
    await selectActivityType(page, "Interest");
    await selectAccount();
    await selectSubtype(stakingReward.subtype);
    await searchAndSelectSymbol(page, stakingReward.symbol);
    await fillDateField(page, 9);
    await fillNumber("received-quantity-input", stakingReward.quantity);
    await fillNumber("fmv-per-unit-input", stakingReward.unitPrice);
    await fillNumber("interest-amount-input", stakingReward.amount);
    await fillNotes(stakingReward.notes);
    await submitActivity(/Add Interest/i);

    await expectActivityRow("Interest", stakingReward.tableSubtype, stakingReward.symbol);
    await expectHolding({
      symbol: stakingReward.symbol,
      quantity: stakingReward.quantity,
      costBasis: stakingReward.amount,
      averageCost: stakingReward.unitPrice,
    });
    await expectHoldingVisibleInAccount(stakingReward.symbol, stakingReward.quantity);
  });
});
