import { expect, Page, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test.describe("FX Cash Balance - Cross-currency Buy", () => {
  const BASE_URL = "http://localhost:1420";
  const TEST_PASSWORD = "password001";
  let page: Page;

  // Test scenario: EUR account buys USD-denominated asset
  const ACCOUNT_NAME = "FX Test EUR";
  const ACCOUNT_CURRENCY = "EUR";
  const DEPOSIT_AMOUNT = 10000;

  const BUY = {
    symbol: "PANW",
    quantity: 4,
    price: 145, // USD
    fee: 7.03, // USD
    currency: "USD",
    fxRate: 1.17292, // activity_ccy → account_ccy (USD → EUR)
  };

  // Expected math:
  // Total cost in USD = qty * price + fee = 4 * 145 + 7.03 = 587.03 USD
  // EUR equivalent = 587.03 * 1.17292 = 688.5654...
  // Expected cash = 10000 - 688.5654... = 9311.4345...
  const TOTAL_COST_USD = BUY.quantity * BUY.price + BUY.fee; // 587.03
  const TOTAL_COST_EUR = TOTAL_COST_USD * BUY.fxRate; // 688.57
  const EXPECTED_CASH = DEPOSIT_AMOUNT - TOTAL_COST_EUR; // ~9311.43

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

  async function fillDateField(page: Page, daysAgo: number) {
    const { month, day, year } = getDatePartsAgo(daysAgo);
    const dateField = page.getByTestId("date-picker");

    const monthSegment = dateField.locator('[data-type="month"]');
    await monthSegment.click();
    await page.waitForTimeout(50);
    await page.keyboard.type(month, { delay: 30 });
    await page.waitForTimeout(50);

    const daySegment = dateField.locator('[data-type="day"]');
    await daySegment.click();
    await page.waitForTimeout(50);
    await page.keyboard.type(day, { delay: 30 });
    await page.waitForTimeout(50);

    const yearSegment = dateField.locator('[data-type="year"]');
    await yearSegment.click();
    await page.waitForTimeout(50);
    await page.keyboard.type(year, { delay: 30 });
    await page.waitForTimeout(50);

    const hourSegment = dateField.locator('[data-type="hour"]');
    await hourSegment.click();
    await page.waitForTimeout(50);
    await page.keyboard.type("10", { delay: 30 });
    await page.waitForTimeout(50);

    const minuteSegment = dateField.locator('[data-type="minute"]');
    await minuteSegment.click();
    await page.waitForTimeout(50);
    await page.keyboard.type("00", { delay: 30 });
    await page.waitForTimeout(50);

    const dayPeriodSegment = dateField.locator('[data-type="dayPeriod"]');
    await dayPeriodSegment.click();
    await page.waitForTimeout(50);
    await page.keyboard.type("A", { delay: 30 });
    await page.waitForTimeout(100);

    await page.keyboard.press("Tab");
    await page.waitForTimeout(100);
  }

  async function waitForOverlayClose() {
    await page
      .locator('[data-state="open"][aria-hidden="true"]')
      .waitFor({ state: "hidden", timeout: 5000 })
      .catch(() => {});
  }

  async function openAddActivitySheet() {
    await waitForOverlayClose();
    await page.getByRole("button", { name: "Add Activities" }).click();
    await page.getByRole("button", { name: "Add Transaction" }).click();
    await expect(page.getByRole("heading", { name: "Add Activity" })).toBeVisible();
  }

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("1. Login or onboard", async () => {
    test.setTimeout(180000);
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

    const loginInput = page.getByPlaceholder("Enter your password");
    const continueButton = page.getByRole("button", { name: "Continue" });
    const dashboardHeading = page.getByRole("heading", { name: "Dashboard" });
    const accountsHeading = page.getByRole("heading", { name: "Accounts" });

    await expect(
      loginInput.or(continueButton).or(dashboardHeading).or(accountsHeading),
    ).toBeVisible({ timeout: 120000 });

    if (await loginInput.isVisible()) {
      // Login page
      await loginInput.fill(TEST_PASSWORD);
      await page.getByRole("button", { name: "Sign In" }).click();

      // After login, might land on onboarding or dashboard
      await expect(continueButton.or(dashboardHeading).or(accountsHeading)).toBeVisible({
        timeout: 15000,
      });
    }

    // Handle onboarding if needed (fresh DB)
    if (await continueButton.isVisible().catch(() => false)) {
      // Step 1: Info screen - click Continue
      await continueButton.click();

      // Step 2: Currency - select EUR
      const eurButton = page.getByTestId("currency-eur-button");
      await expect(eurButton).toBeVisible({ timeout: 5000 });
      await eurButton.click();
      await page.getByRole("button", { name: "Continue" }).click();

      // Step 3: Appearance - just continue with default
      await expect(page.getByRole("button", { name: "Continue" })).toBeVisible({ timeout: 5000 });
      await page.getByRole("button", { name: "Continue" }).click();

      // Step 4: Connect - finish
      const finishButton = page.getByTestId("onboarding-finish-button");
      await expect(finishButton).toBeVisible({ timeout: 15000 });
      await finishButton.click();

      await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible({
        timeout: 10000,
      });
    }
  });

  test("2. Create EUR account", async () => {
    await page.goto(`${BASE_URL}/settings/accounts`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();

    // Skip if account already exists
    const existingAccount = page.getByRole("link", { name: ACCOUNT_NAME });
    if (await existingAccount.isVisible().catch(() => false)) {
      return;
    }

    const addAccountButton = page.getByRole("button", { name: /Add account/i });
    await addAccountButton.click();
    await expect(page.getByRole("heading", { name: /Add Account/i })).toBeVisible();

    await page.getByLabel("Account Name").fill(ACCOUNT_NAME);

    // Select EUR currency
    const currencyTrigger = page.getByLabel("Currency");
    const currentCurrencyText = await currencyTrigger.textContent();
    if (!currentCurrencyText?.includes(ACCOUNT_CURRENCY)) {
      await currencyTrigger.click();
      await page.waitForSelector('[role="listbox"], [role="option"]', {
        state: "visible",
        timeout: 5000,
      });
      const searchInput = page.getByPlaceholder("Search currency...");
      if (await searchInput.isVisible()) {
        await searchInput.fill(ACCOUNT_CURRENCY);
        await page.waitForTimeout(200);
      }
      const option = page.getByRole("option", { name: new RegExp(ACCOUNT_CURRENCY) }).first();
      await expect(option).toBeVisible({ timeout: 5000 });
      await option.click();
    }

    // Select Transactions tracking mode
    const transactionsRadio = page.getByRole("radio", { name: /Transactions/i });
    await transactionsRadio.click();

    const submitButton = page.getByRole("button", { name: /Add Account/i }).last();
    await submitButton.click();

    await expect(page.getByRole("heading", { name: /Add Account/i })).not.toBeVisible({
      timeout: 10000,
    });
    await page.waitForTimeout(500);
    await expect(page.getByRole("link", { name: ACCOUNT_NAME })).toBeVisible({ timeout: 10000 });
  });

  test("3. Deposit 10,000 EUR", async () => {
    await page.goto(`${BASE_URL}/activities`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible({ timeout: 10000 });

    await openAddActivitySheet();

    // Select Deposit type
    const depositButton = page.getByRole("button", { name: "Deposit", exact: true });
    await depositButton.click();
    await page.waitForTimeout(200);

    // Select account
    const accountSelect = page.getByTestId("account-select");
    await accountSelect.click();
    await page
      .getByRole("option", { name: new RegExp(`${ACCOUNT_NAME}.*\\(${ACCOUNT_CURRENCY}\\)`) })
      .first()
      .click();

    // Fill date (15 days ago - before the buy)
    await fillDateField(page, 15);

    // Fill amount
    const amountInput = page.getByTestId("amount-input");
    await amountInput.fill(String(DEPOSIT_AMOUNT));
    await amountInput.blur();
    await page.waitForTimeout(200);

    // Submit
    const submitButton = page.getByRole("button", { name: /Add Deposit/i });
    await expect(submitButton).toBeEnabled({ timeout: 5000 });
    await submitButton.click();

    await expect(page.getByRole("heading", { name: "Add Activity" })).not.toBeVisible({
      timeout: 20000,
    });
    await page.waitForTimeout(500);
  });

  test("4. Buy PANW (USD) from EUR account with FX rate", async () => {
    test.setTimeout(60000);
    await page.goto(`${BASE_URL}/activities`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Activity" })).toBeVisible({ timeout: 10000 });

    await openAddActivitySheet();

    // Select Buy type
    const buyButton = page.getByRole("button", { name: "Buy", exact: true });
    await buyButton.click();
    await page.waitForTimeout(200);

    // Select EUR account
    const accountSelect = page.getByTestId("account-select");
    await accountSelect.click();
    await page
      .getByRole("option", { name: new RegExp(`${ACCOUNT_NAME}.*\\(${ACCOUNT_CURRENCY}\\)`) })
      .first()
      .click();

    // Search and select PANW
    const escapedSymbol = BUY.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactSymbolPattern = new RegExp(`^${escapedSymbol}$`, "i");
    const symbolCombobox = page.getByRole("combobox").filter({ hasText: /Select symbol/i });
    await symbolCombobox.click();
    const searchInput = page.getByPlaceholder("Search for symbol");
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await searchInput.fill(BUY.symbol);
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

    // Fill date (5 days ago - after deposit)
    await fillDateField(page, 5);

    // Fill quantity
    const quantityInput = page.getByTestId("quantity-input");
    await quantityInput.fill(String(BUY.quantity));
    await expect(quantityInput).toHaveValue(String(BUY.quantity));

    // Fill price
    const priceInput = page.getByTestId("price-input");
    await priceInput.fill(String(BUY.price));
    await expect(priceInput).toHaveValue(String(BUY.price));

    // Fill fee
    const feeInput = page.getByTestId("fee-input");
    await feeInput.fill(String(BUY.fee));
    await expect(feeInput).toHaveValue(String(BUY.fee));

    // Expand advanced options to set currency and FX rate
    const advancedButton = page.getByTestId("advanced-options-button");
    await expect(advancedButton).toBeVisible({ timeout: 5000 });
    await advancedButton.click();
    await page.waitForTimeout(500);

    // Ensure currency is set to USD (should be auto-set from asset, but verify)
    const fxRateInput = page.getByTestId("fx-rate-input");
    await expect(fxRateInput).toBeVisible({ timeout: 5000 });

    // Fill FX rate
    await fxRateInput.fill(String(BUY.fxRate));
    await expect(fxRateInput).toHaveValue(String(BUY.fxRate));
    await page.waitForTimeout(300);

    // Submit
    const submitButton = page.getByRole("button", { name: /Add Buy/i });
    await expect(submitButton).toBeEnabled({ timeout: 5000 });
    await submitButton.click();

    await expect(page.getByRole("heading", { name: "Add Activity" })).not.toBeVisible({
      timeout: 20000,
    });
    await page.waitForTimeout(500);
  });

  test("5. Verify cash balance on account page", async () => {
    test.setTimeout(120000);

    // Navigate to dashboard first to trigger any sync/recalculation
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);

    // Navigate to accounts list
    await page.goto(`${BASE_URL}/settings/accounts`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible({
      timeout: 10000,
    });

    // Click on the EUR test account to go to its detail page
    const accountLink = page.getByRole("link", { name: ACCOUNT_NAME });
    await expect(accountLink).toBeVisible({ timeout: 10000 });
    await accountLink.click();

    // Wait for account page to load - look for "Cash Balance" card title
    await expect(page.getByText("Cash Balance")).toBeVisible({ timeout: 15000 });

    // Wait for data to settle
    await page.waitForTimeout(2000);

    // Read the cash balance value from the card header
    // DOM structure: parent div > "Cash Balance" text + sibling div with the value
    // Find the parent of "Cash Balance" title text, then get full text content
    const cashBalanceTitle = page.getByText("Cash Balance", { exact: true });
    const cashBalanceSection = cashBalanceTitle.locator("..");
    const balanceText = await cashBalanceSection.textContent();

    // Extract numeric value from the text (e.g., "Cash Balance€8,915.22")
    // Remove "Cash Balance" prefix and any non-numeric characters except decimal point, minus, comma
    const numericPart = balanceText
      ?.replace("Cash Balance", "")
      .replace(/,/g, "")
      .replace(/[^0-9.\-]/g, "");
    const actualCashBalance = parseFloat(numericPart || "0");

    // Log values for debugging
    console.log(`\n--- FX Cash Balance Verification ---`);
    console.log(`Deposit: ${DEPOSIT_AMOUNT} ${ACCOUNT_CURRENCY}`);
    console.log(
      `Buy: ${BUY.quantity} x ${BUY.price} ${BUY.currency} + ${BUY.fee} ${BUY.currency} fee`,
    );
    console.log(`Total cost (${BUY.currency}): ${TOTAL_COST_USD}`);
    console.log(`FX Rate (${BUY.currency}→${ACCOUNT_CURRENCY}): ${BUY.fxRate}`);
    console.log(`Expected cost (${ACCOUNT_CURRENCY}): ${TOTAL_COST_EUR.toFixed(2)}`);
    console.log(`Expected cash balance: ${EXPECTED_CASH.toFixed(2)} ${ACCOUNT_CURRENCY}`);
    console.log(`Actual cash balance: ${actualCashBalance}`);
    console.log(`Raw text: "${balanceText}"`);
    console.log(`-----------------------------------\n`);

    // Verify the cash balance matches expected value within 1% tolerance
    // Using percentage tolerance to account for minor rounding differences
    const tolerance = 0.01; // 1%
    const lowerBound = EXPECTED_CASH * (1 - tolerance);
    const upperBound = EXPECTED_CASH * (1 + tolerance);

    expect(actualCashBalance).toBeGreaterThanOrEqual(lowerBound);
    expect(actualCashBalance).toBeLessThanOrEqual(upperBound);
  });
});
