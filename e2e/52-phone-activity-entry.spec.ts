import { createAccount, getActivity, uniqueName, type ApiAccount } from "./api";
import { expect, test } from "./fixtures";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";
import { addActivityOnPhone, PHONE, type PhoneActivity, type SavedActivity } from "./phone";

// Every activity type saved through the phone's step form (type card, Next,
// details, Add Activity), then read back from the API. Runs in order: the sell,
// dividend and split need the buy's holding.
test.use(PHONE);
test.describe.configure({ mode: "serial" });

let account: ApiAccount;
let savings: ApiAccount;

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await completeOnboardingIfNeeded(page);
  account = await createAccount(page, { name: uniqueName("Phone entry") });
  savings = await createAccount(page, { name: uniqueName("Phone savings"), accountType: "CASH" });
  await page.close();
});

test.beforeEach(async ({ page }) => {
  await completeOnboardingIfNeeded(page);
  await gotoAppPath(page, "/activities");
  await expect(page.getByTitle("Add", { exact: true })).toBeVisible();
});

interface Case {
  entry: (names: { account: string; savings: string }) => PhoneActivity;
  saved: {
    activityType: string;
    symbol?: string;
    quantity?: number;
    unitPrice?: number;
    amount?: number;
    fee?: number;
  };
}

const CASES: Case[] = [
  {
    entry: (n) => ({ type: "DEPOSIT", account: n.account, amount: "10000" }),
    saved: { activityType: "DEPOSIT", amount: 10_000 },
  },
  {
    entry: (n) => ({
      type: "BUY",
      account: n.account,
      symbol: "AAPL",
      quantity: "10",
      price: "150.25",
      fee: "1.5",
    }),
    saved: { activityType: "BUY", symbol: "AAPL", quantity: 10, unitPrice: 150.25, fee: 1.5 },
  },
  {
    entry: (n) => ({
      type: "SELL",
      account: n.account,
      symbol: "AAPL",
      quantity: "4",
      price: "160",
    }),
    saved: { activityType: "SELL", symbol: "AAPL", quantity: 4, unitPrice: 160 },
  },
  {
    entry: (n) => ({ type: "DIVIDEND", account: n.account, symbol: "AAPL", amount: "12.5" }),
    saved: { activityType: "DIVIDEND", symbol: "AAPL", amount: 12.5 },
  },
  {
    entry: (n) => ({ type: "INTEREST", account: n.account, amount: "3.25" }),
    saved: { activityType: "INTEREST", amount: 3.25 },
  },
  {
    entry: (n) => ({ type: "FEE", account: n.account, amount: "2.5" }),
    saved: { activityType: "FEE", fee: 2.5 },
  },
  {
    entry: (n) => ({ type: "TAX", account: n.account, amount: "4.75" }),
    saved: { activityType: "TAX", amount: 4.75 },
  },
  {
    entry: (n) => ({ type: "WITHDRAWAL", account: n.account, amount: "100" }),
    saved: { activityType: "WITHDRAWAL", amount: 100 },
  },
  {
    entry: (n) => ({ type: "SPLIT", account: n.account, symbol: "AAPL", ratio: "2" }),
    saved: { activityType: "SPLIT", symbol: "AAPL", amount: 2 },
  },
];

for (const { entry, saved } of CASES) {
  test(`${saved.activityType.toLowerCase()} saves through the step form`, async ({ page }) => {
    test.setTimeout(90_000);
    const created = (await addActivityOnPhone(
      page,
      entry({ account: account.name, savings: savings.name }),
    )) as SavedActivity;

    const stored = await getActivity(page, created.id);
    expect(stored.accountId).toBe(account.id);
    expect(stored.activityType).toBe(saved.activityType);
    expect(stored.currency).toBe("USD");
    if (saved.symbol) expect(stored.assetSymbol).toBe(saved.symbol);
    for (const field of ["quantity", "unitPrice", "amount", "fee"] as const) {
      if (saved[field] !== undefined) expect(Number(stored[field]), field).toBe(saved[field]);
    }
  });
}

test("transfer saves both legs through the step form", async ({ page }) => {
  test.setTimeout(90_000);
  const pair = (await addActivityOnPhone(page, {
    type: "TRANSFER",
    account: account.name,
    toAccount: savings.name,
    amount: "250",
  })) as { transferOut: SavedActivity; transferIn: SavedActivity };

  const out = await getActivity(page, pair.transferOut.id);
  const into = await getActivity(page, pair.transferIn.id);
  expect([out.activityType, out.accountId, Number(out.amount)]).toEqual([
    "TRANSFER_OUT",
    account.id,
    250,
  ]);
  expect([into.activityType, into.accountId, Number(into.amount)]).toEqual([
    "TRANSFER_IN",
    savings.id,
    250,
  ]);
});
