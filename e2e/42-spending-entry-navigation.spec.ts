import { devices, expect, test, type Page } from "@playwright/test";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test.use({ ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } });

async function seedAccounts(page: Page) {
  await page.evaluate(async () => {
    const { profileScope } = await import(
      new URL("/src/features/profiles/session.ts", location.href).href
    );
    const headers = { "Content-Type": "application/json", "x-wf-profile-scope": profileScope() };
    const ids = [];
    for (const [name, accountType] of [
      ["Grid bank", "CASH"],
      ["Grid card", "CREDIT_CARD"],
    ]) {
      const response = await fetch("/api/v1/accounts", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name,
          accountType,
          currency: "USD",
          isActive: true,
          isDefault: false,
          isArchived: false,
          trackingMode: "TRANSACTIONS",
        }),
      });
      if (!response.ok) throw new Error("Could not seed spending account");
      ids.push((await response.json()).id);
    }
    const response = await fetch("/api/v1/spending/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true, accountIds: ids }),
    });
    if (!response.ok) throw new Error("Could not enable spending fixture");
  });
}

test.beforeEach(async ({ browser, page }) => {
  const desktop = await browser.newContext({ ...devices["Desktop Chrome"] });
  await completeOnboardingIfNeeded(await desktop.newPage());
  await desktop.close();
  await completeOnboardingIfNeeded(page);
  await gotoAppPath(page, "/");
  await expect(page.locator("[data-page-scroll-container]")).toBeVisible();
  await seedAccounts(page);
});

async function markOrigin(page: Page) {
  await page.locator("[data-page-scroll-container]").evaluate((element) => {
    element.setAttribute("data-entry-origin", "retained");
  });
}

async function expectOriginRetained(page: Page) {
  await expect(
    page.locator('[data-page-scroll-container][data-entry-origin="retained"]'),
  ).toBeAttached();
}

test("desktop sheets retain their origin and return without adding another history entry", async ({
  page,
}) => {
  await gotoAppPath(page, "/?tab=spending");
  await markOrigin(page);
  await page.getByRole("button", { name: "More options", exact: true }).first().click();
  await page.getByRole("button", { name: "Add expense", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "Add expense" }),
  ).toBeVisible();
  await expectOriginRetained(page);
  // Search can be opened above an entry sheet: it must replace the entry,
  // retain the real origin, and leave exactly one form open.
  const entryLength = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "Close", exact: true }).press("Control+k");
  await page.getByPlaceholder("Search actions, holdings, or accounts...").fill("expense");
  await page.getByRole("option", { name: "Add expense", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Command palette", exact: true })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Add expense", exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => history.length)).toBe(entryLength);
  await expectOriginRetained(page);
  await page
    .getByRole("dialog", { name: "Add expense", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page).toHaveURL(/\/\?tab=spending$/);
  await expectOriginRetained(page);
  await page.goBack();
  await expect(page).not.toHaveURL(/transactions\/new/);

  await gotoAppPath(page, "/holdings");
  await markOrigin(page);
  await page.keyboard.press("Control+k");
  const search = page.getByRole("dialog");
  await search.getByRole("combobox").fill("expense");
  await search.getByRole("option", { name: "Add expense", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "Add expense" }),
  ).toBeVisible();
  await expectOriginRetained(page);
  await page
    .getByRole("dialog", { name: "Add expense", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page).toHaveURL(/\/holdings$/);
  await expectOriginRetained(page);
});

test("closing a direct entry link replaces it with the Spending dashboard", async ({ page }) => {
  await gotoAppPath(page, "/spending/transactions/new?type=WITHDRAWAL");
  await expect(page.getByRole("dialog")).toBeVisible();
  const length = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "Close", exact: true }).press("Control+k");
  await page.getByPlaceholder("Search actions, holdings, or accounts...").fill("expense");
  await page.getByRole("option", { name: "Add expense", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Command palette", exact: true })).toBeHidden();
  await expect(page.getByRole("heading", { name: "Add expense", exact: true })).toHaveCount(1);
  expect(await page.evaluate(() => history.length)).toBe(length);
  await page
    .getByRole("dialog", { name: "Add expense", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await expect(page).toHaveURL(/\/\?tab=spending$/);
  expect(await page.evaluate(() => history.length)).toBe(length);
});
