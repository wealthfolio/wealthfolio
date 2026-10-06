import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

/**
 * Each cost basis method relieves different lots (engine rules R7.2), and the
 * account form switches between them. Buys of 10 AAPL at 100, 200 and 120
 * (4,200), then a sale of 5, leave a different book cost under each:
 * - FIFO sells 5 at 100: 3,700;
 * - LIFO sells 5 at 120: 3,600;
 * - HIFO sells 5 at 200: 3,200;
 * - WAC sells 5 at the 140 average: 3,500.
 */
test.describe.configure({ mode: "serial" });

test.describe("Cost basis methods in the account form", () => {
  let page: Page;
  const account = { name: `CB methods ${Date.now().toString(36)}`, id: "" };

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  async function trade(type: "BUY" | "SELL", date: string, quantity: number, unitPrice: number) {
    const response = await page.request.post(`${BASE_URL}/api/v1/activities`, {
      data: {
        accountId: account.id,
        activityType: type,
        activityDate: date,
        currency: "USD",
        quantity,
        unitPrice,
        fee: 0,
        needsReview: false,
        asset: { symbol: "AAPL", exchangeMic: "XNAS", kind: "INVESTMENT", quoteCcy: "USD" },
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  }

  async function bookCost(): Promise<number | null> {
    const response = await page.request.get(
      `${BASE_URL}/api/v1/holdings?accountId=${encodeURIComponent(account.id)}`,
    );
    if (!response.ok()) return null;
    const holdings = (await response.json()) as Array<{
      instrument?: { symbol?: string } | null;
      costBasis?: { local: number | string } | null;
    }>;
    const aapl = holdings.find((h) => h.instrument?.symbol === "AAPL");
    if (!aapl?.costBasis) return null;
    return Math.round(Number(aapl.costBasis.local) * 100) / 100;
  }

  async function expectBookCost(expected: number) {
    await expect.poll(bookCost, { timeout: 60_000, intervals: [1_000] }).toBe(expected);
  }

  async function chooseMethod(label: string) {
    await gotoAppPath(page, "/settings/accounts");
    const accountsPage = page.getByTestId("settings-accounts-page").filter({ visible: true });
    const row = accountsPage
      .locator("div.justify-between")
      .filter({ has: page.getByRole("link", { name: account.name, exact: true }) })
      .last();
    await row.getByRole("button", { name: "Open" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();

    const modal = page.getByTestId("account-modal").filter({ visible: true }).first();
    await expect(modal).toBeVisible();
    const section = modal.getByRole("button", { name: /Cost basis/ });
    if ((await section.getAttribute("aria-expanded")) !== "true") {
      await section.click();
    }
    await modal.getByRole("combobox", { name: "Cost basis" }).click();
    await page.getByRole("option", { name: label }).click();
    await expect(modal.getByText("Saving recalculates this account's history.")).toBeVisible();
    await modal.getByTestId("account-submit-button").click();
    await expect(modal).not.toBeVisible({ timeout: 10_000 });
  }

  test("1. An account on FIFO buys three lots and sells part", async () => {
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

    await trade("BUY", "2024-01-02T15:00:00.000Z", 10, 100);
    await trade("BUY", "2024-02-01T15:00:00.000Z", 10, 200);
    await trade("BUY", "2024-03-01T15:00:00.000Z", 10, 120);
    await trade("SELL", "2024-04-01T15:00:00.000Z", 5, 250);
    await expectBookCost(3700);
  });

  test("2. LIFO sells the newest lot", async () => {
    await chooseMethod("Last in, first out (LIFO)");
    await expectBookCost(3600);
  });

  test("3. HIFO sells the dearest lot", async () => {
    await chooseMethod("Highest cost, first out (HIFO)");
    await expectBookCost(3200);
  });

  test("4. WAC sells at the average", async () => {
    await chooseMethod("Weighted average cost (WAC)");
    await expectBookCost(3500);
  });

  test("5. Back to FIFO", async () => {
    await chooseMethod("First in, first out (FIFO)");
    await expectBookCost(3700);
  });
});
