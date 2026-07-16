import { expect, Page, test } from "@playwright/test";
import {
  completeOnboardingIfNeeded,
  createAccount,
  gotoActivities,
  gotoAppPath,
  openAddActivitySheet,
  selectAccountOption,
  selectActivityType,
} from "./helpers";

test.describe.configure({ mode: "serial" });

test.describe("Onboarding And Main Flow", () => {
  const BASE_URL = process.env.WF_E2E_BASE_URL || "http://localhost:1420";
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

    await completeOnboardingIfNeeded(page);
    await gotoAppPath(page, "/settings/accounts");
    await expect(
      page.getByTestId("settings-accounts-page").filter({ visible: true }).first(),
    ).toBeVisible({ timeout: 10000 });
  });

  test("2. Create accounts (CAD, USD, EUR, GBP)", async () => {
    for (const account of TEST_DATA.accounts) {
      await createAccount(page, account.name, account.currency);
    }
  });

  test("3. Deposit funds", async () => {
    // Navigate to activities page
    await gotoActivities(page);

    // Create deposits spread over days 30-27 ago (before buys)
    for (let i = 0; i < TEST_DATA.deposits.length; i++) {
      const deposit = TEST_DATA.deposits[i];

      await openAddActivitySheet(page);
      await selectActivityType(page, "Deposit");

      // Select Account using the AccountSelect component
      await selectAccountOption(page, deposit.account, deposit.currency);

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
      await expect(page.getByTestId("activity-form-dialog")).not.toBeVisible({
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

      await openAddActivitySheet(page);
      await selectActivityType(page, "Buy");

      // Select Account
      await selectAccountOption(page, trade.account, trade.currency);

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
      await expect(page.getByTestId("activity-form-dialog")).not.toBeVisible({
        timeout: 20000,
      });

      await page.waitForTimeout(500);
    }
  });

  test("5. Check portfolio value calculation", async () => {
    // Increase timeout for this test as it involves multiple page navigations and sync
    test.setTimeout(180000); // 3 minutes

    const parseMoney = (text: string | null) => {
      const match = text?.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : NaN;
    };

    const getCurrentPortfolioValue = async () => {
      const response = await page.request.post(`${BASE_URL}/api/v1/valuations/current/query`, {
        data: { filter: { type: "all" }, includeAccounts: false },
      });

      if (!response.ok()) return NaN;

      const valuation = (await response.json()) as {
        summary?: { totalValueBase?: number | string };
      };
      const totalValueBase = Number(valuation.summary?.totalValueBase);

      return Number.isFinite(totalValueBase) ? Number(totalValueBase.toFixed(2)) : NaN;
    };

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
    await gotoAppPath(page, "/dashboard");

    // Wait for initial sync to complete (this triggers quote fetching)
    await waitForSyncComplete(90000);

    const balanceElement = page.getByTestId("portfolio-balance-value");
    await expect(balanceElement).toBeVisible({ timeout: 15000 });

    const minExpectedValue = 10000; // Should be at least this much with our deposits

    await expect
      .poll(getCurrentPortfolioValue, { timeout: 60000, intervals: [1000, 2000, 5000] })
      .toBeGreaterThan(minExpectedValue);

    await expect
      .poll(
        async () => {
          const [expectedValue, balanceText] = await Promise.all([
            getCurrentPortfolioValue(),
            balanceElement.textContent(),
          ]);
          return Math.abs(parseMoney(balanceText) - expectedValue);
        },
        { timeout: 60000, intervals: [1000, 2000, 5000] },
      )
      .toBeLessThanOrEqual(0.01);

    // Also verify it's in CAD
    const balanceText = await balanceElement.textContent();
    expect(balanceText).toMatch(/(?:CA\$|\$|C\$|CAD)/);
  });
});
