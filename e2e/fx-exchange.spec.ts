import { expect, test, type Page } from "@playwright/test";
import {
  BASE_URL,
  completeOnboardingIfNeeded,
  createAccount,
  gotoActivities,
  gotoAppPath,
  selectAccountOption,
} from "./helpers";

async function selectCurrency(page: Page, currency: string, mobile: boolean) {
  await page.getByTestId("fx-destinationCurrency").click();
  await page
    .getByPlaceholder(mobile ? "Search all currencies..." : "Search currency...")
    .fill(currency);
  await page
    .getByRole(mobile ? "button" : "option", { name: new RegExp(currency) })
    .last()
    .click();
}

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"}: one exchange creates, edits and deletes both cash legs`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(30_000);
    const name = `FX exchange ${mobile ? "mobile" : "desktop"}`;
    await completeOnboardingIfNeeded(page);
    await createAccount(page, name, "USD");
    const accounts = await (await page.request.get(`${BASE_URL}/api/v1/accounts`)).json();
    const account = accounts.find((a: { name: string }) => a.name === name);
    const deposit = await page.request.post(`${BASE_URL}/api/v1/activities`, {
      data: {
        accountId: account.id,
        activityType: "DEPOSIT",
        activityDate: "2025-01-02",
        currency: "USD",
        amount: "1000",
      },
    });
    expect(deposit.ok()).toBeTruthy();
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    if (mobile) {
      await gotoAppPath(page, "/activities?tab=investments");
      await page.getByTitle("Add", { exact: true }).click();
      await page.locator('label[for="FX_EXCHANGE"]').click();
      await page.getByRole("button", { name: "Next", exact: true }).click();
    } else {
      await gotoActivities(page);
      await page.getByTestId("add-activities-button").click();
      await page.getByTestId("add-transaction-action").click();
      await page.getByTestId("activity-type-fx_exchange").click();
    }
    await selectAccountOption(page, name, "USD", page.getByTestId("account-select"));
    await selectCurrency(page, "EUR", mobile);
    await page.getByTestId("amount-input").fill("100");
    await page.getByTestId("destination-amount-input").fill("92");
    await expect(page.getByTestId("fx-execution-rate")).toContainText("0.92");
    const save = async (method: string) => {
      const response = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/api/v1/activities" && res.request().method() === method,
      );
      if (mobile) await page.getByRole("button", { name: /^(Add|Update) Activity$/ }).click();
      else await page.getByTestId("activity-form-dialog").locator('button[type="submit"]').click();
      const saved = await response;
      expect(saved.ok(), await saved.text()).toBeTruthy();
      expect(saved.request().postDataJSON().fxRate ?? null).toBeNull();
      return saved.json();
    };
    const created = await save("POST");
    expect(created.destinationCurrency).toBe("EUR");
    expect(Number(created.destinationAmount)).toBe(92);
    const cash = async () => {
      const response = await page.request.get(
        `${BASE_URL}/api/v1/holdings?accountId=${account.id}`,
      );
      if (!response.ok()) return {};
      const holdings = await response.json();
      return Object.fromEntries(
        holdings
          .filter((h: { holdingType: string }) => h.holdingType === "cash")
          .map((h: { localCurrency: string; quantity: string }) => [
            h.localCurrency,
            Number(h.quantity),
          ]),
      );
    };
    await expect.poll(cash, { timeout: 60_000 }).toMatchObject({ USD: 900, EUR: 92 });
    await gotoAppPath(page, `/activities?tab=investments&activity=${created.id}`);
    await expect(page.getByTestId("fx-exchange-amount").first()).toBeVisible();
    await page.getByRole("button", { name: "Open", exact: true }).first().click();
    if (mobile) await page.getByText("Edit", { exact: true }).click();
    else await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await expect(page.getByTestId("fx-destinationCurrency")).toContainText(/EUR|Euro/);
    await page.getByTestId("destination-amount-input").fill("93");
    const updated = await save("PUT");
    expect(updated.id).toBe(created.id);
    await expect.poll(cash, { timeout: 60_000 }).toMatchObject({ USD: 900, EUR: 93 });
    if (!mobile) {
      // The spreadsheet has its own local Duplicate → Save path, separate from
      // the standard activity mutation. Read-only exchange rows expose it too.
      await gotoActivities(page);
      await page.getByTestId("edit-mode-toggle").click();
      await expect(page.locator('[data-slot="grid"]')).toBeVisible();
      const exchangeRow = page
        .locator('[data-slot="grid-row"]')
        .filter({ hasText: "Currency Exchange" });
      await exchangeRow.getByRole("button", { name: "Open", exact: true }).click();
      await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
      const bulkSaved = page.waitForResponse(
        (res) =>
          new URL(res.url()).pathname === "/api/v1/activities/bulk" &&
          res.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      const response = await bulkSaved;
      expect(response.ok()).toBeTruthy();
      const bulk = await response.json();
      expect(bulk.errors).toEqual([]);
      expect(bulk.created).toHaveLength(1);
      const duplicate = bulk.created[0];
      expect(duplicate.id).not.toBe(created.id);
      expect(duplicate.currency).toBe("USD");
      expect(duplicate.destinationCurrency).toBe("EUR");
      expect(Number(duplicate.amount)).toBe(100);
      expect(Number(duplicate.destinationAmount)).toBe(93);
      await expect(
        page.getByRole("button", { name: "Save changes", exact: true }),
      ).not.toBeVisible();
      await expect.poll(cash, { timeout: 60_000 }).toMatchObject({ USD: 800, EUR: 186 });
      expect(
        (await page.request.delete(`${BASE_URL}/api/v1/activities/${duplicate.id}`)).ok(),
      ).toBeTruthy();
      // Return to the read view: grid deletion is staged until Save, whereas
      // the lifecycle assertion below exercises the confirmed single-row delete.
      await page.getByRole("button", { name: "View mode", exact: true }).click();
      await expect(page.locator('[data-slot="grid"]')).not.toBeVisible();
    }
    await gotoAppPath(page, `/activities?tab=investments&activity=${created.id}`);
    await page.getByRole("button", { name: "Open", exact: true }).first().click();
    if (mobile) await page.getByText("Delete", { exact: true }).click();
    else await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const deleted = page.waitForResponse(
      (res) =>
        res.request().method() === "DELETE" && res.url().endsWith(`/activities/${created.id}`),
    );
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /Delete/i })
      .click();
    expect((await deleted).ok()).toBeTruthy();
    await expect
      .poll(
        async () => {
          const balances = await cash();
          return { USD: balances.USD ?? 0, EUR: balances.EUR ?? 0 };
        },
        { timeout: 60_000 },
      )
      .toEqual({ USD: 1000, EUR: 0 });
  });
}

test("Spending nets both exchange legs in filtered and selected totals", async ({ page }) => {
  await completeOnboardingIfNeeded(page);
  const api = `${BASE_URL}/api/v1`;
  const accountResponse = await page.request.post(`${api}/accounts`, {
    data: {
      name: "FX spending cash",
      accountType: "CASH",
      currency: "GBP",
      isDefault: false,
      isActive: true,
    },
  });
  expect(accountResponse.ok()).toBeTruthy();
  const { id: accountId } = await accountResponse.json();
  const settings = await (await page.request.get(`${api}/spending/settings`)).json();
  expect(
    (
      await page.request.put(`${api}/spending/settings`, {
        data: { enabled: true, accountIds: [...settings.accountIds, accountId] },
      })
    ).ok(),
  ).toBeTruthy();
  for (const activity of [
    { activityType: "DEPOSIT", amount: "1000", notes: "Exchange deposit" },
    {
      activityType: "FX_EXCHANGE",
      amount: "100",
      destinationAmount: "92",
      destinationCurrency: "EUR",
      notes: "Spending exchange",
    },
  ]) {
    expect(
      (
        await page.request.post(`${api}/activities`, {
          data: { accountId, currency: "USD", activityDate: "2025-02-10T12:00:00Z", ...activity },
        })
      ).ok(),
    ).toBeTruthy();
  }
  const search = await page.request.post(`${api}/spending/cash-activities/search`, {
    data: { accountIds: [accountId], limit: 50 },
  });
  expect(search.ok()).toBeTruthy();
  const results = await search.json();
  expect(results.totalCount).toBe(2);
  expect(results.net.byCurrency).toEqual(
    expect.arrayContaining([
      { currency: "USD", amount: 900 },
      { currency: "EUR", amount: 92 },
    ]),
  );
  const exchange = results.items.find(
    (item: { activityType: string }) => item.activityType === "FX_EXCHANGE",
  );
  expect(exchange.cashFlowBucket).toBe("neutral");
  expect(exchange.visibleSpendingAmount).toBe(0);
  expect(exchange.cashMovements).toEqual([
    expect.objectContaining({ currency: "USD", amount: -100 }),
    expect.objectContaining({ currency: "EUR", amount: 92 }),
  ]);

  await gotoAppPath(page, "/activities?tab=spending&from=2025-02-01&to=2025-02-28");
  const filtered = page.getByText("Filtered net", { exact: false });
  await expect(filtered).toContainText(/USD\s*\+900/);
  await expect(filtered).toContainText(/EUR\s*\+92/);
  const exchangeRow = page.getByRole("row").filter({ hasText: "Spending exchange" });
  await exchangeRow.getByRole("checkbox", { name: "Select transaction" }).click();
  const selected = page.getByText("Selected net", { exact: false });
  await expect(selected).toContainText(/USD\s*-100/);
  await expect(selected).toContainText(/EUR\s*\+92/);
});
