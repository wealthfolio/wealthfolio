import { expect, test, type Page } from "@playwright/test";
import {
  BASE_URL,
  completeOnboardingIfNeeded,
  gotoActivities,
  gotoAppPath,
  openAddActivitySheet,
  selectAccountOption,
} from "./helpers";

/**
 * A conversion (engine rules R7.5): 25 AAPL bought in two lots (10 at 100,
 * 15 at 200) become 40 MSFT. The two rows save together, MSFT takes over the
 * lots' cost (4,000), and editing or deleting either row acts on both.
 */
test.describe.configure({ mode: "serial" });

test.describe("Conversion", () => {
  let page: Page;
  const account = { name: `Conversion ${Date.now().toString(36)}`, id: "" };
  let leavingId = "";
  let arrivingId = "";

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  async function holding(symbol: string) {
    const response = await page.request.get(
      `${BASE_URL}/api/v1/holdings?accountId=${encodeURIComponent(account.id)}`,
    );
    if (!response.ok()) return null;
    const holdings = (await response.json()) as Array<{
      instrument?: { symbol?: string } | null;
      quantity: number | string;
      costBasis?: { local: number | string } | null;
    }>;
    const found = holdings.find((h) => h.instrument?.symbol === symbol);
    return found
      ? { quantity: Number(found.quantity), cost: Number(found.costBasis?.local ?? 0) }
      : null;
  }

  // The form has two symbol pickers: pick into the first one still empty.
  async function pickSymbol(symbol: string) {
    await page
      .getByRole("combobox")
      .filter({ hasText: /Select symbol/i })
      .first()
      .click();
    const searchInput = page.getByPlaceholder("Search for symbol");
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await searchInput.fill(symbol);
    const option = page
      .getByRole("listbox", { name: /Suggestions/i })
      .getByRole("option")
      .filter({
        has: page.locator("span.font-mono").filter({ hasText: new RegExp(`^${symbol}$`, "i") }),
        hasNotText: /Create custom|manual/i,
      })
      .first();
    await expect(option).toBeVisible({ timeout: 30000 });
    await option.click();
    // The pick closes the search before the other picker opens.
    await expect(searchInput).toBeHidden({ timeout: 5000 });
  }

  async function saveForm(submitName: RegExp) {
    const saved = page.waitForResponse(
      (res) => res.url().endsWith("/activities/bulk") && res.request().method() === "POST",
    );
    await page.getByRole("button", { name: submitName }).click();
    const response = await saved;
    expect(response.ok(), await response.text()).toBeTruthy();
    const result = (await response.json()) as {
      errors: unknown[];
      created: Array<{ id: string; subtype: string; sourceGroupId: string }>;
      updated: Array<{ id: string; quantity: string }>;
    };
    expect(result.errors).toEqual([]);
    await expect(page.getByTestId("activity-form-dialog")).not.toBeVisible({ timeout: 20_000 });
    return result;
  }

  test("1. Buy AAPL in two lots", async () => {
    test.setTimeout(180_000);
    await completeOnboardingIfNeeded(page);
    const response = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
      data: {
        name: account.name,
        accountType: "SECURITIES",
        currency: "USD",
        isDefault: false,
        isActive: true,
        isArchived: false,
        trackingMode: "TRANSACTIONS",
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    account.id = ((await response.json()) as { id: string }).id;
    for (const [date, quantity, unitPrice] of [
      ["2024-01-02T15:00:00.000Z", 10, 100],
      ["2024-02-01T15:00:00.000Z", 15, 200],
    ] as const) {
      const buy = await page.request.post(`${BASE_URL}/api/v1/activities`, {
        data: {
          accountId: account.id,
          activityType: "BUY",
          activityDate: date,
          currency: "USD",
          quantity,
          unitPrice,
          fee: 0,
          needsReview: false,
          asset: { symbol: "AAPL", exchangeMic: "XNAS", kind: "INVESTMENT", quoteCcy: "USD" },
        },
      });
      expect(buy.ok(), await buy.text()).toBeTruthy();
    }
    await expect
      .poll(() => holding("AAPL"), { timeout: 60_000 })
      .toEqual({
        quantity: 25,
        cost: 4000,
      });
  });

  test("2. Convert 25 AAPL into 40 MSFT from the form", async () => {
    await gotoActivities(page);
    await openAddActivitySheet(page);
    const conversion = page.getByTestId("activity-type-conversion");
    if (!(await conversion.isVisible()))
      await page.getByRole("button", { name: "Expand to show all types" }).click();
    await conversion.click();
    await selectAccountOption(page, account.name, "USD");
    await pickSymbol("AAPL");
    await page.locator('input[name="fromQuantity"]').fill("25");
    await pickSymbol("MSFT");
    await page.locator('input[name="toQuantity"]').fill("40");

    const result = await saveForm(/Add Fund Conversion/);
    const [leaving, arriving] = result.created;
    expect(leaving.subtype).toBe("CONVERSION_OUT");
    expect(arriving.subtype).toBe("CONVERSION_IN");
    expect(arriving.sourceGroupId).toBe(leaving.sourceGroupId);
    leavingId = leaving.id;
    arrivingId = arriving.id;

    await expect
      .poll(() => holding("MSFT"), { timeout: 60_000 })
      .toEqual({
        quantity: 40,
        cost: 4000,
      });
    expect(await holding("AAPL")).toBeNull();
  });

  test("3. Editing the arriving row shows and saves both sides", async () => {
    await gotoAppPath(page, `/activities?tab=investments&activity=${arrivingId}`);
    await page.getByRole("button", { name: "Open", exact: true }).first().click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await expect(page.locator('input[name="fromQuantity"]')).toHaveValue("25");
    await expect(page.locator('input[name="toQuantity"]')).toHaveValue("40");
    await page.locator('input[name="toQuantity"]').fill("50");

    const result = await saveForm(/Update/);
    expect(result.updated.map((row) => row.id).sort()).toEqual([leavingId, arrivingId].sort());

    await expect
      .poll(() => holding("MSFT"), { timeout: 60_000 })
      .toEqual({
        quantity: 50,
        cost: 4000,
      });
  });

  test("4. Deleting one row deletes the conversion", async () => {
    const deleted = await page.request.delete(`${BASE_URL}/api/v1/activities/${leavingId}`);
    expect(deleted.ok(), await deleted.text()).toBeTruthy();
    for (const id of [leavingId, arrivingId]) {
      const search = await page.request.post(`${BASE_URL}/api/v1/activities/search`, {
        data: { activityIdFilter: [id], page: 0, pageSize: 10 },
      });
      expect(search.ok()).toBeTruthy();
      expect(((await search.json()) as { data: unknown[] }).data).toEqual([]);
    }
    await expect
      .poll(() => holding("AAPL"), { timeout: 60_000 })
      .toEqual({
        quantity: 25,
        cost: 4000,
      });
  });

  test("5. A phone records a conversion from its type list", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    try {
      // The desktop Add menu is hidden on a phone, which has its own button.
      await gotoAppPath(page, "/activities");
      const add = page.locator('button[title="Add"]');
      await expect(add).toBeVisible({ timeout: 10_000 });
      await add.click();
      // The phone list hands a conversion to the sheet form.
      await page.locator('label[for="CONVERSION"]').click();
      await expect(page.getByTestId("activity-form-dialog")).toBeVisible();
      await selectAccountOption(page, account.name, "USD");
      await pickSymbol("AAPL");
      await page.locator('input[name="fromQuantity"]').fill("5");
      await pickSymbol("MSFT");
      await page.locator('input[name="toQuantity"]').fill("8");

      const result = await saveForm(/Add Fund Conversion/);
      expect(result.created.map((row) => row.subtype)).toEqual(["CONVERSION_OUT", "CONVERSION_IN"]);
      // FIFO: the 5 units leave the first lot, at 100 each.
      await expect
        .poll(() => holding("MSFT"), { timeout: 60_000 })
        .toEqual({ quantity: 8, cost: 500 });
      expect(await holding("AAPL")).toEqual({ quantity: 20, cost: 3500 });
    } finally {
      await page.setViewportSize({ width: 1280, height: 720 });
    }
  });
});
