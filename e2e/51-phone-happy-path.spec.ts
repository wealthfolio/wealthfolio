import {
  api,
  createAccount,
  createActivity,
  deposit,
  getActivity,
  restoreSpendingSettings,
  uniqueName,
  updateSettings,
  useSpendingAccounts,
  type Settings,
} from "./api";
import { expect, test, type Page } from "./fixtures";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";
import {
  activitySheet,
  PHONE,
  savePhoneActivity,
  tapBack,
  tabBar,
  type SavedActivity,
} from "./phone";

// The main flows of each module on a phone, clicked as a user would: the tab
// bar, stacked screens with Back, and sheets. Preconditions come from the API.
test.use(PHONE);

test.beforeEach(async ({ page }) => {
  await completeOnboardingIfNeeded(page);
});

const pathOf = (page: Page) => page.evaluate(() => location.pathname);

// Specs on the same worker may leave another base currency, so values are
// recorded in whichever one it has and read without a currency symbol.
async function baseCurrency(page: Page) {
  return (await api<{ baseCurrency: string }>(page, "GET", "/settings")).baseCurrency;
}

/** Opens Settings from the tab bar's More menu. */
async function openSettings(page: Page) {
  await tabBar(page).getByRole("button", { name: "More options", exact: true }).click();
  await page.getByRole("link", { name: "Settings", exact: true }).click();
  await expect.poll(() => pathOf(page)).toMatch(/^\/settings/);
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
}

/** Taps a row of the Settings list; the screen it opens slides over the list. */
async function openSettingsRow(page: Page, name: string) {
  await page.getByRole("button", { name, exact: true }).locator("visible=true").click();
  await expect(page.getByRole("heading", { name, level: 1 }).locator("visible=true")).toBeVisible();
}

/** Waits until the account's holdings include `assetId`. */
async function waitForHolding(page: Page, accountId: string, assetId: string) {
  await expect
    .poll(
      async () => {
        const { holdings } = await api<{ holdings: { instrument?: { id: string } }[] }>(
          page,
          "POST",
          "/holdings/list/query",
          { filter: { type: "account", accountId }, includeClosed: true },
        );
        return holdings.some((holding) => holding.instrument?.id === assetId);
      },
      { timeout: 60_000 },
    )
    .toBe(true);
}

test("tab bar moves between the main pages and marks the current one", async ({ page }) => {
  await gotoAppPath(page, "/dashboard");
  const nav = tabBar(page);
  // Each tab shows its own page: its path, its own content, and the tab marked current.
  for (const [name, path, content] of [
    ["Insights", "/insights", page.getByRole("button", { name: "Overview", exact: true })],
    ["Holdings", "/holdings", page.getByRole("button", { name: "Investments", exact: true })],
    ["Dashboard", "/dashboard", page.getByRole("heading", { name: "Accounts", level: 2 })],
  ] as const) {
    await nav.getByRole("link", { name, exact: true }).click();
    await expect.poll(() => pathOf(page)).toBe(path);
    await expect(content.locator("visible=true").first()).toBeVisible();
    await expect(nav.getByRole("link", { name, exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  }

  // Search opens the launcher over the page instead of moving to another one.
  await nav.getByRole("link", { name: "Search", exact: true }).click();
  const launcher = page.getByRole("dialog");
  await expect(launcher.getByPlaceholder("Search actions, holdings, or accounts...")).toBeVisible();
  await page.touchscreen.tap(195, 20);
  await expect(launcher).toBeHidden();
  expect(await pathOf(page)).toBe("/dashboard");
});

test("create an account, open it from Settings and from the Dashboard", async ({ page }) => {
  test.setTimeout(90_000);
  const name = uniqueName("Phone account");
  const base = await baseCurrency(page);
  await gotoAppPath(page, "/dashboard");
  await openSettings(page);
  await openSettingsRow(page, "Accounts");

  await page.getByRole("button", { name: "Add account", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Add account", exact: true });
  await sheet.getByRole("textbox", { name: "Account name", exact: true }).fill(name);
  await sheet.getByRole("radio", { name: /^Transactions/ }).click();
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/api/v1/accounts"),
  );
  await sheet.getByRole("button", { name: "Add account", exact: true }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  const account = (await response.json()) as { id: string; currency: string; accountType: string };
  // A new account starts in the base currency.
  expect([account.currency, account.accountType]).toEqual([base, "SECURITIES"]);
  await expect(sheet).toBeHidden();

  // The new account is listed; tapping it opens its screen over the list.
  // The account's screen names it in its header's account switcher.
  const accountHeader = page
    .getByRole("button", { name: "Switch account", exact: true })
    .locator("visible=true");
  const row = page.getByRole("link", { name, exact: true }).locator("visible=true");
  await row.click();
  await expect.poll(() => pathOf(page)).toBe(`/accounts/${account.id}`);
  await expect(accountHeader).toHaveText(name);
  // Shown once the new account's first recalculation finishes.
  await expect(page.getByText("No holdings yet").locator("visible=true")).toBeVisible({
    timeout: 60_000,
  });
  await tapBack(page);
  await expect.poll(() => pathOf(page)).toBe("/settings/accounts");
  await expect(row).toBeVisible();

  // On the Dashboard, its card opens the account's own page.
  await tabBar(page).getByRole("link", { name: "Dashboard", exact: true }).click();
  const card = page.getByRole("link", { name: new RegExp(`^${name}\\b`) });
  await expect(card).toContainText(base);
  await card.click();
  await expect.poll(() => pathOf(page)).toBe(`/accounts/${account.id}`);
  await expect(accountHeader).toHaveText(name);
  await tapBack(page);
  await expect.poll(() => pathOf(page)).toBe("/dashboard");
});

test("a holding opens from the Holdings list, with its quantity and value", async ({ page }) => {
  test.setTimeout(120_000);
  const account = await createAccount(page, { name: uniqueName("Phone holdings") });
  const symbol = uniqueName("PHH").replace(/\W/g, "").toUpperCase();
  const buy = await createActivity(page, {
    accountId: account.id,
    activityType: "BUY",
    activityDate: "2026-01-06T15:00:00.000Z",
    currency: "USD",
    quantity: 12,
    unitPrice: 25,
    asset: { symbol, name: "Phone holding asset" },
  });
  await waitForHolding(page, account.id, buy.assetId ?? "");

  await gotoAppPath(page, "/dashboard");
  await tabBar(page).getByRole("link", { name: "Holdings", exact: true }).click();
  const holding = page.getByText(symbol, { exact: true }).locator("visible=true").first();
  await holding.click();
  await expect.poll(() => pathOf(page)).toBe(`/holdings/${encodeURIComponent(buy.assetId!)}`);
  const detail = page.locator("main");
  await expect(
    detail.getByText("Phone holding asset").locator("visible=true").first(),
  ).toBeVisible();
  // 12 shares bought at $25 and valued at that manual price.
  await expect(detail.getByText("$300.00").locator("visible=true").first()).toBeVisible();
  await tapBack(page);
  await expect.poll(() => pathOf(page)).toBe("/holdings");
  await expect(holding).toBeVisible();
});

test("an activity opens from the list, edits in its sheet and saves", async ({ page }) => {
  test.setTimeout(90_000);
  const account = await createAccount(page, { name: uniqueName("Phone edit") });
  const seeded = await deposit(page, account.id, 500, "USD", "2026-02-03T15:00:00.000Z");

  await gotoAppPath(page, `/activities?account=${account.id}`);
  const list = page.locator("main");
  // The day's total and the row both show the amount.
  await expect(list.getByText("$500.00").locator("visible=true").first()).toBeVisible();
  await list.getByRole("button", { name: "Open", exact: true }).locator("visible=true").click();
  const actions = page.getByRole("dialog", { name: "Actions", exact: true });
  await actions.getByRole("button", { name: "Edit", exact: true }).click();

  const sheet = activitySheet(page, "Update Activity");
  const amount = sheet.getByRole("textbox", { name: "Amount", exact: true });
  await expect(amount).toHaveValue("500");
  await expect(sheet.getByRole("combobox", { name: "Account", exact: true })).toContainText(
    account.name,
  );
  await amount.fill("750.25");
  const saved = (await savePhoneActivity(page, "Update Activity")) as SavedActivity;
  expect(saved.id).toBe(seeded.id);
  expect(Number((await getActivity(page, seeded.id)).amount)).toBe(750.25);
  await expect(list.getByText("$750.25").locator("visible=true").first()).toBeVisible();
  await expect(list.getByText("$500.00")).toHaveCount(0);
});

test("dashboard and Insights show an account's value", async ({ page }) => {
  test.setTimeout(90_000);
  const base = await baseCurrency(page);
  const account = await createAccount(page, { name: uniqueName("Phone insights"), currency: base });
  await deposit(page, account.id, 1234.5, base, "2026-01-05T15:00:00.000Z");
  // The deposit is valued by a recalculation that runs after it is saved.
  await expect
    .poll(
      async () =>
        (
          await api<{ summary: { totalValueBase: number } }>(
            page,
            "POST",
            "/valuations/current/query",
            { filter: { type: "account", accountId: account.id } },
          )
        ).summary.totalValueBase,
      { timeout: 60_000 },
    )
    .toBe(1234.5);

  await gotoAppPath(page, "/dashboard");
  await expect(page.getByRole("link", { name: new RegExp(`^${account.name}\\b`) })).toContainText(
    "1,234.50",
  );

  await tabBar(page).getByRole("link", { name: "Insights", exact: true }).click();
  await expect.poll(() => pathOf(page)).toBe("/insights");
  await page.getByRole("combobox", { name: /^Select account scope/ }).click();
  const scope = page.getByRole("dialog", { name: "Select account scope", exact: true });
  await scope.getByRole("option", { name: new RegExp(`^${account.name}\\b`) }).click();
  // Accounts toggle, so several can be picked; a tap outside the sheet closes it.
  await expect(
    scope.getByRole("option", { name: new RegExp(`^${account.name}\\b`) }),
  ).toHaveAttribute("aria-selected", "true");
  await page.touchscreen.tap(195, 20);
  await expect(scope).toBeHidden();
  await expect(page.getByRole("combobox", { name: /^Select account scope/ })).toContainText(
    account.name,
  );
  await expect(page.locator("main").getByText("Portfolio value")).toBeVisible();
  await expect(page.locator("main")).toContainText(/Portfolio value\D{0,4}1,234\.50/);
});

test("create a savings goal and land on its page", async ({ page }) => {
  test.setTimeout(90_000);
  const title = uniqueName("Phone goal");
  await gotoAppPath(page, "/goals");
  await page.getByRole("link", { name: "New Goal" }).click();
  await expect.poll(() => pathOf(page)).toBe("/goals/new");
  await page.getByText("Savings Goal", { exact: true }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill(title);
  await page.getByRole("textbox", { name: "Target amount", exact: true }).fill("5000");
  await page.getByRole("button", { name: "Create Goal", exact: true }).click();

  await expect.poll(() => pathOf(page)).toMatch(/^\/goals\/[^/]+$/);
  await expect(
    page.getByRole("heading", { name: title, exact: true, level: 1 }).locator("visible=true"),
  ).toBeVisible();
  const goals = await api<{ id: string; title: string; targetAmount: number }[]>(
    page,
    "GET",
    "/goals",
  );
  const goal = goals.find((candidate) => candidate.title === title);
  expect(goal?.targetAmount).toBe(5000);
  expect(await pathOf(page)).toBe(`/goals/${goal!.id}`);
});

test("Spending dashboard records an expense added from its menu", async ({ page }) => {
  test.setTimeout(90_000);
  const account = await createAccount(page, {
    name: uniqueName("Phone spending"),
    accountType: "CASH",
    currency: await baseCurrency(page),
  });
  const previous = await useSpendingAccounts(page, [account.id]);
  try {
    await gotoAppPath(page, "/dashboard?tab=spending");
    const spending = page.getByRole("button", { name: "Spending", exact: true });
    await expect(spending.filter({ visible: true })).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: "More options", exact: true }).first().click();
    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Add expense", exact: true });
    // The only spending account is filled in.
    await expect(sheet.getByRole("combobox", { name: "Account", exact: true })).toContainText(
      account.name,
    );
    await sheet.getByRole("textbox", { name: "Amount", exact: true }).fill("42.5");
    await sheet.getByRole("button", { name: "Add expense", exact: true }).click();
    await expect(sheet).toHaveCount(0);

    await expect
      .poll(async () => {
        const { data } = await api<{ data: { activityType: string; amount: string }[] }>(
          page,
          "POST",
          "/activities/search",
          { page: 0, pageSize: 10, accountIdFilter: [account.id] },
        );
        return data.map((activity) => [activity.activityType, Number(activity.amount)]);
      })
      .toEqual([["WITHDRAWAL", 42.5]]);
    // Spending is pointed at this account alone, so the month's total is its expense.
    await expect(page.getByRole("heading", { level: 1 }).locator("visible=true")).toContainText(
      "42.50",
    );
  } finally {
    await restoreSpendingSettings(page, previous);
  }
});

test("language, theme and text size change from Settings", async ({ page }) => {
  test.setTimeout(90_000);
  let previous: Settings | undefined;
  try {
    previous = await updateSettings(page, { language: "en", theme: "light", textSize: "default" });
    // A new installation has no saved text size, and putting back "unset" would
    // leave Large in place for the specs after this one.
    previous.textSize ??= "default";
    await gotoAppPath(page, "/dashboard");
    await openSettings(page);

    await openSettingsRow(page, "Appearance");
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await expect(page.locator("html")).toHaveClass(/\bdark\b/);
    const rootSize = () =>
      page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    const before = await rootSize();
    await page.getByRole("button", { name: "Large", exact: true }).click();
    await expect.poll(rootSize).toBeGreaterThan(before);
    await tapBack(page);

    await openSettingsRow(page, "General");
    await page.getByRole("combobox", { name: "Language", exact: true }).click();
    await page.getByRole("option", { name: "Français", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "fr");
    await expect(page.getByRole("combobox", { name: "Langue", exact: true })).toContainText(
      "Français",
    );

    const saved = await api<Settings>(page, "GET", "/settings");
    expect([saved.language, saved.theme, saved.textSize]).toEqual(["fr", "dark", "large"]);
  } finally {
    if (previous) await updateSettings(page, previous);
  }
});
