import { expect, type Locator, type Page } from "@playwright/test";

export const BASE_URL = process.env.WF_E2E_BASE_URL || "http://localhost:1420";
export const TEST_PASSWORD = "password001";

const ACTIVITY_TYPE_TEST_IDS: Record<string, string> = {
  Buy: "activity-type-buy",
  Sell: "activity-type-sell",
  Deposit: "activity-type-deposit",
  Withdrawal: "activity-type-withdrawal",
  Dividend: "activity-type-dividend",
  Transfer: "activity-type-transfer",
  Split: "activity-type-split",
  Fee: "activity-type-fee",
  Interest: "activity-type-interest",
  Tax: "activity-type-tax",
};

interface E2ESettings {
  language?: string;
  onboardingCompleted?: boolean;
}

interface AuthStatus {
  requiresPassword: boolean;
  oidcEnabled: boolean;
}

function apiV1Urls() {
  const urls: string[] = [];
  const backendUrl = process.env.WF_E2E_BACKEND_URL;
  if (backendUrl) {
    urls.push(`${backendUrl.replace(/\/$/, "")}/api/v1`);
  }
  urls.push(`${BASE_URL.replace(/\/$/, "")}/api/v1`);
  return [...new Set(urls)];
}

async function getApiJson<T>(page: Page, path: string): Promise<T | null> {
  for (const apiBaseUrl of apiV1Urls()) {
    const response = await page.request.get(`${apiBaseUrl}${path}`).catch(() => null);
    if (response?.ok()) return response.json() as Promise<T>;
  }

  return null;
}

async function putApiJson<T>(
  page: Page,
  path: string,
  data: Record<string, unknown>,
): Promise<T | null> {
  for (const apiBaseUrl of apiV1Urls()) {
    const response = await page.request.put(`${apiBaseUrl}${path}`, { data }).catch(() => null);
    if (response?.ok()) return response.json() as Promise<T>;
  }

  return null;
}

async function isAuthDisabled(page: Page) {
  const status = await getApiJson<AuthStatus>(page, "/auth/status");
  return status ? !status.requiresPassword && !status.oidcEnabled : false;
}

async function getE2ESettings(page: Page) {
  return getApiJson<E2ESettings>(page, "/settings");
}

async function canSkipLoginAndOnboardingUi(page: Page) {
  const [authDisabled, settings] = await Promise.all([isAuthDisabled(page), getE2ESettings(page)]);
  if (!authDisabled || !settings?.onboardingCompleted) return false;

  await ensureE2ELanguage(page, settings);
  return true;
}

async function ensureE2ELanguage(page: Page, settings?: E2ESettings | null) {
  if (settings?.language === "en") return;

  const updated = await putApiJson<E2ESettings>(page, "/settings", { language: "en" });
  if (updated) return;

  const refreshedSettings = settings ?? (await getE2ESettings(page));
  if (refreshedSettings?.language === "en") {
    return;
  }

  await gotoAppPath(page, "/settings/general");
  const languageSelect = page.getByTestId("language-select");
  await expect(languageSelect).toBeVisible({ timeout: 10000 });

  const currentLanguage = await languageSelect.textContent();
  if (!currentLanguage?.includes("English")) {
    await languageSelect.click();
    await page.getByTestId("language-option-en").click();
  }

  await expect(page.locator("html")).toHaveAttribute("lang", "en", { timeout: 10000 });
}

function appReadyLocator(page: Page) {
  return page.locator("main").first();
}

function isOnboardingUrl(page: Page) {
  return new URL(page.url()).pathname.startsWith("/onboarding");
}

function settingsAccountsPage(page: Page) {
  return page.getByTestId("settings-accounts-page").filter({ visible: true }).first();
}

async function waitForLoginOnboardingOrApp(page: Page, timeout: number) {
  await expect
    .poll(
      async () => {
        if (
          await page
            .getByTestId("login-password-input")
            .isVisible()
            .catch(() => false)
        ) {
          return "login";
        }
        if (
          await page
            .getByTestId("onboarding-continue-button")
            .isVisible()
            .catch(() => false)
        ) {
          return "onboarding";
        }
        if (
          await appReadyLocator(page)
            .isVisible()
            .catch(() => false)
        ) {
          return "app";
        }
        return "loading";
      },
      { timeout },
    )
    .not.toBe("loading");
}

export async function gotoAppPath(page: Page, path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const targetUrl = `${BASE_URL}${normalizedPath}`;
  const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded" }).catch(() => null);

  if (response?.ok()) return;

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.evaluate((nextPath) => {
    window.history.pushState({}, "", nextPath);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, normalizedPath);
}

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
  await gotoAppPath(page, "/activities?tab=investments");
  // The Spending module is enabled by default, so the Activities page renders the
  // Investments/Spending SwipablePage (no "Activity" heading). The "Add Activities"
  // button is present in both layouts, making it a stable load anchor.
  await expect(page.getByTestId("add-activities-button")).toBeVisible({ timeout: 10000 });
}

export async function openAddActivitySheet(page: Page) {
  await waitForOverlayClose(page);
  await page.getByTestId("add-activities-button").click();
  await page.getByTestId("add-transaction-action").click();
  await expect(page.getByTestId("activity-form-dialog")).toBeVisible();
}

export async function selectActivityType(page: Page, type: string) {
  const testId = ACTIVITY_TYPE_TEST_IDS[type];
  const typeButton = testId
    ? page.getByTestId(testId)
    : page.getByRole("button", { name: type, exact: true });
  await expect(typeButton).toBeVisible();
  await typeButton.click();
  await page.waitForTimeout(200);
}

export async function selectFirstAccount(page: Page) {
  await page.getByTestId("account-select").click();
  await expect(page.getByTestId("account-option").first()).toBeAttached({ timeout: 5000 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(200);
}

function cssAttributeValue(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function selectAccountOption(
  page: Page,
  accountName: string,
  currency: string,
  accountSelect: Locator = page.getByTestId("account-select"),
) {
  await accountSelect.click();
  const option = page
    .locator(
      `[data-testid="account-option"][data-account-name="${cssAttributeValue(
        accountName,
      )}"][data-account-currency="${cssAttributeValue(currency)}"]`,
    )
    .first();
  await expect(option).toBeAttached({ timeout: 5000 });

  await option.click({ timeout: 3000 }).catch(async () => {
    await page.keyboard.type(accountName);
    await page.keyboard.press("Enter");
  });

  await expect(accountSelect).toContainText(accountName, { timeout: 5000 });
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
  await gotoAppPath(page, "/settings/accounts");
  const accountsPage = settingsAccountsPage(page);
  await expect(accountsPage).toBeVisible();

  // Skip if already exists
  const existingAccount = accountsPage.getByRole("link", { name, exact: true }).first();
  if (await existingAccount.isVisible().catch(() => false)) {
    return;
  }

  const addAccountButton = accountsPage.getByTestId("add-account-header-button");
  await expect(addAccountButton).toBeVisible();
  await addAccountButton.click();
  const accountModal = page.getByTestId("account-modal").filter({ visible: true }).first();
  await expect(accountModal).toBeVisible();

  await accountModal.getByTestId("account-name-input").fill(name);

  const currencyTrigger = accountModal.getByTestId("account-currency-select");
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

  const trackingOption =
    trackingMode === "Transactions"
      ? accountModal.getByTestId("tracking-mode-transactions")
      : accountModal.getByTestId("tracking-mode-holdings");
  await expect(trackingOption).toBeVisible();
  await trackingOption.click();

  const submitButton = accountModal.getByTestId("account-submit-button");
  await submitButton.click();
  await expect(accountModal).not.toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(500);
  await expect(
    settingsAccountsPage(page).getByRole("link", { name, exact: true }).first(),
  ).toBeVisible({
    timeout: 10000,
  });
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
  if (await canSkipLoginAndOnboardingUi(page)) return;

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  const continueButton = page.getByTestId("onboarding-continue-button");
  const loginInput = page.getByTestId("login-password-input");

  // Wait for the app to settle into any known state before deciding what to do.
  // A short isVisible check is not enough — the frontend may take several seconds
  // to load and determine whether onboarding is needed.
  await waitForLoginOnboardingOrApp(page, 120000);

  if (await loginInput.isVisible()) {
    await loginInput.fill(TEST_PASSWORD);
    await page.getByTestId("login-submit-button").click();
    await waitForLoginOnboardingOrApp(page, 15000);
  }

  if (!isOnboardingUrl(page) && !(await continueButton.isVisible().catch(() => false))) {
    await ensureE2ELanguage(page);
    return;
  }

  // Step 1: Info screen — click Continue
  await expect(continueButton).toBeVisible({ timeout: 10000 });
  await continueButton.click();

  // Step 2: Preferences — keep e2e assertions deterministic and pick CAD.
  await expect(page.getByTestId("language-en-button")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("language-en-button").click();
  await expect(page.getByTestId("currency-cad-button")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("currency-cad-button").click();
  await page.getByTestId("onboarding-continue-button").click();

  // Step 3: Appearance — pick Light theme and continue
  await expect(page.getByTestId("theme-light-button")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("theme-light-button").click();
  await page.getByTestId("onboarding-continue-button").click();

  // Step 4: Finish onboarding
  await expect(page.getByTestId("onboarding-finish-button")).toBeVisible({ timeout: 15000 });
  await page.getByTestId("onboarding-finish-button").click();

  await page.waitForURL(new RegExp(`${BASE_URL}/settings/accounts`), { timeout: 15000 });
  await expect(settingsAccountsPage(page)).toBeVisible({ timeout: 10000 });
  await ensureE2ELanguage(page);
}

export async function loginIfNeeded(page: Page) {
  if (await canSkipLoginAndOnboardingUi(page)) return;

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  const loginInput = page.getByTestId("login-password-input");
  const continueButton = page.getByTestId("onboarding-continue-button");

  await waitForLoginOnboardingOrApp(page, 120000);

  if (await loginInput.isVisible()) {
    await loginInput.fill(TEST_PASSWORD);
    await page.getByTestId("login-submit-button").click();
    await waitForLoginOnboardingOrApp(page, 15000);
  }

  if (isOnboardingUrl(page) || (await continueButton.isVisible().catch(() => false))) {
    await completeOnboardingIfNeeded(page);
    return;
  }

  await ensureE2ELanguage(page);
}
