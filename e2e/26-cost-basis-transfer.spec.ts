import { expect, test, type Page } from "@playwright/test";
import {
  BASE_URL,
  completeOnboardingIfNeeded,
  fillDateField,
  gotoActivities,
  openAddActivitySheet,
  searchAndSelectSymbol,
  selectAccountOption,
  selectActivityType,
} from "./helpers";

/**
 * A transfer carries the cost its sender's method relieves (engine rules R7.2),
 * so switching the sender's method must also recalculate the receiver.
 *
 * Sender buys 10 AAPL @ 100 and 10 @ 200, then sends 5 to the receiver:
 * - sender on FIFO: the receiver gets 5 @ 100 (500), the sender keeps 2,500;
 * - sender on WAC: the receiver gets 5 @ 150 (750), the sender keeps 2,250.
 */
test.describe.configure({ mode: "serial" });

test.describe("Cost basis method across an internal transfer", () => {
  let page: Page;
  const runId = Date.now().toString(36);
  const sender = { name: `CB sender ${runId}`, id: "" };
  const receiver = { name: `CB receiver ${runId}`, id: "" };

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  async function createAccount(name: string) {
    const response = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
      data: {
        name,
        accountType: "SECURITIES",
        currency: "USD",
        isDefault: false,
        isActive: true,
        isArchived: false,
        trackingMode: "TRANSACTIONS",
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return ((await response.json()) as { id: string }).id;
  }

  // The same request the account form sends when its method changes.
  async function setMethod(account: { name: string; id: string }, method: "FIFO" | "WAC") {
    const response = await page.request.put(`${BASE_URL}/api/v1/accounts/${account.id}`, {
      data: {
        id: account.id,
        name: account.name,
        accountType: "SECURITIES",
        isDefault: false,
        isActive: true,
        isArchived: false,
        trackingMode: "TRANSACTIONS",
        meta: JSON.stringify({ accounting: { costBasisMethod: method } }),
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  }

  async function buy(accountId: string, date: string, quantity: number, unitPrice: number) {
    const response = await page.request.post(`${BASE_URL}/api/v1/activities`, {
      data: {
        accountId,
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
    expect(response.ok(), await response.text()).toBeTruthy();
  }

  async function bookCost(accountId: string): Promise<number | null> {
    const response = await page.request.get(
      `${BASE_URL}/api/v1/holdings?accountId=${encodeURIComponent(accountId)}`,
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

  async function expectBookCosts(expected: { sender: number; receiver: number }) {
    await expect
      .poll(
        async () => ({ sender: await bookCost(sender.id), receiver: await bookCost(receiver.id) }),
        {
          timeout: 60_000,
          intervals: [1_000],
        },
      )
      .toEqual(expected);
  }

  test("1. Set up two FIFO accounts and buy in the sender", async () => {
    test.setTimeout(180_000);
    await completeOnboardingIfNeeded(page);

    sender.id = await createAccount(sender.name);
    receiver.id = await createAccount(receiver.name);
    await buy(sender.id, "2024-01-02T15:00:00.000Z", 10, 100);
    await buy(sender.id, "2024-02-01T15:00:00.000Z", 10, 200);
  });

  test("2. Transfer 5 AAPL from the sender to the receiver", async () => {
    await gotoActivities(page);
    await openAddActivitySheet(page);
    await selectActivityType(page, "Transfer");
    await page.getByRole("button", { name: "Securities" }).click();
    await selectAccountOption(
      page,
      sender.name,
      "USD",
      page.getByRole("combobox", { name: "From Account" }),
    );
    await selectAccountOption(
      page,
      receiver.name,
      "USD",
      page.getByRole("combobox", { name: "To Account" }),
    );
    await searchAndSelectSymbol(page, "AAPL");
    await fillDateField(page, 10);
    const quantity = page.getByTestId("quantity-input");
    await quantity.fill("5");
    await quantity.blur();

    const submit = page.getByRole("button", { name: /^Transfer\s+/i });
    await expect(submit).toBeEnabled({ timeout: 5_000 });
    await submit.click();
    await expect(page.getByRole("heading", { name: "Add Activity" })).not.toBeVisible({
      timeout: 20_000,
    });
  });

  test("3. FIFO: the receiver holds the sender's oldest units", async () => {
    await expectBookCosts({ sender: 2500, receiver: 500 });
  });

  test("4. Switching the sender to WAC recalculates the receiver", async () => {
    await setMethod(sender, "WAC");
    await expectBookCosts({ sender: 2250, receiver: 750 });
  });

  test("5. Switching the sender back to FIFO restores both", async () => {
    await setMethod(sender, "FIFO");
    await expectBookCosts({ sender: 2500, receiver: 500 });
  });
});
