import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";

test.use({ actionTimeout: 15_000 });

const api = `${BASE_URL}/api/v1`;
const ACCOUNT = "Loan payments chequing";
const LOAN = "Mortgage paid from chequing";
const PAYMENTS = [
  { day: "2025-03-01", comment: "Mortgage payment March" },
  { day: "2025-04-01", comment: "Mortgage payment April" },
  { day: "2025-05-01", comment: "Mortgage payment May" },
];

interface LoanPayment {
  activityId: string;
  amount: number;
  appliesTo?: string | null;
}

type ApiResponse = Awaited<ReturnType<Page["request"]["get"]>>;

async function ok(response: ApiResponse) {
  expect(response.ok(), await response.text()).toBeTruthy();
}

async function json<T>(response: ApiResponse): Promise<T> {
  await ok(response);
  return (await response.json()) as T;
}

async function spendingAccount(page: Page, name: string) {
  const { id } = await json<{ id: string }>(
    await page.request.post(`${api}/accounts`, {
      data: { name, accountType: "CASH", currency: "CAD", isDefault: false, isActive: true },
    }),
  );
  const settings = await json<{ accountIds: string[] }>(
    await page.request.get(`${api}/spending/settings`),
  );
  await ok(
    await page.request.put(`${api}/spending/settings`, {
      data: { enabled: true, accountIds: [...settings.accountIds, id] },
    }),
  );
  return id;
}

async function createLoan(page: Page, name: string) {
  const { assetId } = await json<{ assetId: string }>(
    await page.request.post(`${api}/alternative-assets`, {
      data: {
        kind: "liability",
        name,
        currency: "CAD",
        currentValue: "100000",
        valueDate: "2025-01-01",
        metadata: { sub_type: "mortgage" },
        loan: {
          originalAmount: 100000,
          originationDate: "2025-01-01",
          interestRate: 4,
          schedule: {
            frequency: "monthly",
            firstPaymentDate: "2025-02-01",
            lastPaymentDate: "2050-01-01",
            paymentAmount: 500,
          },
        },
      },
    }),
  );
  return assetId;
}

async function withdraw(
  page: Page,
  accountId: string,
  day: string,
  amount: number,
  comment: string,
) {
  const { id } = await json<{ id: string }>(
    await page.request.post(`${api}/activities`, {
      data: {
        accountId,
        activityType: "WITHDRAWAL",
        activityDate: `${day}T12:00:00.000Z`,
        currency: "CAD",
        amount,
        comment,
        needsReview: false,
      },
    }),
  );
  return id;
}

async function loanHolding(page: Page, loanId: string) {
  return (
    await json<{ id: string; marketValue: string; metadata: Record<string, unknown> }[]>(
      await page.request.get(`${api}/alternative-holdings`),
    )
  ).find((item) => item.id === loanId)!;
}

test("withdrawals from a cash account pay a loan and keep its balance in step", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await completeOnboardingIfNeeded(page);

  // A cash account enrolled in Spending, and a monthly 500 mortgage.
  const accountId = await spendingAccount(page, ACCOUNT);
  const loanId = await createLoan(page, LOAN);
  // Each payment is 100 more than the schedule asks for.
  const withdrawals: string[] = [];
  for (const { day, comment } of PAYMENTS) {
    withdrawals.push(await withdraw(page, accountId, day, 600, comment));
  }

  const payments = async () =>
    json<LoanPayment[]>(await page.request.get(`${api}/loans/${loanId}/payments`));
  const holding = () => loanHolding(page, loanId);
  const balance = async () => Number((await holding()).marketValue);
  const accountWithdrawals = async () =>
    (
      await json<{ data: { id: string; amount: string; metadata?: Record<string, unknown> }[] }>(
        await page.request.post(`${api}/activities/search`, {
          data: {
            page: 0,
            pageSize: 50,
            accountIdFilter: [accountId],
            activityTypeFilter: ["WITHDRAWAL"],
          },
        }),
      )
    ).data;
  const scheduled = await balance();

  // 1. Choose the account the loan is paid from.
  await page.goto(`${BASE_URL}/holdings/${loanId}`);
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByText("Edit loan details", { exact: true }).click();
  const details = page.getByRole("dialog");
  await details.getByRole("combobox", { name: "Paid from" }).click();
  await page.getByRole("option", { name: ACCOUNT }).click();
  await details.getByRole("button", { name: "Save Details", exact: true }).click();
  await expect(details).toHaveCount(0);
  await expect.poll(async () => (await holding()).metadata.payment_account_id).toBe(accountId);

  // 2. From the account: Spending's row menu counts March as a payment.
  await page.goto(`${BASE_URL}/activities?tab=spending&from=2025-02-15&to=2025-03-15`);
  const march = page.getByRole("row").filter({ hasText: PAYMENTS[0].comment });
  await march.getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Loan payment…" }).click();
  const linkSheet = page.getByRole("dialog");
  await linkSheet.getByRole("combobox", { name: "Loan" }).click();
  await page.getByRole("option", { name: LOAN }).click();
  await linkSheet.getByRole("button", { name: "Link", exact: true }).click();
  await expect(linkSheet).toHaveCount(0);
  await expect
    .poll(async () => (await payments()).map((p) => p.activityId))
    .toEqual([withdrawals[0]]);

  // 3. From the loan: April is flagged missing, and the sheet offers its withdrawal.
  await page.goto(`${BASE_URL}/holdings/${loanId}?tab=history`);
  const ledger = page.getByRole("region", { name: "Payments & events", exact: true });
  const year = ledger.getByRole("region", { name: "2025", exact: true });
  // Only the latest year starts open. The ledger first renders without the
  // calculation, when 2025 is the only year, so wait for a status it draws.
  const openYear = async () => {
    await expect(ledger.getByText("Not found").first()).toBeVisible();
    const toggle = year.getByRole("button", { name: /^2025/ });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  };
  await openYear();
  const rows = year.getByTestId("loan-ledger-row");
  await expect(rows.filter({ hasText: "Paid Mar 1" })).toHaveCount(1);
  const april = rows.filter({ hasText: "Not found" }).last();
  await expect(april).toContainText("Apr 1");
  await april.getByRole("button", { name: "Edit", exact: true }).click();
  const paymentsSheet = page.getByRole("dialog");
  const candidates = paymentsSheet.getByRole("region", { name: "Withdrawals near this date" });
  await expect(candidates).toContainText(PAYMENTS[1].comment);
  await candidates.getByRole("button", { name: "Link", exact: true }).click();
  await expect(paymentsSheet).toHaveCount(0);
  await expect(rows.filter({ hasText: "Paid Apr 1" })).toHaveCount(1);

  // May through the API; three payments each 100 over suggest a payment change.
  await ok(
    await page.request.post(`${api}/loans/payments/${withdrawals[2]}`, {
      data: { type: "link", loanId },
    }),
  );
  await expect.poll(async () => (await payments()).length).toBe(3);
  expect(scheduled - (await balance())).toBeGreaterThan(300);
  await page.reload();
  await openYear();
  const extras = rows.filter({ hasText: `Extra repayment · ${ACCOUNT}` });
  await expect(extras).toHaveCount(3);
  const suggestion = page.getByRole("alert").filter({ hasText: "Your last three payments" });
  await expect(suggestion).toContainText("$600.00");
  await suggestion.getByRole("button", { name: "Record payment change", exact: true }).click();
  await expect(suggestion).toHaveCount(0);
  await expect
    .poll(async () => {
      const raw = (await holding()).metadata.loan_events;
      return typeof raw === "string" ? JSON.parse(raw) : raw;
    })
    .toContainEqual({ type: "payment_change", effectiveDate: "2025-03-01", paymentAmount: 600 });
  // The difference is now part of the scheduled payment, not extra principal.
  await expect(extras).toHaveCount(0);
  await expect(rows.filter({ hasText: "Paid May 1" })).toHaveCount(1);

  // 4. With Paid from set, an extra repayment is recorded as a withdrawal there.
  const beforeExtra = await balance();
  await ledger.getByRole("button", { name: "Add event", exact: true }).click();
  await page.getByRole("menuitem", { name: "Extra Repayment", exact: true }).click();
  const extraDialog = page.getByRole("dialog");
  await expect(extraDialog).toContainText(`Recorded as a withdrawal from ${ACCOUNT}.`);
  await extraDialog.getByLabel("Repayment Amount").fill("250");
  await extraDialog.getByRole("button", { name: "Record Repayment", exact: true }).click();
  await expect(extraDialog).toHaveCount(0);
  await expect
    .poll(async () => (await payments()).find((p) => p.appliesTo === "extra")?.amount)
    .toBe(250);
  const extra = (await payments()).find((p) => p.appliesTo === "extra")!;
  expect((await accountWithdrawals()).map((activity) => activity.id)).toContain(extra.activityId);
  await expect.poll(async () => beforeExtra - (await balance())).toBeCloseTo(250, 0);

  // 5. Unlinking from the loan keeps the withdrawal and restores the balance.
  await ledger
    .getByTestId("loan-ledger-row")
    .filter({ hasText: `Extra repayment · ${ACCOUNT}` })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await paymentsSheet.getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(paymentsSheet).toHaveCount(0);
  await expect.poll(async () => (await payments()).length).toBe(3);
  await expect.poll(balance).toBeCloseTo(beforeExtra, 2);
  expect((await accountWithdrawals()).map((activity) => activity.id)).toContain(extra.activityId);

  // 6. Deleting the loan untags its payments and keeps the withdrawals.
  await ok(await page.request.delete(`${api}/alternative-assets/${loanId}`));
  const remaining = await accountWithdrawals();
  expect(remaining.map((activity) => activity.id)).toEqual(
    expect.arrayContaining([...withdrawals, extra.activityId]),
  );
  expect(remaining.filter((activity) => activity.metadata?.loan_payment)).toEqual([]);
});

test("a withdrawal for an extra repayment already recorded counts once", async ({ page }) => {
  test.setTimeout(120_000);
  await completeOnboardingIfNeeded(page);
  const accountId = await spendingAccount(page, "Lump sum chequing");
  const loanName = "Mortgage with a recorded extra";
  const loanId = await createLoan(page, loanName);
  await ok(
    await page.request.post(`${api}/loans/${loanId}/actions`, {
      data: { type: "extra_repayment", date: "2025-03-15", amount: 250 },
    }),
  );
  const balance = async () => Number((await loanHolding(page, loanId)).marketValue);
  const events = async () => {
    const raw = (await loanHolding(page, loanId)).metadata.loan_events;
    return (typeof raw === "string" ? JSON.parse(raw) : (raw ?? [])) as { type: string }[];
  };
  const payments = async () =>
    json<LoanPayment[]>(await page.request.get(`${api}/loans/${loanId}/payments`));
  const recorded = await balance();
  const comment = "Lump sum to the mortgage";
  const withdrawal = await withdraw(page, accountId, "2025-03-15", 250, comment);

  await page.goto(`${BASE_URL}/activities?tab=spending&from=2025-03-01&to=2025-03-31`);
  const row = page.getByRole("row").filter({ hasText: comment });
  await row.getByRole("button", { name: "Row actions" }).click();
  await page.getByRole("menuitem", { name: "Loan payment…" }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("combobox", { name: "Loan" }).click();
  await page.getByRole("option", { name: loanName }).click();
  await sheet.getByRole("button", { name: "Link", exact: true }).click();
  // Linking as is would count the same 250 twice, so nothing is saved yet.
  await expect(sheet.getByRole("alert")).toContainText(
    "An extra repayment of this amount is already recorded on this day.",
  );
  expect(await payments()).toEqual([]);
  expect((await events()).map((event) => event.type)).toContain("extra_repayment");

  await sheet.getByRole("button", { name: "Use this withdrawal instead", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect
    .poll(async () => (await payments()).map((p) => [p.activityId, p.appliesTo, p.amount]))
    .toEqual([[withdrawal, "extra", 250]]);
  expect((await events()).map((event) => event.type)).not.toContain("extra_repayment");
  await expect.poll(balance).toBeCloseTo(recorded, 2);
});
