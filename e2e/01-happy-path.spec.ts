import { expect, Page, test } from "@playwright/test";
import { gotoActivities } from "./helpers";

test.describe.configure({ mode: "serial" });

test.describe("Onboarding And Main Flow", () => {
  const BASE_URL = "http://localhost:1420";
  const TEST_PASSWORD = "password001";
  let page: Page;

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

  // Helper to fill date in React Aria DateInput by clicking on each segment
  // React Aria DateInput has separate segments with data-type attributes
  async function fillDateField(page: Page, daysAgo: number) {
    const { month, day, year } = getDatePartsAgo(daysAgo);

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

  // Test data - define once, use everywhere
  // Note: London stocks (*.L) are priced in pence, app auto-converts to GBP
  const TEST_DATA = {
    accounts: [
      { name: "CAD Account", currency: "CAD" },
      { name: "USD Account", currency: "USD" },
      { name: "EUR Account", currency: "EUR" },
      { name: "GBP Account", currency: "GBP" },
    ],
    deposits: [
      { account: "CAD Account", amount: 5000, currency: "CAD" },
      { account: "USD Account", amount: 5000, currency: "USD" },
      { account: "EUR Account", amount: 10000, currency: "EUR" },
      { account: "GBP Account", amount: 5000, currency: "GBP" },
    ],
    trades: [
      {
        account: "USD Account",
        currency: "USD",
        symbol: "AAPL",
        shares: 10,
        price: 150,
        priceInPence: false,
      },
      {
        account: "CAD Account",
        currency: "CAD",
        symbol: "SHOP.TO",
        shares: 10,
        price: 80,
        priceInPence: false,
      },
      {
        account: "EUR Account",
        currency: "EUR",
        symbol: "MC.PA",
        shares: 10,
        price: 700,
        priceInPence: false,
      },
      {
        account: "GBP Account",
        currency: "GBP",
        symbol: "AZN.L",
        shares: 17,
        price: 14082,
        priceInPence: true,
      },
    ],
  };

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("1. Complete onboarding with CAD currency and Light theme", async () => {
    // Increase timeout for this test as it includes waiting for backend to start
    test.setTimeout(180000); // 3 minutes

    // Navigate to the app
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

    // The app might show login page first if auth is configured
    // Wait for either login page or onboarding to appear (backend must be ready)
    const loginInput = page.getByPlaceholder("Enter your password");
    const continueButton = page.getByRole("button", { name: "Continue" });

    // Wait for either login or onboarding to appear (up to 2 minutes for backend to start)
    await expect(loginInput.or(continueButton)).toBeVisible({ timeout: 120000 });

    // If login page is shown, enter password and sign in
    if (await loginInput.isVisible()) {
      await loginInput.fill(TEST_PASSWORD);
      await page.getByRole("button", { name: "Sign In" }).click();

      // Wait for redirect to onboarding after successful login
      await expect(page).toHaveURL(new RegExp(`${BASE_URL}/onboarding`), { timeout: 10000 });
    } else {
      // Already on onboarding page
      await expect(page).toHaveURL(new RegExp(`${BASE_URL}/onboarding`), { timeout: 5000 });
    }

    // Step 1: Info screen showing "Two ways to track your portfolio" - just click Continue
    await expect(page.getByRole("button", { name: "Continue" })).toBeVisible({ timeout: 10000 });
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 2: Currency selection
    const cadButton = page.getByTestId("currency-cad-button");
    await expect(cadButton).toBeVisible({ timeout: 5000 });
    await cadButton.click();
    // Verify CAD is selected (has border-primary styling)
    await expect(cadButton).toHaveClass(/border-primary/);

    // Click Continue to proceed to appearance step
    const step2ContinueButton = page.getByRole("button", { name: "Continue" });
    await expect(step2ContinueButton).toBeEnabled();
    await step2ContinueButton.click();

    // Step 3: Appearance - Select Light theme
    const lightThemeButton = page.getByTestId("theme-light-button");
    await expect(lightThemeButton).toBeVisible({ timeout: 5000 });
    await lightThemeButton.click();
    // Verify Light theme is selected
    await expect(lightThemeButton).toHaveClass(/border-primary/);

    // Click Continue to proceed to connect step
    const step3ContinueButton = page.getByRole("button", { name: "Continue" });
    await expect(step3ContinueButton).toBeEnabled();
    await step3ContinueButton.click();

    // Step 4: Connect - Click "Get Started" to complete onboarding
    const getStartedButton = page.getByTestId("onboarding-finish-button");
    await expect(getStartedButton).toBeVisible({ timeout: 15000 });
    await getStartedButton.click();

    await expect(page).toHaveURL(new RegExp(`${BASE_URL}/settings/accounts`), {
      timeout: 10000,
    });

    await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible({ timeout: 10000 });
  });

  test("2. Create accounts (CAD, USD, EUR, GBP)", async () => {
    // Navigate to accounts page
    await page.goto(`${BASE_URL}/settings/accounts`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();

    for (const account of TEST_DATA.accounts) {
      // Find and click the "Add account" button (lowercase "a" in desktop view)
      const addAccountButton = page.getByRole("button", { name: /Add account/i });
      await expect(addAccountButton).toBeVisible();
      await addAccountButton.click();

      // Wait for account form dialog to appear
      await expect(page.getByRole("heading", { name: /Add Account/i })).toBeVisible();

      // Fill in account name
      const nameInput = page.getByLabel("Account Name");
      await expect(nameInput).toBeVisible();
      await nameInput.fill(account.name);

      // Select Currency using the CurrencyInput component
      const currencyTrigger = page.getByLabel("Currency");
      await expect(currencyTrigger).toBeVisible();

      // Check if the currency needs to be changed
      const currentCurrencyText = await currencyTrigger.textContent();
      if (!currentCurrencyText?.includes(account.currency)) {
        await currencyTrigger.click();
        await page.waitForSelector('[role="listbox"], [role="option"]', {
          state: "visible",
          timeout: 5000,
        });

        // Type to search for the currency
        const searchInput = page.getByPlaceholder("Search currency...");
        if (await searchInput.isVisible()) {
          await searchInput.fill(account.currency);
          await page.waitForTimeout(200);
        }

        // Click the matching option
        const option = page.getByRole("option", { name: new RegExp(account.currency) }).first();
        await expect(option).toBeVisible({ timeout: 5000 });
        await option.click();
        await page.waitForTimeout(200);
      }

      // Select Transactions tracking mode
      const transactionsRadio = page.getByRole("radio", { name: /Transactions/i });
      await expect(transactionsRadio).toBeVisible();
      await transactionsRadio.click();

      // Submit the form - button text is "Add Account"
      const submitButton = page.getByRole("button", { name: /Add Account/i }).last();
      await expect(submitButton).toBeVisible();
      await submitButton.click();

      // Wait for dialog to close
      await expect(page.getByRole("heading", { name: /Add Account/i })).not.toBeVisible({
        timeout: 10000,
      });

      // Wait for the list to refresh and show the new account
      // The account appears as a link in the account list
      await page.waitForTimeout(500);
      const accountLink = page.getByRole("link", { name: account.name });
      await expect(accountLink).toBeVisible({ timeout: 10000 });
    }
  });

  test("3. Deposit funds", async () => {
    // Navigate to activities page
    await gotoActivities(page);

    // Create deposits spread over days 30-27 ago (before buys)
    for (let i = 0; i < TEST_DATA.deposits.length; i++) {
      const deposit = TEST_DATA.deposits[i];

      // Wait for any overlay/backdrop to disappear before opening new sheet
      await page
        .locator('[data-state="open"][aria-hidden="true"]')
        .waitFor({ state: "hidden", timeout: 5000 })
        .catch(() => {});

      // Open Add Activities palette and select Add Transaction
      await page.getByRole("button", { name: "Add Activities" }).click();
      await page.getByRole("button", { name: "Add Transaction" }).click();

      // Wait for sheet to appear
      await expect(page.getByRole("heading", { name: "Add Activity" })).toBeVisible();

      // Select Deposit type from the activity type picker
      // The buttons have aria-pressed attribute when selected
      const depositButton = page.getByRole("button", { name: "Deposit", exact: true });
      await expect(depositButton).toBeVisible();
      await depositButton.click();
      await page.waitForTimeout(200);

      // Select Account using the AccountSelect component
      const accountSelect = page.getByTestId("account-select");
      await accountSelect.click();
      await page
        .getByRole("option", { name: new RegExp(`${deposit.account}.*\\(${deposit.currency}\\)`) })
        .first()
        .click();

      // Fill date using direct input (spread deposits over different days)
      await fillDateField(page, 30 - i); // 30, 29, 28, 27 days ago

      // Fill amount
      const amountInput = page.getByTestId("amount-input");
      await amountInput.fill(String(deposit.amount));
      await amountInput.blur();
      await page.waitForTimeout(200);

      // Fill notes/comment (optional)
      const notesInput = page.getByTestId("notes-input");
      if (await notesInput.isVisible()) {
        await notesInput.click();
        await notesInput.type(`Initial deposit ${deposit.currency}`, { delay: 20 });
        await notesInput.blur();
      }
      await page.waitForTimeout(300);

      // Submit the form by clicking the button
      const submitButton = page.getByRole("button", { name: /Add Deposit/i });
      await expect(submitButton).toBeEnabled({ timeout: 5000 });
      await submitButton.click();

      // Wait for the activity to be added - look for sheet close
      await expect(page.getByRole("heading", { name: "Add Activity" })).not.toBeVisible({
        timeout: 20000,
      });

      // Wait a bit for the table to update
      await page.waitForTimeout(500);
    }
  });

  test("4. Record buy securities", async () => {
    // Increase timeout for this test
    test.setTimeout(60000); // 1 minutes

    // Navigate fresh to activities page to ensure no stale overlays
    await gotoActivities(page);

    // Create buys spread over days 20-17 ago (after deposits which were 30-27 days ago)
    for (let i = 0; i < TEST_DATA.trades.length; i++) {
      const trade = TEST_DATA.trades[i];

      // Wait for any overlay/backdrop to disappear before opening new sheet
      await page.waitForTimeout(500);

      // Open Add Activities palette and select Add Transaction
      await page.getByRole("button", { name: "Add Activities" }).click();
      await page.getByRole("button", { name: "Add Transaction" }).click();

      // Wait for sheet to appear
      await expect(page.getByRole("heading", { name: "Add Activity" })).toBeVisible();

      // Select Buy type from the activity type picker
      const buyButton = page.getByRole("button", { name: "Buy", exact: true });
      await expect(buyButton).toBeVisible();
      await buyButton.click();
      await page.waitForTimeout(200);

      // Select Account
      const accountSelect = page.getByTestId("account-select");
      await accountSelect.click();
      await page
        .getByRole("option", { name: new RegExp(`${trade.account}.*\\(${trade.currency}\\)`) })
        .first()
        .click();

      // Fill date using direct input (spread trades over different days, after deposits)
      await fillDateField(page, 20 - i); // 20, 19, 18, 17 days ago

      // Fill Symbol - click the combobox trigger to open search
      const escapedSymbol = trade.symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const exactSymbolPattern = new RegExp(`^${escapedSymbol}$`, "i");
      const symbolCombobox = page.getByRole("combobox").filter({ hasText: /Select symbol/i });
      await symbolCombobox.click();

      // Type the symbol in the search input
      const searchInput = page.getByPlaceholder("Search for symbol");
      await expect(searchInput).toBeVisible({ timeout: 5000 });
      await searchInput.fill(trade.symbol);

      // Wait for and click the matching option from the dropdown
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

      // Fill Quantity and blur to trigger validation
      const quantityInput = page.getByTestId("quantity-input");
      await quantityInput.fill(String(trade.shares));
      await quantityInput.blur();

      // Fill Price and blur
      const priceInput = page.getByTestId("price-input");
      await priceInput.fill(String(trade.price));
      await priceInput.blur();

      // Fill notes/comment (optional)
      const notesInput = page.getByTestId("notes-input");
      if (await notesInput.isVisible()) {
        await notesInput.fill(`Buy ${trade.symbol}`);
        await notesInput.blur();
      }

      // Wait for form to settle and validation to complete
      await page.waitForTimeout(300);

      // Submit the form
      const submitButton = page.getByRole("button", { name: /Add Buy/i });
      await expect(submitButton).toBeEnabled({ timeout: 5000 });
      await submitButton.click();

      // Wait for sheet to close
      await expect(page.getByRole("heading", { name: "Add Activity" })).not.toBeVisible({
        timeout: 20000,
      });

      await page.waitForTimeout(500);
    }
  });

  test("5. Check portfolio value calculation", async () => {
    // Increase timeout for this test as it involves multiple page navigations and sync
    test.setTimeout(180000); // 3 minutes

    // Helper: wait for market sync and portfolio calculation to complete
    // The app shows toast messages during sync - wait for them to disappear
    const waitForSyncComplete = async (maxWaitMs = 60000) => {
      const startTime = Date.now();

      // Poll for sync toasts and wait for them to complete
      while (Date.now() - startTime < maxWaitMs) {
        const syncToast = page.getByText("Syncing market data...");
        const calcToast = page.getByText("Calculating portfolio");
        const syncingToast = page.getByText(/syncing/i);

        const isSyncing =
          (await syncToast.isVisible().catch(() => false)) ||
          (await calcToast.isVisible().catch(() => false)) ||
          (await syncingToast.isVisible().catch(() => false));

        if (isSyncing) {
          // Wait for all sync toasts to disappear
          await Promise.all([
            syncToast.waitFor({ state: "hidden", timeout: 30000 }).catch(() => {}),
            calcToast.waitFor({ state: "hidden", timeout: 30000 }).catch(() => {}),
            syncingToast.waitFor({ state: "hidden", timeout: 30000 }).catch(() => {}),
          ]);
          // Small delay after sync completes
          await page.waitForTimeout(1000);
        } else {
          // No sync toast visible, wait a bit and check again
          await page.waitForTimeout(500);
          break;
        }
      }

      // Final delay to ensure data is fully updated
      await page.waitForTimeout(1000);
    };

    // Navigate to dashboard first to trigger market sync
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });

    // Wait for initial sync to complete (this triggers quote fetching)
    await waitForSyncComplete(90000);

    // First, get exchange rates from settings -> general
    await page.goto(`${BASE_URL}/settings/general`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "General" })).toBeVisible({ timeout: 10000 });

    // Wait for any sync to complete before reading rates
    await waitForSyncComplete();

    // Wait for exchange rates table to load
    await page.waitForTimeout(1000);

    // Extract exchange rates from the table (USD to CAD, EUR to CAD, GBP to CAD)
    const usdRow = page.getByRole("row", { name: /USD.*CAD/i });
    await expect(usdRow).toBeVisible({ timeout: 10000 });
    const usdRateCell = usdRow.getByRole("cell").nth(3);
    const usdRateText = await usdRateCell.textContent();

    const eurRow = page.getByRole("row", { name: /EUR.*CAD/i });
    await expect(eurRow).toBeVisible({ timeout: 10000 });
    const eurRateCell = eurRow.getByRole("cell").nth(3);
    const eurRateText = await eurRateCell.textContent();

    const gbpRow = page.getByRole("row", { name: /GBP.*CAD/i });
    await expect(gbpRow).toBeVisible({ timeout: 10000 });
    const gbpRateCell = gbpRow.getByRole("cell").nth(3);
    const gbpRateText = await gbpRateCell.textContent();

    const usdToCAD = parseFloat(usdRateText?.trim() || "1.4");
    const eurToCAD = parseFloat(eurRateText?.trim() || "1.5");
    const gbpToCAD = parseFloat(gbpRateText?.trim() || "1.8");

    // Navigate to securities settings to get latest prices
    await page.goto(`${BASE_URL}/settings/securities`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Securities" })).toBeVisible({ timeout: 10000 });

    // Wait for any sync to complete before reading prices
    await waitForSyncComplete();

    // Wait for securities table to load
    await page.waitForTimeout(1000);

    // Extract prices for each security
    const prices: Record<string, number> = {};

    for (const trade of TEST_DATA.trades) {
      // Symbols in the table are displayed without exchange suffix (SHOP.TO -> SHOP, MC.PA -> MC)
      const baseSymbol = trade.symbol.split(".")[0];
      // Note: For LSE stocks, the asset currency is "GBp" (pence), not "GBP" (pounds)
      const assetCurrency = trade.symbol.endsWith(".L") ? "GBp" : trade.currency;
      const row = page
        .getByRole("row")
        .filter({ hasText: baseSymbol })
        .filter({ hasText: assetCurrency });
      await expect(row.first()).toBeVisible({ timeout: 15000 });

      // Get the price from the Quote column (td[0]=symbol, td[1]=market, td[2]=quote, td[3]=actions)
      const priceCell = row.first().locator("td").nth(2);
      const priceText = await priceCell.textContent();

      // Extract numeric value (handles formats like "$277.55", "CA$223.77", "€570.00", "£13,520.00")
      const priceMatch = priceText?.match(/[\d,.]+/);
      prices[trade.symbol] = parseFloat(priceMatch?.[0]?.replace(",", "") || "0");
    }

    // Calculate expected portfolio value in CAD
    // Holdings value (current price * shares)
    const aaplValueCAD = prices["AAPL"] * TEST_DATA.trades[0].shares * usdToCAD;
    const shopValueCAD = prices["SHOP.TO"] * TEST_DATA.trades[1].shares; // Already in CAD
    const mcpaValueCAD = prices["MC.PA"] * TEST_DATA.trades[2].shares * eurToCAD;

    // AZN.L: The displayed price is in pence (GBp), e.g., "£13,520.00" = 13520 pence
    // The app normalizes this to GBP (x0.01) when calculating holdings value
    // We must apply the same normalization to match the app's calculation
    const aznPriceInGBP = prices["AZN.L"] / 100; // Convert pence to pounds
    const aznValueCAD = aznPriceInGBP * TEST_DATA.trades[3].shares * gbpToCAD;

    // Cash balances (deposit - trade cost for each currency)
    const cadDeposit = TEST_DATA.deposits.find((d) => d.currency === "CAD")!;
    const usdDeposit = TEST_DATA.deposits.find((d) => d.currency === "USD")!;
    const eurDeposit = TEST_DATA.deposits.find((d) => d.currency === "EUR")!;
    const gbpDeposit = TEST_DATA.deposits.find((d) => d.currency === "GBP")!;

    const cadTrade = TEST_DATA.trades.find((t) => t.currency === "CAD")!;
    const usdTrade = TEST_DATA.trades.find((t) => t.currency === "USD")!;
    const eurTrade = TEST_DATA.trades.find((t) => t.currency === "EUR")!;
    const gbpTrade = TEST_DATA.trades.find((t) => t.currency === "GBP")!;

    const cashCAD = cadDeposit.amount - cadTrade.shares * cadTrade.price;
    const cashUSD = usdDeposit.amount - usdTrade.shares * usdTrade.price;
    const cashEUR = eurDeposit.amount - eurTrade.shares * eurTrade.price;

    // For GBP: The trade was entered in pence (14082), so cost = shares * price_in_pence / 100
    const gbpTradeCostInGBP = gbpTrade.priceInPence
      ? (gbpTrade.shares * gbpTrade.price) / 100
      : gbpTrade.shares * gbpTrade.price;
    const cashGBP = gbpDeposit.amount - gbpTradeCostInGBP;

    const cashUSDinCAD = cashUSD * usdToCAD;
    const cashEURinCAD = cashEUR * eurToCAD;
    const cashGBPinCAD = cashGBP * gbpToCAD;

    const expectedTotalCAD =
      aaplValueCAD +
      shopValueCAD +
      mcpaValueCAD +
      aznValueCAD +
      cashCAD +
      cashUSDinCAD +
      cashEURinCAD +
      cashGBPinCAD;

    // Navigate to dashboard and verify portfolio value
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });

    // Wait for any sync to complete before reading dashboard value
    await waitForSyncComplete(60000);

    const balanceElement = page.getByTestId("portfolio-balance-value");
    await expect(balanceElement).toBeVisible({ timeout: 15000 });

    // Poll for balance to stabilize (it may update as calculations complete)
    let displayedBalance = 0;
    let balanceText = "";
    const minExpectedValue = 10000; // Should be at least this much with our deposits

    // Retry up to 10 times waiting for the value to be reasonable
    for (let attempt = 0; attempt < 10; attempt++) {
      balanceText = (await balanceElement.textContent()) || "";
      displayedBalance = parseFloat(balanceText.replace(/[^0-9.]/g, "") || "0");

      if (displayedBalance >= minExpectedValue) {
        break; // Value looks reasonable, proceed with verification
      }

      // Wait and retry - portfolio may still be calculating
      await page.waitForTimeout(2000);
      await waitForSyncComplete(10000);
    }

    // Verify the portfolio value matches our calculation within 0.1% tolerance
    // This accounts for minor rounding differences in decimal calculations
    const tolerance = 0.001;
    const lowerBound = expectedTotalCAD * (1 - tolerance);
    const upperBound = expectedTotalCAD * (1 + tolerance);

    expect(displayedBalance).toBeGreaterThanOrEqual(lowerBound);
    expect(displayedBalance).toBeLessThanOrEqual(upperBound);

    // Also verify it's in CAD
    expect(balanceText).toMatch(/(?:CA\$|\$|C\$|CAD)/);
  });
});
