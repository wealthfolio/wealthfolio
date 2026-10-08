import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";

test("dashboard portfolio selection, creation, persistence, deletion and mobile layout", async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  await completeOnboardingIfNeeded(page);
  const accountIds: string[] = [];
  for (const [name, amount] of [
    ["Portfolio filter savings", 1000000],
    ["Portfolio filter checking", 200],
  ] as const) {
    const response = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
      data: {
        name,
        accountType: "CASH",
        currency: "CAD",
        isDefault: false,
        isActive: true,
        trackingMode: "TRANSACTIONS",
      },
    });
    expect(response.ok()).toBe(true);
    const { id } = (await response.json()) as { id: string };
    accountIds.push(id);
    const deposit = await page.request.post(`${BASE_URL}/api/v1/activities`, {
      data: {
        accountId: id,
        activityType: "DEPOSIT",
        activityDate: "2026-05-01T12:00:00Z",
        amount,
        currency: "CAD",
        fee: 0,
      },
    });
    expect(deposit.ok()).toBe(true);
  }
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
  const filter = page.getByRole("combobox", { name: /^Choose portfolio:/ });
  // Mobile keeps neighbouring views mounted; scope assertions to the investment headline.
  const headlineContainer = page
    .getByRole("button", { name: /^(Hide|Show) Balance$/ })
    .locator("..");
  const balanceValue = headlineContainer.getByTestId("portfolio-balance-value");
  await expect(filter).toHaveAccessibleName("Choose portfolio: All Accounts");
  await expect(balanceValue).toContainText("1,000,200.00", {
    timeout: 30000,
  });
  await filter.click();
  await page.getByRole("option", { name: "Add portfolio" }).click();
  await expect(page).toHaveURL(`${BASE_URL}/settings/portfolios`);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Add portfolio", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "New portfolio" });
  await dialog.getByLabel("Name", { exact: true }).fill("Dashboard savings");
  await dialog
    .locator("label")
    .filter({ hasText: "Portfolio filter savings" })
    .getByRole("checkbox")
    .click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
  await expect(filter).toHaveAccessibleName("Choose portfolio: All Accounts");
  await filter.click();
  await expect(page.getByRole("option", { name: "Add portfolio" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Edit portfolio" })).toHaveCount(0);
  await expect(page.getByRole("option", { name: "Manage portfolios" })).toBeVisible();
  await page.getByRole("option", { name: "Dashboard savings" }).click();
  await expect(filter).toHaveAccessibleName("Choose portfolio: Dashboard savings");
  await expect(balanceValue).toContainText("1,000,000.00", {
    timeout: 30000,
  });
  await expect(page.locator(`a[href="/accounts/${accountIds[0]}"]`)).toBeVisible();
  await expect(page.locator(`a[href="/accounts/${accountIds[1]}"]`)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("desktop-dashboard.png") });
  await filter.click();
  await expect
    .poll(() => page.getByRole("dialog").evaluate((element) => getComputedStyle(element).opacity))
    .toBe("1");
  await page.screenshot({ path: testInfo.outputPath("desktop-portfolio-filter.png") });
  await page.getByRole("option", { name: "Manage portfolios" }).click();
  await expect(page).toHaveURL(`${BASE_URL}/settings/portfolios`);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit portfolio" });
  await editor
    .locator("label")
    .filter({ hasText: "Portfolio filter checking" })
    .getByRole("checkbox")
    .click();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
  await expect(filter).toHaveAccessibleName("Choose portfolio: Dashboard savings");
  await expect(balanceValue).toContainText("1,000,200.00");
  await expect(page.locator(`a[href="/accounts/${accountIds[1]}"]`)).toBeVisible();
  await filter.click();
  await page.getByRole("option", { name: "Manage portfolios" }).click();
  await expect(page).toHaveURL(`${BASE_URL}/settings/portfolios`);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  await editor
    .locator("label")
    .filter({ hasText: "Portfolio filter checking" })
    .getByRole("checkbox")
    .click();
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
  await expect(balanceValue).toContainText("1,000,000.00");
  await page.reload();
  await expect(filter).toHaveAccessibleName("Choose portfolio: Dashboard savings");
  await filter.click();
  await page.getByRole("option", { name: "All Accounts" }).click();
  await expect(balanceValue).toContainText("1,000,200.00", {
    timeout: 30000,
  });
  await filter.click();
  await page.getByRole("option", { name: "Dashboard savings" }).click();

  await page.setViewportSize({ width: 320, height: 740 });
  await expect(filter).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile-dashboard.png") });
  await filter.click();
  const sheet = page.getByRole("dialog", { name: "Choose portfolio" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("heading", { name: "Choose portfolio" })).toBeFocused();
  await expect(async () => {
    const sheetBounds = await sheet.boundingBox();
    expect(sheetBounds).not.toBeNull();
    expect(sheetBounds?.width).toBeLessThanOrEqual(320);
    expect(sheetBounds?.y).toBeGreaterThanOrEqual(0);
    expect((sheetBounds?.y ?? 0) + (sheetBounds?.height ?? 0)).toBeLessThanOrEqual(741);
  }).toPass();
  await page.screenshot({ path: testInfo.outputPath("mobile-portfolio-sheet.png") });
  await sheet.getByRole("option", { name: "Manage portfolios" }).click();
  await expect(sheet).not.toBeVisible();
  await expect(page).toHaveURL(`${BASE_URL}/settings/portfolios`);
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
  await expect(filter).toHaveAccessibleName("Choose portfolio: Dashboard savings");
  await filter.click();
  await sheet.getByRole("option", { name: "All Accounts" }).click();
  await expect(sheet).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Hide Balance", exact: true }).click();
  await expect(headlineContainer.getByTestId("portfolio-balance")).toContainText("•••");
  await page.getByRole("button", { name: "Show Balance", exact: true }).click();
  await filter.click();
  await page.getByRole("option", { name: "Dashboard savings" }).click();

  const portfolios = await page.request.get(`${BASE_URL}/api/v1/portfolios`);
  const saved = ((await portfolios.json()) as { id: string; name: string }[]).find(
    (item) => item.name === "Dashboard savings",
  );
  expect(saved).toBeDefined();
  const card = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
    data: {
      name: "Portfolio filter credit card",
      accountType: "CREDIT_CARD",
      currency: "CAD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(card.ok()).toBe(true);
  const { id: cardId } = (await card.json()) as { id: string };
  const changed = await page.request.put(`${BASE_URL}/api/v1/portfolios/${saved?.id}`, {
    data: { ...saved, accountIds: [cardId] },
  });
  expect(changed.ok()).toBe(true);
  await page.reload();
  await expect(filter).toHaveAccessibleName("Choose portfolio: Dashboard savings");
  await expect(balanceValue).toHaveText("$0.00", { timeout: 30000 });
  await expect(page.getByText("No accounts to display in this portfolio.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Manage portfolios" })).toHaveAttribute(
    "href",
    "/settings/portfolios",
  );
  await expect(page.getByRole("link", { name: "Add your first account" })).toHaveCount(0);
  const deleted = await page.request.delete(`${BASE_URL}/api/v1/portfolios/${saved?.id}`);
  expect(deleted.ok()).toBe(true);
  await page.reload();
  await expect(filter).toHaveAccessibleName("Choose portfolio: All Accounts");
  await expect(balanceValue).toContainText("1,000,200.00", {
    timeout: 30000,
  });
});
