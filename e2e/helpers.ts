import { expect, Page } from "@playwright/test";

export const BASE_URL = "http://localhost:1420";
export const TEST_PASSWORD = "password001";

export function getDatePartsAgo(daysAgo: number): { month: string; day: string; year: string } {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  return {
    month: String(date.getMonth() + 1).padStart(2, "0"),
    day: String(date.getDate()).padStart(2, "0"),
    year: String(date.getFullYear()),
  };
}

export async function fillDateField(page: Page, daysAgo: number) {
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

export async function waitForOverlayClose(page: Page) {
  await page
    .locator('[data-state="open"][aria-hidden="true"]')
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => {});
}

export async function gotoActivities(page: Page) {
  await page.goto(`${BASE_URL}/activities`, { waitUntil: "domcontentloaded" });
  // The Spending module is enabled by default, so the Activities page renders the
  // Investments/Spending SwipablePage (no "Activity" heading). The "Add Activities"
  // button is present in both layouts, making it a stable load anchor.
  await expect(page.getByRole("button", { name: "Add Activities" })).toBeVisible({
    timeout: 10000,
  });
}

export async function openAddActivitySheet(page: Page) {
  await waitForOverlayClose(page);
  await page.getByRole("button", { name: "Add Activities" }).click();
  await page.getByRole("button", { name: "Add Transaction" }).click();
  await expect(page.getByRole("heading", { name: "Add Activity" })).toBeVisible();
}

export async function selectActivityType(page: Page, type: string) {
  const typeButton = page.getByRole("button", { name: type, exact: true });
  await expect(typeButton).toBeVisible();
  await typeButton.click();
  await page.waitForTimeout(200);
}

export async function searchAndSelectSymbol(page: Page, symbol: string) {
  const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const exactSymbolPattern = new RegExp(`^${escapedSymbol}$`, "i");
  const symbolCombobox = page.getByRole("combobox").filter({ hasText: /Select symbol/i });
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

export async function expandAdvancedOptions(page: Page) {
  const advancedButton = page.getByTestId("advanced-options-button");
  await expect(advancedButton).toBeVisible({ timeout: 5000 });
  await advancedButton.click();
  await page.waitForTimeout(500);
  const fxRateInput = page.getByTestId("fx-rate-input");
  await expect(fxRateInput).toBeVisible({ timeout: 5000 });
}

export async function createAccount(
  page: Page,
  name: string,
  currency: string,
  trackingMode: "Transactions" | "Holdings" = "Transactions",
) {
  await page.goto(`${BASE_URL}/settings/accounts`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Accounts", exact: true })).toBeVisible();

  // Skip if already exists
  const existingAccount = page.getByRole("link", { name });
  if (await existingAccount.isVisible().catch(() => false)) {
    return;
  }

  const addAccountButton = page.getByRole("button", { name: /Add account/i });
  await expect(addAccountButton).toBeVisible();
  await addAccountButton.click();
  await expect(page.getByRole("heading", { name: /Add Account/i })).toBeVisible();

  await page.getByLabel("Account Name").fill(name);

  const currencyTrigger = page.getByLabel("Currency");
  const currentCurrencyText = await currencyTrigger.textContent();
  if (!currentCurrencyText?.includes(currency)) {
    await currencyTrigger.click();
    await page.waitForSelector('[role="listbox"], [role="option"]', {
      state: "visible",
      timeout: 5000,
    });
    const searchInput = page.getByPlaceholder("Search currency...");
    if (await searchInput.isVisible()) {
      await searchInput.fill(currency);
      await page.waitForTimeout(200);
    }
    const option = page.getByRole("option", { name: new RegExp(currency) }).first();
    await expect(option).toBeVisible({ timeout: 5000 });
    await option.click();
    await page.waitForTimeout(200);
  }

  const trackingRadio = page.getByRole("radio", { name: new RegExp(trackingMode, "i") });
  await expect(trackingRadio).toBeVisible();
  await trackingRadio.click();

  const submitButton = page.getByRole("button", { name: /Add Account/i }).last();
  await submitButton.click();
  await expect(page.getByRole("heading", { name: /Add Account/i })).not.toBeVisible({
    timeout: 10000,
  });
  await page.waitForTimeout(500);
  await expect(page.getByRole("link", { name })).toBeVisible({ timeout: 10000 });
}

export async function waitForSyncToast(page: Page, maxWaitMs = 60000) {
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const syncToast = page.getByText("Syncing market data...");
    const calcToast = page.getByText("Calculating portfolio");
    const syncingToast = page.getByText(/syncing/i);

    const isSyncing =
      (await syncToast.isVisible().catch(() => false)) ||
      (await calcToast.isVisible().catch(() => false)) ||
      (await syncingToast.isVisible().catch(() => false));

    if (isSyncing) {
      await Promise.all([
        syncToast.waitFor({ state: "hidden", timeout: 30000 }).catch(() => {}),
        calcToast.waitFor({ state: "hidden", timeout: 30000 }).catch(() => {}),
        syncingToast.waitFor({ state: "hidden", timeout: 30000 }).catch(() => {}),
      ]);
      await page.waitForTimeout(1000);
    } else {
      await page.waitForTimeout(500);
      break;
    }
  }
  await page.waitForTimeout(1000);
}

export async function completeOnboardingIfNeeded(page: Page) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  const continueButton = page.getByRole("button", { name: "Continue" });
  const loginInput = page.getByPlaceholder("Enter your password");
  const dashboardHeading = page.getByRole("heading", { name: "Dashboard" });
  const accountsHeading = page.getByRole("heading", { name: "Accounts" });

  // Wait for the app to settle into any known state before deciding what to do.
  // A short isVisible check is not enough — the frontend may take several seconds
  // to load and determine whether onboarding is needed.
  await expect(continueButton.or(loginInput).or(dashboardHeading).or(accountsHeading)).toBeVisible({
    timeout: 120000,
  });

  if (!(await continueButton.isVisible())) return;

  // Step 1: Info screen — click Continue
  await continueButton.click();

  // Step 2: Currency selection — pick CAD and continue
  await expect(page.getByTestId("currency-cad-button")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("currency-cad-button").click();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3: Appearance — pick Light theme and continue
  await expect(page.getByTestId("theme-light-button")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("theme-light-button").click();
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 4: Finish onboarding
  await expect(page.getByTestId("onboarding-finish-button")).toBeVisible({ timeout: 15000 });
  await page.getByTestId("onboarding-finish-button").click();

  await page.waitForURL(new RegExp(`${BASE_URL}/settings/accounts`), { timeout: 15000 });
}

export async function loginIfNeeded(page: Page) {
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  const loginInput = page.getByPlaceholder("Enter your password");
  const dashboardHeading = page.getByRole("heading", { name: "Dashboard" });
  const accountsHeading = page.getByRole("heading", { name: "Accounts" });

  await expect(loginInput.or(dashboardHeading).or(accountsHeading)).toBeVisible({
    timeout: 120000,
  });

  if (await loginInput.isVisible()) {
    await loginInput.fill(TEST_PASSWORD);
    await page.getByRole("button", { name: "Sign In" }).click();
    await expect(dashboardHeading.or(accountsHeading)).toBeVisible({ timeout: 15000 });
  }
}
