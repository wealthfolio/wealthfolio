import { expect, test } from "@playwright/test";
import {
  restoreSpendingSettings,
  seedSpendingAccounts,
  translator,
  updateSettings,
  type Settings,
  type SpendingSettings,
} from "./api";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test.use({
  viewport: { width: 390, height: 844 },
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  hasTouch: true,
});

let previousSpending: SpendingSettings | undefined;
let previousSettings: Settings | undefined;

test.beforeEach(async ({ page }) => {
  await completeOnboardingIfNeeded(page);
  previousSpending = (await seedSpendingAccounts(page, "Grid")).previous;
  await gotoAppPath(page, "/");
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
});

// Later specs expect the language and text size this worker started with.
test.afterEach(async ({ page }) => {
  if (previousSettings) await updateSettings(page, previousSettings);
  if (previousSpending) await restoreSpendingSettings(page, previousSpending);
  previousSettings = undefined;
  previousSpending = undefined;
});

for (const scenario of [
  { width: 390, language: "en", direction: "ltr" },
  { width: 320, language: "ar", direction: "rtl" },
] as const) {
  test(`Add group and holdings entry are usable at ${scenario.width}px ${scenario.language}`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: scenario.width, height: 844 });
    previousSettings = await updateSettings(page, {
      language: scenario.language,
      textSize: scenario.language === "ar" ? "extra-large" : "default",
    });
    await gotoAppPath(page, `/?dir=${scenario.direction}`);
    const t = translator(scenario.language);
    const keys = {
      add: "common:add",
      transaction: "common:component.add_transaction",
      expense: "spending:cashForm.addExpense",
      income: "spending:cashForm.addIncome",
      holdings: "common:component.add_holding",
      search: "common:search",
      appearance: "common:component.launcher_appearance",
      bulkTitle: "activity:form.bulk_add_existing_title",
      symbolTitle: "common:component.select_symbol_title",
      symbolPlaceholder: "common:search_symbol",
      custom: "common:component.create_custom_manual",
      shares: "activity:form.bulk_col_shares",
      cost: "activity:form.bulk_col_average_cost",
      purchase: "common:component.record_buy",
      launcherPlaceholder: "common:component.search_actions_holdings_accounts",
    };
    const copy = Object.fromEntries(
      Object.entries(keys).map(([key, value]) => [key, t(value)]),
    ) as Record<keyof typeof keys, string>;
    await page.getByRole("link", { name: copy.search, exact: true }).click();
    const drawer = page.getByRole("dialog");
    const add = drawer.getByRole("group", { name: copy.add, exact: true });
    await expect(add).toBeVisible();
    await expect(drawer.getByRole("group").first()).toHaveAccessibleName(copy.add);
    for (const label of [copy.transaction, copy.expense, copy.income, copy.holdings]) {
      await expect(add.getByRole("option", { name: label, exact: true })).toBeInViewport();
    }
    if (scenario.language === "en")
      await drawer.screenshot({
        path: test.info().outputPath("launcher-add-first.png"),
      });
    await expect(drawer.getByRole("option", { name: copy.purchase, exact: true })).toHaveCount(0);
    const search = drawer.getByPlaceholder(copy.launcherPlaceholder);
    await search.fill("buy");
    await expect(add.getByRole("option", { name: copy.purchase, exact: true })).toBeVisible();
    await search.fill("");
    await add.getByRole("option", { name: copy.holdings, exact: true }).click();
    const bulk = page.getByRole("dialog", { name: copy.bulkTitle, exact: true });
    await expect(bulk).toBeVisible();
    if (scenario.language === "en")
      await bulk.screenshot({
        path: test.info().outputPath("holdings-entry.png"),
      });
    const title = (await bulk.getByRole("heading", { name: copy.bulkTitle }).boundingBox())!;
    const close = (await bulk.locator('[data-slot="sheet-close"]').boundingBox())!;
    expect(
      scenario.direction === "rtl"
        ? title.x >= close.x + close.width
        : title.x + title.width <= close.x,
    ).toBe(true);
    await expect(bulk.getByLabel(copy.shares, { exact: true })).toBeVisible();
    await expect(bulk.getByLabel(copy.cost, { exact: true })).toBeVisible();
    const ticker = bulk.getByTestId("bulk-holding-ticker-0");
    expect((await ticker.boundingBox())!.width).toBeGreaterThan(
      (await bulk.boundingBox())!.width * 0.65,
    );
    const writes: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      // Searching activities is a read, even though it is a POST.
      if (
        ["POST", "PUT", "PATCH"].includes(request.method()) &&
        /\/activities(?:\/|$)/.test(path) &&
        !path.endsWith("/search")
      )
        writes.push(request.method());
    });
    await ticker.click();
    const picker = page.getByRole("dialog", { name: copy.symbolTitle, exact: true });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("combobox")).toHaveCount(1);
    await expect(picker.getByRole("option")).toHaveCount(0);
    const input = picker.getByPlaceholder(copy.symbolPlaceholder);
    await input.fill("AAPL");
    const result = picker
      .getByRole("option")
      .filter({ has: page.locator("span.font-mono").filter({ hasText: /^AAPL$/ }) })
      .filter({ hasNotText: copy.custom })
      .first();
    await expect(result).toBeVisible();
    if (scenario.language === "en")
      await picker.screenshot({
        path: test.info().outputPath("ticker-sheet.png"),
      });
    await result.click();
    await expect(picker).toHaveCount(0);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(bulk.getByTestId("bulk-holding-shares-0")).toBeFocused();
    await bulk.getByTestId("bulk-holding-shares-0").fill("10");
    await bulk.getByTestId("bulk-holding-cost-0").fill("150");
    await bulk.getByTestId("bulk-holdings-add-row").click();
    await expect(bulk.getByTestId("bulk-holding-ticker-1")).toBeVisible();
    await page.evaluate(() =>
      document.documentElement.style.setProperty("--keyboard-inset-bottom", "340px"),
    );
    await expect
      .poll(async () => {
        const box = (await bulk.getByTestId("bulk-holdings-confirm").boundingBox())!;
        return box.y + box.height;
      })
      .toBeLessThanOrEqual(504);
    expect(writes).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
