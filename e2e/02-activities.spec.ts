import { expect, type Locator, Page, test } from "@playwright/test";
import {
  BASE_URL,
  completeOnboardingIfNeeded,
  createAccount,
  gotoActivities,
  gotoAppPath,
  selectAccountOption,
} from "./helpers";

test.describe.configure({ mode: "serial" });

test.describe("Activity Creation Tests", () => {
  let page: Page;
  const runId = Date.now().toString(36);

  // Test data for activities
  const TEST_DATA = {
    accounts: [
      { name: "Test USD Account", currency: "USD" },
      { name: "Test CAD Account", currency: "CAD" },
    ],
    // Activities to test - organized by type
    activities: {
      deposit: {
        account: "Test USD Account",
        currency: "USD",
        amount: 10000,
        notes: "Initial deposit for testing",
      },
      withdrawal: {
        account: "Test USD Account",
        currency: "USD",
        amount: 500,
        notes: "Test withdrawal",
      },
      buy: {
        account: "Test USD Account",
        currency: "USD",
        symbol: "AAPL",
        quantity: 5,
        price: 150,
        fee: 10,
        notes: "Test buy order",
      },
      buyWithAdvanced: {
        account: "Test USD Account",
        currency: "USD",
        symbol: "MSFT",
        quantity: 3,
        price: 400,
        fee: 5,
        notes: "Buy with advanced options",
        advanced: {
          currency: "USD",
          fxRate: 1.0,
        },
      },
      sell: {
        account: "Test USD Account",
        currency: "USD",
        symbol: "AAPL",
        quantity: 2,
        price: 155,
        fee: 5,
        notes: "Test sell order",
      },
      dividend: {
        account: "Test USD Account",
        currency: "USD",
        symbol: "AAPL",
        amount: 25,
        notes: "Dividend received",
      },
      dividendWithSubtype: {
        account: "Test USD Account",
        currency: "USD",
        symbol: "MSFT",
        amount: 15,
        quantity: 0.1,
        unitPrice: 150,
        notes: "Dividend in kind",
        subtype: "In kind",
      },
      transfer: {
        fromAccount: "Test USD Account",
        toAccount: "Test CAD Account",
        amount: 1000,
        notes: "Transfer between accounts",
      },
      externalCashTransferOut: {
        account: "Test USD Account",
        currency: "USD",
        amount: 500,
        notes: "External cash transfer out",
      },
      externalCashTransferIn: {
        account: "Test USD Account",
        currency: "USD",
        amount: 750,
        notes: "External cash transfer in",
      },
      internalSecuritiesTransfer: {
        fromAccount: "Test USD Account",
        toAccount: "Test CAD Account",
        symbol: "AAPL",
        quantity: 1,
        notes: "Internal securities transfer",
      },
      externalSecuritiesTransferIn: {
        account: "Test USD Account",
        currency: "USD",
        symbol: "MSFT",
        quantity: 2,
        costBasis: 400,
        notes: "External securities transfer in",
      },
      exchange: {
        account: "Test USD Account",
        currency: "USD",
        fromSymbol: "AAPL",
        fromQuantity: 2,
        toSymbol: "GOOGL",
        toQuantity: 1,
        notes: "In-kind fund switch",
      },
      fee: {
        account: "Test USD Account",
        currency: "USD",
        amount: 25,
        notes: "Management fee",
      },
      interest: {
        account: "Test USD Account",
        currency: "USD",
        amount: 50,
        notes: "Interest earned",
      },
      tax: {
        account: "Test USD Account",
        currency: "USD",
        amount: 100,
        notes: "Withholding tax",
      },
      credit: {
        account: "Test USD Account",
        currency: "USD",
        amount: 75.25,
        updatedAmount: 80.5,
        notes: `E2E credit ${runId}`,
        updatedNotes: `E2E credit updated ${runId}`,
      },
      cashAdjustment: {
        amount: 10,
        securitiesAmount: 360,
        finalCashAmount: 25,
        symbol: "AAPL",
        quantity: 2,
        unitPrice: 180,
        notes: `E2E cash adjustment ${runId}`,
      },
      optionExpiryAdjustment: {
        symbol: "AAPL270115C00200000",
        quantity: 1,
        updatedQuantity: 2,
        notes: `E2E option expiry ${runId}`,
      },
      split: {
        account: "Test USD Account",
        currency: "USD",
        symbol: "AAPL",
        splitRatio: 2,
        notes: "Stock split 2:1",
      },
      // Custom asset activity
      customAssetBuy: {
        account: "Test USD Account",
        currency: "USD",
        customAsset: {
          symbol: "MYCOIN",
          name: "My Custom Coin",
          assetType: "Cryptocurrency",
          currency: "USD",
        },
        quantity: 100,
        price: 5,
        fee: 1,
        notes: "Custom asset purchase",
      },
    },
  };

  // Helper functions
  const activityTypeTestIds: Record<string, string> = {
    Buy: "activity-type-buy",
    Sell: "activity-type-sell",
    Deposit: "activity-type-deposit",
    Withdrawal: "activity-type-withdrawal",
    Dividend: "activity-type-dividend",
    Transfer: "activity-type-transfer",
    Exchange: "activity-type-exchange",
    Split: "activity-type-split",
    Fee: "activity-type-fee",
    Interest: "activity-type-interest",
    Tax: "activity-type-tax",
    Credit: "activity-type-credit",
  };

  async function waitForOverlayClose() {
    await page
      .locator('[data-state="open"][aria-hidden="true"]')
      .waitFor({ state: "hidden", timeout: 5000 })
      .catch(() => {});
  }

  async function openAddActivitySheet() {
    await waitForOverlayClose();
    await page.getByTestId("add-activities-button").click();
    await page.getByTestId("add-transaction-action").click();
    await expect(page.getByTestId("activity-form-dialog")).toBeVisible();
  }

  async function selectActivityType(type: string) {
    const typeButton = page.getByTestId(activityTypeTestIds[type]);
    if (!(await typeButton.isVisible().catch(() => false))) {
      await page.getByRole("button", { name: "Expand to show all types" }).click();
    }
    await expect(typeButton).toBeVisible();
    await typeButton.click();
    await page.waitForTimeout(200);
  }

  async function selectAccount(accountName: string, currency: string, label?: string) {
    // Use label to disambiguate when multiple account selects exist (e.g., Transfer form)
    const accountSelect = label
      ? page.getByRole("combobox", { name: label })
      : page.getByTestId("account-select");
    await selectAccountOption(page, accountName, currency, accountSelect);
  }

  // Counter to spread activities over different dates
  let activityDateCounter = 30;

  // Helper to generate date parts for a date N days ago
  function getDatePartsAgo(daysAgo: number): { month: string; day: string; year: string } {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    return {
      month: String(date.getMonth() + 1).padStart(2, "0"),
      day: String(date.getDate()).padStart(2, "0"),
      year: String(date.getFullYear()),
    };
  }

  async function selectDate() {
    // Fill React Aria DateInput by clicking on each segment with data-type attributes
    const { month, day, year } = getDatePartsAgo(activityDateCounter);
    activityDateCounter = Math.max(1, activityDateCounter - 1); // Decrement but stay positive

    // Find the date field container using testid
    const dateField = page.getByTestId("date-picker");

    // Click and fill month segment
    const monthSegment = dateField.locator('[data-type="month"]');
    await monthSegment.click();
    await page.waitForTimeout(50);
    await page.keyboard.type(month, { delay: 30 });
    await page.waitForTimeout(50);

    // Click and fill day segment
    const daySegment = dateField.locator('[data-type="day"]');
    await daySegment.click();
    await page.waitForTimeout(50);
    await page.keyboard.type(day, { delay: 30 });
    await page.waitForTimeout(50);

    // Click and fill year segment
    const yearSegment = dateField.locator('[data-type="year"]');
    await yearSegment.click();
    await page.waitForTimeout(50);
    await page.keyboard.type(year, { delay: 30 });
    await page.waitForTimeout(50);

    // Click and fill hour segment (10 AM)
    const hourSegment = dateField.locator('[data-type="hour"]');
    await hourSegment.click();
    await page.waitForTimeout(50);
    await page.keyboard.type("10", { delay: 30 });
    await page.waitForTimeout(50);

    // Click and fill minute segment
    const minuteSegment = dateField.locator('[data-type="minute"]');
    await minuteSegment.click();
    await page.waitForTimeout(50);
    await page.keyboard.type("00", { delay: 30 });
    await page.waitForTimeout(50);

    // Click and fill AM/PM segment
    const dayPeriodSegment = dateField.locator('[data-type="dayPeriod"]');
    await dayPeriodSegment.click();
    await page.waitForTimeout(50);
    await page.keyboard.type("A", { delay: 30 });
    await page.waitForTimeout(100);

    // Tab to move to next field
    await page.keyboard.press("Tab");
    await page.waitForTimeout(100);
  }

  async function searchAndSelectSymbol(symbol: string, dialogName = "Add Activity") {
    const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactSymbolPattern = new RegExp(`^${escapedSymbol}$`, "i");
    const activityDialog = page.getByRole("dialog", { name: dialogName });
    const symbolCombobox = activityDialog
      .getByRole("combobox")
      .filter({ hasText: /Select symbol/i });
    await symbolCombobox.click();

    const searchInput = page.getByPlaceholder("Search for symbol");
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await searchInput.fill(symbol);

    const suggestions = page.getByRole("listbox", { name: /Suggestions/i });
    await expect(suggestions).toBeVisible({ timeout: 10000 });
    const symbolOption = suggestions
      .getByRole("option")
      .filter({
        has: page.locator("span.font-mono").filter({ hasText: exactSymbolPattern }),
        hasNotText: /Create custom|manual/i,
      })
      .first();
    await expect(symbolOption).toBeVisible({ timeout: 30000 });
    await symbolOption.click();
  }

  // Like searchAndSelectSymbol, but scoped to a specific combobox by its
  // accessible name — needed for forms with more than one symbol picker
  // (e.g. Exchange's "Closing Asset" / "Opening Asset").
  async function searchAndSelectSymbolIn(comboboxLabel: string, symbol: string) {
    const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactSymbolPattern = new RegExp(`^${escapedSymbol}$`, "i");
    const activityDialog = page.getByRole("dialog", { name: "Add Activity" });
    const symbolCombobox = activityDialog.getByRole("combobox", { name: comboboxLabel });
    await symbolCombobox.click();

    const searchInput = page.getByPlaceholder("Search for symbol");
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await searchInput.fill(symbol);

    const suggestions = page.getByRole("listbox", { name: /Suggestions/i });
    await expect(suggestions).toBeVisible({ timeout: 10000 });
    const symbolOption = suggestions
      .getByRole("option")
      .filter({
        has: page.locator("span.font-mono").filter({ hasText: exactSymbolPattern }),
        hasNotText: /Create custom|manual/i,
      })
      .first();
    await expect(symbolOption).toBeVisible({ timeout: 30000 });
    await symbolOption.click();

    // Wait for this popover to fully close before returning — otherwise a
    // second call targeting a different combobox in the same form can hit a
    // strict-mode violation against a lingering "Search for symbol" input.
    await expect(searchInput).toBeHidden({ timeout: 5000 });
  }

  async function fillAmount(value: number, testId = "amount-input") {
    const amountInput = page.getByRole("dialog", { name: "Add Activity" }).getByTestId(testId);
    await expect(amountInput).toBeVisible({ timeout: 5000 });
    await amountInput.fill(String(value));
    await amountInput.blur();
  }

  async function fillInternalTransferCashAmount(value: number) {
    const activityDialog = page.getByRole("dialog", { name: "Add Activity" });
    const sentAmountInput = activityDialog.getByTestId("sent-amount-input");
    const simpleAmountInput = activityDialog.getByTestId("input-amount");

    await expect
      .poll(
        async () =>
          (await sentAmountInput.isVisible().catch(() => false)) ||
          (await simpleAmountInput.isVisible().catch(() => false)),
        { timeout: 5000 },
      )
      .toBe(true);

    if (await sentAmountInput.isVisible()) {
      await sentAmountInput.fill(String(value));
      await sentAmountInput.blur();

      const receivedAmountInput = activityDialog.getByTestId("received-amount-input");
      if (await receivedAmountInput.isVisible()) {
        await receivedAmountInput.fill(String(value));
        await receivedAmountInput.blur();
      }
      return;
    }

    await simpleAmountInput.fill(String(value));
    await simpleAmountInput.blur();
  }

  async function fillQuantity(value: number) {
    const quantityInput = page.getByTestId("quantity-input");
    await quantityInput.fill(String(value));
    await quantityInput.blur();
  }

  async function fillPrice(value: number) {
    const priceInput = page.getByTestId("price-input");
    await priceInput.fill(String(value));
    await priceInput.blur();
  }

  async function fillFee(value: number) {
    const feeInput = page.getByTestId("fee-input");
    await feeInput.fill(String(value));
    await feeInput.blur();
  }

  async function fillNotes(text: string) {
    const notesInput = page.getByTestId("notes-input");
    if (await notesInput.isVisible()) {
      await notesInput.fill(text);
      await notesInput.blur();
    }
  }

  async function expandAdvancedOptions() {
    const advancedButton = page.getByTestId("advanced-options-button");
    await expect(advancedButton).toBeVisible({ timeout: 5000 });
    await advancedButton.click();
    // Wait for collapsible content to expand
    await page.waitForTimeout(500);
    // Wait for FX Rate field to be visible
    const fxRateInput = page.getByTestId("fx-rate-input");
    await expect(fxRateInput).toBeVisible({ timeout: 5000 });
  }

  async function selectSubtype(subtype: string) {
    const subtypeLabel = subtype === "None" ? "Cash" : subtype;
    const dialog = page.getByRole("dialog", { name: "Add Activity" });
    const subtypeRadio = dialog.getByRole("radio", { name: subtypeLabel, exact: true });
    await expect(subtypeRadio).toBeVisible({ timeout: 5000 });
    await subtypeRadio.click();
    await expect(subtypeRadio).toBeChecked();
  }

  async function fillFxRate(rate: number) {
    const fxRateInput = page.getByTestId("fx-rate-input");
    await expect(fxRateInput).toBeVisible({ timeout: 5000 });
    await fxRateInput.fill(String(rate));
    await fxRateInput.blur();
  }

  async function submitActivity(activityType: string) {
    // Transfer form has dynamic button text (e.g., "Transfer 1,000.00" when amount is filled)
    // We need to match the submit button specifically, not the activity type picker
    // Other forms use "Add {type}" pattern
    let buttonPattern: RegExp;
    if (activityType.startsWith("Transfer")) {
      // Matches "Transfer 1,000.00", "Transfer Out $500.00", "Transfer In 2 MSFT", etc.
      // Won't match the bare "Transfer" activity type selector button
      buttonPattern = new RegExp(`^${activityType}\\s+`, "i");
    } else {
      buttonPattern = new RegExp(`Add ${activityType}`, "i");
    }
    const submitButton = page.getByRole("button", { name: buttonPattern });
    await expect(submitButton).toBeEnabled({ timeout: 5000 });
    await submitButton.click();

    // Wait for sheet to close
    await expect(page.getByRole("heading", { name: "Add Activity" })).not.toBeVisible({
      timeout: 20000,
    });
    await page.waitForTimeout(500);
  }

  // Map activity type to display name for verification
  const ACTIVITY_TYPE_DISPLAY: Record<string, string> = {
    DEPOSIT: "Deposit",
    WITHDRAWAL: "Withdrawal",
    BUY: "Buy",
    SELL: "Sell",
    DIVIDEND: "Dividend",
    TRANSFER_OUT: "Transfer Out",
    TRANSFER_IN: "Transfer In",
    ADJUSTMENT: "Adjustment",
    FEE: "Fee",
    INTEREST: "Interest",
    TAX: "Tax",
    SPLIT: "Split",
    CREDIT: "Credit",
    ADJUSTMENT: "Adjustment",
  };

  interface ActivityApiResponse {
    id: string;
    activityType: string;
    subtype: string | null;
    assetId: string | null;
    assetSymbol: string | null;
    instrumentType: string | null;
    quantity: string | null;
    unitPrice: string | null;
    amount: string | null;
    comment: string | null;
  }

  async function getTestAccountId() {
    const response = await page.request.get(`${BASE_URL}/api/v1/accounts`);
    expect(response.ok()).toBeTruthy();
    const accounts = (await response.json()) as Array<{
      id: string;
      name: string;
      currency: string;
    }>;
    const account = accounts.find(
      (item) => item.name === "Test USD Account" && item.currency === "USD",
    );
    expect(account, "Expected the activities E2E account to exist").toBeTruthy();
    return account!.id;
  }

  async function seedActivity(data: Record<string, unknown>) {
    const response = await page.request.post(`${BASE_URL}/api/v1/activities`, { data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return (await response.json()) as ActivityApiResponse;
  }

  async function getActivity(activityId: string) {
    const response = await page.request.post(`${BASE_URL}/api/v1/activities/search`, {
      data: { page: 0, pageSize: 10, activityIdFilter: [activityId] },
    });
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as { data: ActivityApiResponse[] };
    expect(body.data).toHaveLength(1);
    return body.data[0];
  }

  async function openActivityEditor(...rowText: string[]) {
    await gotoActivities(page);
    let row = page.locator("tbody tr");
    for (const text of rowText) {
      row = row.filter({ hasText: text });
    }
    const targetRow = row.first();
    await expect(targetRow).toBeVisible({ timeout: 10000 });
    const dialog = page.getByRole("dialog", { name: "Update Activity" });
    await expect(async () => {
      await targetRow.getByRole("button", { name: "Open", exact: true }).press("Enter");
      await page
        .getByRole("menuitem", { name: "Edit", exact: true })
        .evaluate((element: HTMLElement) => element.click());
      await expect(dialog).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 10000 });
    return dialog;
  }

  async function updateActivity(dialog: Locator) {
    const updateButton = dialog.getByRole("button", { name: "Update", exact: true });
    await expect(updateButton).toBeEnabled({ timeout: 5000 });
    await updateButton.click();
    await expect(dialog).not.toBeVisible({ timeout: 20000 });
  }

  async function expectInputNumber(dialog: Locator, testId: string, expected: number) {
    const input = dialog.getByTestId(testId);
    await expect(input).toBeVisible({ timeout: 5000 });
    expect(Number(await input.inputValue())).toBeCloseTo(expected, 8);
    return input;
  }

  async function selectAdvancedSubtype(dialog: Locator, subtype: string) {
    await dialog.getByTestId("subtype-select").click();
    await page.getByRole("option", { name: subtype, exact: true }).click();
    await expect(dialog.getByTestId("subtype-select")).toContainText(subtype);
  }

  async function verifyActivityInTable(
    type: string,
    symbol: string | null,
    options?: { amount?: number; quantity?: number },
  ) {
    // Look for the activity row with matching type and symbol
    const displayType = ACTIVITY_TYPE_DISPLAY[type] || type;

    // Find a row containing both the type badge and symbol/Cash
    const displaySymbol = symbol || "Cash";
    const row = page
      .locator("tr")
      .filter({ hasText: displayType })
      .filter({ hasText: displaySymbol });
    await expect(row.first()).toBeVisible({ timeout: 10000 });
  }

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("1. Setup: Login and navigate to app", async () => {
    test.setTimeout(180000);

    await completeOnboardingIfNeeded(page);

    // Navigate to dashboard to confirm app is ready
    await gotoAppPath(page, "/dashboard");
    await expect(page.getByTestId("portfolio-balance-value")).toBeVisible({ timeout: 30000 });
  });

  test("2. Create test accounts", async () => {
    for (const account of TEST_DATA.accounts) {
      await createAccount(page, account.name, account.currency);
    }
  });

  test("3. Create DEPOSIT activity", async () => {
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Deposit");

    const deposit = TEST_DATA.activities.deposit;
    await selectAccount(deposit.account, deposit.currency);
    await selectDate();
    await fillAmount(deposit.amount);
    await fillNotes(deposit.notes);

    await submitActivity("Deposit");
    await verifyActivityInTable("DEPOSIT", null, { amount: deposit.amount });
  });

  test("4. Create WITHDRAWAL activity", async () => {
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Withdrawal");

    const withdrawal = TEST_DATA.activities.withdrawal;
    await selectAccount(withdrawal.account, withdrawal.currency);
    await selectDate();
    await fillAmount(withdrawal.amount);
    await fillNotes(withdrawal.notes);

    await submitActivity("Withdrawal");
    await verifyActivityInTable("WITHDRAWAL", null, { amount: withdrawal.amount });
  });

  test("5. Create BUY activity", async () => {
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Buy");

    const buy = TEST_DATA.activities.buy;
    await selectAccount(buy.account, buy.currency);
    await searchAndSelectSymbol(buy.symbol);
    await selectDate();
    await fillQuantity(buy.quantity);
    await fillPrice(buy.price);
    await fillFee(buy.fee);
    await fillNotes(buy.notes);

    await submitActivity("Buy");
    await verifyActivityInTable("BUY", buy.symbol, { quantity: buy.quantity });
  });

  test("6. Create BUY activity with advanced options", async () => {
    test.setTimeout(60000); // Longer timeout for advanced options test
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Buy");

    const buy = TEST_DATA.activities.buyWithAdvanced;
    await selectAccount(buy.account, buy.currency);
    await searchAndSelectSymbol(buy.symbol);
    await selectDate();
    await fillQuantity(buy.quantity);
    await fillPrice(buy.price);
    await fillFee(buy.fee);

    // Expand advanced options and fill
    await expandAdvancedOptions();
    await fillFxRate(buy.advanced.fxRate);

    await fillNotes(buy.notes);

    await submitActivity("Buy");
    await verifyActivityInTable("BUY", buy.symbol, { quantity: buy.quantity });
  });

  test("7. Create SELL activity", async () => {
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Sell");

    const sell = TEST_DATA.activities.sell;
    await selectAccount(sell.account, sell.currency);
    await searchAndSelectSymbol(sell.symbol);
    await selectDate();
    await fillQuantity(sell.quantity);
    await fillPrice(sell.price);
    await fillFee(sell.fee);
    await fillNotes(sell.notes);

    await submitActivity("Sell");
    await verifyActivityInTable("SELL", sell.symbol, { quantity: sell.quantity });
  });

  test("8. Create DIVIDEND activity", async () => {
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Dividend");

    const dividend = TEST_DATA.activities.dividend;
    await selectAccount(dividend.account, dividend.currency);
    await searchAndSelectSymbol(dividend.symbol);
    await selectDate();
    await fillAmount(dividend.amount);
    await fillNotes(dividend.notes);

    await submitActivity("Dividend");
    await verifyActivityInTable("DIVIDEND", dividend.symbol, { amount: dividend.amount });
  });

  test("9. Create DIVIDEND activity with subtype", async () => {
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Dividend");

    const dividend = TEST_DATA.activities.dividendWithSubtype;
    await selectAccount(dividend.account, dividend.currency);
    await searchAndSelectSymbol(dividend.symbol);
    await selectDate();

    // Subtype is now a main form radio group, not an advanced select.
    await selectSubtype(dividend.subtype);
    await page.getByTestId("received-quantity-input").fill(String(dividend.quantity));
    await page.getByTestId("received-quantity-input").blur();
    await page.getByTestId("fmv-per-unit-input").fill(String(dividend.unitPrice));
    await page.getByTestId("fmv-per-unit-input").blur();
    await fillAmount(dividend.amount, "dividend-amount-input");

    await fillNotes(dividend.notes);

    await submitActivity("Dividend");
    await verifyActivityInTable("DIVIDEND", dividend.symbol, { amount: dividend.amount });
    await expect(
      page
        .locator("tr")
        .filter({ hasText: "Dividend in Kind" })
        .filter({ hasText: dividend.symbol })
        .first(),
    ).toBeVisible({ timeout: 10000 });
  });

  test("10. Create TRANSFER activity", async () => {
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Transfer");

    const transfer = TEST_DATA.activities.transfer;

    // Select from account
    await selectAccount("Test USD Account", "USD", "From Account");

    // Select to account
    await selectAccount("Test CAD Account", "CAD", "To Account");

    await selectDate();
    await fillInternalTransferCashAmount(transfer.amount);
    await fillNotes(transfer.notes);

    await submitActivity("Transfer");
    // Transfers create two activities: TRANSFER_OUT and TRANSFER_IN
    await verifyActivityInTable("TRANSFER_OUT", null, { amount: transfer.amount });
  });

  test("10b. Create external TRANSFER OUT (cash)", async () => {
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Transfer");

    const transfer = TEST_DATA.activities.externalCashTransferOut;

    // Check "External transfer" checkbox
    await page.getByLabel("External transfer").click();
    await page.waitForTimeout(200);

    // Select "Out" direction (default is "in")
    await page.locator("#direction-out").click();
    await page.waitForTimeout(200);

    // Select account (label is "From Account" for external out)
    await selectAccount(transfer.account, transfer.currency, "From Account");
    await selectDate();
    await fillAmount(transfer.amount);
    await fillNotes(transfer.notes);

    await submitActivity("Transfer Out");
    await verifyActivityInTable("TRANSFER_OUT", null, { amount: transfer.amount });
  });

  test("10c. Create external TRANSFER IN (cash)", async () => {
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Transfer");

    const transfer = TEST_DATA.activities.externalCashTransferIn;

    // Check "External transfer" checkbox
    await page.getByLabel("External transfer").click();
    await page.waitForTimeout(200);

    // Explicitly select "In" direction
    await page.locator("#direction-in").click();
    await page.waitForTimeout(200);

    // Select account (label is "To Account" for external in)
    await selectAccount(transfer.account, transfer.currency, "To Account");
    await selectDate();
    await fillAmount(transfer.amount);
    await fillNotes(transfer.notes);

    await submitActivity("Transfer In");
    await verifyActivityInTable("TRANSFER_IN", null, { amount: transfer.amount });
  });

  test("10d. Create internal TRANSFER (securities)", async () => {
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Transfer");

    const transfer = TEST_DATA.activities.internalSecuritiesTransfer;

    // Switch to securities mode
    await page.getByRole("button", { name: "Securities" }).click();
    await page.waitForTimeout(200);

    // Select from/to accounts (internal transfer)
    await selectAccount("Test USD Account", "USD", "From Account");
    await selectAccount("Test CAD Account", "CAD", "To Account");

    // Search and select symbol
    await searchAndSelectSymbol(transfer.symbol);
    await selectDate();
    await fillQuantity(transfer.quantity);
    await fillNotes(transfer.notes);

    await submitActivity("Transfer");
    // Internal transfer creates paired activities
    await verifyActivityInTable("TRANSFER_OUT", transfer.symbol, { quantity: transfer.quantity });
  });

  test("10e. Create external TRANSFER IN (securities)", async () => {
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Transfer");

    const transfer = TEST_DATA.activities.externalSecuritiesTransferIn;

    // Switch to securities mode
    await page.getByRole("button", { name: "Securities" }).click();
    await page.waitForTimeout(200);

    // Check "External transfer" checkbox
    await page.getByLabel("External transfer").click();
    await page.waitForTimeout(200);

    // Explicitly select "In" direction
    await page.locator("#direction-in").click();
    await page.waitForTimeout(200);

    // Select account (label is "To Account" for external in)
    await selectAccount(transfer.account, transfer.currency, "To Account");

    // Search and select symbol
    await searchAndSelectSymbol(transfer.symbol);
    await selectDate();
    await fillQuantity(transfer.quantity);

    // Cost basis required for external securities transfer in
    const costBasisInput = page.getByTestId("cost-basis-input");
    await costBasisInput.fill(String(transfer.costBasis));
    await costBasisInput.blur();
    await page.waitForTimeout(200);

    await fillNotes(transfer.notes);

    await submitActivity("Transfer In");
    await verifyActivityInTable("TRANSFER_IN", transfer.symbol, { quantity: transfer.quantity });
  });

  test("10f. Create EXCHANGE activity", async () => {
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Exchange");

    const exchange = TEST_DATA.activities.exchange;

    await selectAccount(exchange.account, exchange.currency);

    await searchAndSelectSymbolIn("Closing Asset", exchange.fromSymbol);
    await fillAmount(exchange.fromQuantity, "from-quantity-input");

    await searchAndSelectSymbolIn("Opening Asset", exchange.toSymbol);
    await fillAmount(exchange.toQuantity, "to-quantity-input");

    await selectDate();
    await fillNotes(exchange.notes);

    await submitActivity("Exchange");
    // Exchange creates a paired ADJUSTMENT activity (EXCHANGE_OUT/EXCHANGE_IN)
    await verifyActivityInTable("ADJUSTMENT", exchange.fromSymbol, {
      quantity: exchange.fromQuantity,
    });
    await verifyActivityInTable("ADJUSTMENT", exchange.toSymbol, { quantity: exchange.toQuantity });
  });

  test("11. Create FEE activity", async () => {
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Fee");

    const fee = TEST_DATA.activities.fee;
    await selectAccount(fee.account, fee.currency);
    await selectDate();
    await fillAmount(fee.amount);
    await fillNotes(fee.notes);

    await submitActivity("Fee");
    await verifyActivityInTable("FEE", null, { amount: fee.amount });
  });

  test("12. Create and edit CREDIT with subtype and populated account", async () => {
    const credit = TEST_DATA.activities.credit;

    await gotoActivities(page);
    await openAddActivitySheet();
    await selectActivityType("Credit");
    await selectAccount(credit.account, credit.currency);
    await selectDate();
    await fillAmount(credit.amount);
    await expandAdvancedOptions();
    const addDialog = page.getByRole("dialog", { name: "Add Activity" });
    await selectAdvancedSubtype(addDialog, "Trading Rebate");
    await fillNotes(credit.notes);
    await submitActivity("Credit");

    await verifyActivityInTable("CREDIT", null, { amount: credit.amount });
    const editDialog = await openActivityEditor("Credit", credit.notes);
    await expect(editDialog.getByTestId("account-select")).toContainText(credit.account);
    const amountInput = await expectInputNumber(editDialog, "amount-input", credit.amount);
    await editDialog.getByTestId("advanced-options-button").click();
    await expect(editDialog.getByTestId("subtype-select")).toContainText("Trading Rebate");
    await expect(editDialog.getByTestId("notes-input")).toHaveValue(credit.notes);

    await amountInput.fill(String(credit.updatedAmount));
    await selectAdvancedSubtype(editDialog, "Fee Refund");
    await editDialog.getByTestId("notes-input").fill(credit.updatedNotes);
    await updateActivity(editDialog);

    const row = page.locator("tbody tr").filter({ hasText: credit.updatedNotes }).first();
    await expect(row).toContainText("Credit", { timeout: 10000 });
    await expect(row).toContainText("Fee Refund");
  });

  test("13. Edit ADJUSTMENT through cash and securities modes", async () => {
    const adjustment = TEST_DATA.activities.cashAdjustment;
    const accountId = await getTestAccountId();
    const seeded = await seedActivity({
      accountId,
      activityType: "ADJUSTMENT",
      subtype: "CASH_SWEEP",
      activityDate: new Date().toISOString(),
      currency: "USD",
      amount: adjustment.amount,
      comment: adjustment.notes,
      needsReview: false,
    });

    const cashDialog = await openActivityEditor("Adjustment", "CASH_SWEEP", "$10.00");
    await expect(cashDialog.getByTestId("account-select")).toContainText("Test USD Account");
    await expect(cashDialog.getByRole("button", { name: "Cash", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expectInputNumber(cashDialog, "amount-input", adjustment.amount);

    await cashDialog.getByRole("button", { name: "Securities", exact: true }).click();
    await searchAndSelectSymbol(adjustment.symbol, "Update Activity");
    await cashDialog.getByTestId("quantity-input").fill(String(adjustment.quantity));
    await cashDialog.getByTestId("unit-price-input").fill(String(adjustment.unitPrice));
    await cashDialog.getByTestId("amount-input").fill(String(adjustment.securitiesAmount));
    await cashDialog.getByTestId("advanced-options-button").click();
    await cashDialog.getByTestId("subtype-select").click();
    await expect(page.getByRole("option", { name: "Option Expiry", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await updateActivity(cashDialog);

    let persisted = await getActivity(seeded.id);
    expect(persisted.assetSymbol).toBe(adjustment.symbol);
    expect(persisted.instrumentType).toBe("EQUITY");
    expect(Number(persisted.quantity)).toBe(adjustment.quantity);
    expect(Number(persisted.unitPrice)).toBe(adjustment.unitPrice);
    expect(Number(persisted.amount)).toBe(adjustment.securitiesAmount);

    const securitiesDialog = await openActivityEditor("Adjustment", adjustment.symbol);
    await expect(
      securitiesDialog.getByRole("button", { name: "Securities", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(securitiesDialog.getByTestId("account-select")).toContainText("Test USD Account");
    await expectInputNumber(securitiesDialog, "quantity-input", adjustment.quantity);
    await expectInputNumber(securitiesDialog, "unit-price-input", adjustment.unitPrice);
    await expectInputNumber(securitiesDialog, "amount-input", adjustment.securitiesAmount);

    await securitiesDialog.getByRole("button", { name: "Cash", exact: true }).click();
    await securitiesDialog.getByTestId("amount-input").fill(String(adjustment.finalCashAmount));
    const cashUpdateRequest = page.waitForRequest(
      (request) =>
        request.method() === "PUT" && new URL(request.url()).pathname === "/api/v1/activities",
    );
    await updateActivity(securitiesDialog);
    const cashUpdatePayload = (await cashUpdateRequest).postDataJSON() as Record<string, unknown>;
    expect(cashUpdatePayload.asset).toEqual({});

    persisted = await getActivity(seeded.id);
    expect(persisted.assetId).toBe("");
    expect(persisted.assetSymbol).toBe("");
    expect(persisted.quantity).toBeNull();
    expect(persisted.unitPrice).toBeNull();
    expect(Number(persisted.amount)).toBe(adjustment.finalCashAmount);
  });

  test("14. Edit option-expiry ADJUSTMENT with option-only subtype", async () => {
    const adjustment = TEST_DATA.activities.optionExpiryAdjustment;
    const accountId = await getTestAccountId();
    const seeded = await seedActivity({
      accountId,
      activityType: "ADJUSTMENT",
      subtype: "OPTION_EXPIRY",
      activityDate: new Date().toISOString(),
      currency: "USD",
      quantity: adjustment.quantity,
      unitPrice: 0,
      amount: 0,
      comment: adjustment.notes,
      needsReview: false,
      asset: {
        symbol: adjustment.symbol,
        name: "AAPL Jan 2027 200 Call",
        kind: "INVESTMENT",
        quoteMode: "MANUAL",
        quoteCcy: "USD",
        instrumentType: "OPTION",
      },
    });

    const dialog = await openActivityEditor("Adjustment", "Option Expiry");
    await expect(dialog.getByTestId("account-select")).toContainText("Test USD Account");
    await expect(dialog.getByRole("button", { name: "Securities", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expectInputNumber(dialog, "quantity-input", adjustment.quantity);
    await expectInputNumber(dialog, "unit-price-input", 0);
    await expectInputNumber(dialog, "amount-input", 0);
    await dialog.getByTestId("advanced-options-button").click();
    await expect(dialog.getByTestId("subtype-select")).toContainText("Option Expiry");

    await dialog.getByTestId("quantity-input").fill(String(adjustment.updatedQuantity));
    await updateActivity(dialog);

    const persisted = await getActivity(seeded.id);
    expect(persisted.subtype).toBe("OPTION_EXPIRY");
    expect(persisted.instrumentType).toBe("OPTION");
    expect(persisted.assetSymbol).toBe(adjustment.symbol);
    expect(Number(persisted.quantity)).toBe(adjustment.updatedQuantity);
    expect(Number(persisted.unitPrice)).toBe(0);
    expect(Number(persisted.amount)).toBe(0);
  });

  test("15. Create INTEREST activity", async () => {
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Interest");

    const interest = TEST_DATA.activities.interest;
    await selectAccount(interest.account, interest.currency);
    await selectDate();
    await fillAmount(interest.amount);
    await fillNotes(interest.notes);

    await submitActivity("Interest");
    await verifyActivityInTable("INTEREST", null, { amount: interest.amount });
  });

  test("16. Create TAX activity", async () => {
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Tax");

    const tax = TEST_DATA.activities.tax;
    await selectAccount(tax.account, tax.currency);
    await selectDate();
    await fillAmount(tax.amount);
    await fillNotes(tax.notes);

    await submitActivity("Tax");
    await verifyActivityInTable("TAX", null, { amount: tax.amount });
  });

  test("17. Create SPLIT activity", async () => {
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Split");

    const split = TEST_DATA.activities.split;
    await selectAccount(split.account, split.currency);
    await searchAndSelectSymbol(split.symbol);
    await selectDate();

    // Fill split ratio
    const splitRatioInput = page.getByLabel("Split Ratio");
    await splitRatioInput.fill(String(split.splitRatio));
    await splitRatioInput.blur();

    await fillNotes(split.notes);

    await submitActivity("Split");
    await verifyActivityInTable("SPLIT", split.symbol);
  });

  test("18. Create BUY activity with custom asset", async () => {
    await gotoActivities(page);

    await openAddActivitySheet();
    await selectActivityType("Buy");

    const customBuy = TEST_DATA.activities.customAssetBuy;
    await selectAccount(customBuy.account, customBuy.currency);

    // Click symbol combobox and search for custom asset
    const symbolCombobox = page.getByRole("combobox").filter({ hasText: /Select symbol/i });
    await symbolCombobox.click();
    await page.waitForTimeout(200);

    const searchInput = page.getByPlaceholder("Search for symbol");
    await searchInput.fill(customBuy.customAsset.symbol);
    await page.waitForTimeout(500);

    // Click "Create custom" option (shows symbol + "Create custom (manual)")
    const createCustomOption = page.getByRole("option", {
      name: new RegExp(`${customBuy.customAsset.symbol}.*Create custom`, "i"),
    });
    await expect(createCustomOption).toBeVisible({ timeout: 5000 });
    await createCustomOption.click();

    // Fill custom asset dialog
    await expect(page.getByRole("heading", { name: "Create Custom Asset" })).toBeVisible();

    // Symbol should be pre-filled
    const symbolInput = page.locator('input[placeholder="e.g., MYCOIN"]');
    await expect(symbolInput).toHaveValue(customBuy.customAsset.symbol);

    // Fill name
    const nameInput = page.locator('input[placeholder="e.g., My Custom Coin"]');
    await nameInput.fill(customBuy.customAsset.name);

    // Select asset type
    const assetTypeSelect = page.getByRole("combobox", { name: "Asset Type" });
    await assetTypeSelect.click();
    await page.getByRole("option", { name: customBuy.customAsset.assetType }).click();

    // Create the asset
    await page.getByRole("button", { name: "Create Asset" }).click();

    // Wait for dialog to close and symbol to be selected
    await expect(page.getByRole("heading", { name: "Create Custom Asset" })).not.toBeVisible({
      timeout: 10000,
    });
    await page.waitForTimeout(500);

    // Continue filling the activity form
    await selectDate();
    await fillQuantity(customBuy.quantity);
    await fillPrice(customBuy.price);
    await fillFee(customBuy.fee);
    await fillNotes(customBuy.notes);

    await submitActivity("Buy");
    await verifyActivityInTable("BUY", customBuy.customAsset.symbol, {
      quantity: customBuy.quantity,
    });
  });

  test("19. Verify all created assets in Securities page", async () => {
    await gotoAppPath(page, "/settings/securities");
    await expect(page.getByRole("heading", { name: "Securities" })).toBeVisible({ timeout: 10000 });

    // Wait for table to load
    await page.waitForTimeout(1000);

    // Verify AAPL exists
    const aaplRow = page.getByRole("row").filter({ hasText: "AAPL" });
    await expect(aaplRow.first()).toBeVisible({ timeout: 10000 });

    // Verify MSFT exists
    const msftRow = page.getByRole("row").filter({ hasText: "MSFT" });
    await expect(msftRow.first()).toBeVisible({ timeout: 10000 });

    // Verify custom asset exists
    const customAssetRow = page
      .getByRole("row")
      .filter({ hasText: TEST_DATA.activities.customAssetBuy.customAsset.symbol });
    await expect(customAssetRow.first()).toBeVisible({ timeout: 10000 });
  });

  test("20. Verify custom asset has manual pricing", async () => {
    const customSymbol = TEST_DATA.activities.customAssetBuy.customAsset.symbol;

    // Navigate to the custom asset's profile page
    await gotoAppPath(page, "/settings/securities");
    await expect(page.getByRole("heading", { name: "Securities" })).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Find and click on the custom asset row to navigate to its profile
    const customAssetRow = page.getByRole("row").filter({ hasText: customSymbol });
    await expect(customAssetRow.first()).toBeVisible({ timeout: 10000 });

    // Click edit button for the custom asset
    const editButton = customAssetRow.first().getByRole("button").first();
    await editButton.click();

    // Wait for edit sheet to open
    await page.waitForTimeout(500);

    // Navigate to Market Data tab to check pricing mode
    const marketDataTab = page.getByRole("tab", { name: /Market Data/i });
    if (await marketDataTab.isVisible()) {
      await marketDataTab.click();
      await page.waitForTimeout(300);

      // Check if Manual pricing is enabled (switch should be checked or indicator visible)
      // Look for manual pricing indicator or toggle
      const manualPricingSwitch = page.locator('[role="switch"]').first();
      if (await manualPricingSwitch.isVisible()) {
        const isManual = await manualPricingSwitch.getAttribute("data-state");
        expect(isManual).toBe("checked");
      }
    }

    // Close the sheet
    const closeButton = page
      .getByRole("button", { name: /close/i })
      .or(page.locator('[aria-label="Close"]'))
      .first();
    if (await closeButton.isVisible()) {
      await closeButton.click();
    } else {
      await page.keyboard.press("Escape");
    }
  });

  test("21. Verify activity count in activities page", async () => {
    await gotoActivities(page);

    // Wait for activities to load
    await page.waitForTimeout(1000);

    // Count activity rows - we created activities:
    // deposit, withdrawal, 2 buys, sell, 2 dividends,
    // internal cash transfer (creates 2), external cash transfer out (1), external cash transfer in (1),
    // internal securities transfer (creates 2), external securities transfer in (1),
    // 1 fee, credit, cash adjustment, option-expiry adjustment, interest, 1 tax, split, custom buy
    // Total: 19 existing activities + 3 new-form activities = 22
    const activityRows = page.locator("tbody tr");
    const rowCount = await activityRows.count();

    // We should have at least 22 activities
    expect(rowCount).toBeGreaterThanOrEqual(22);
  });
});
