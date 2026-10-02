import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";

test.use({ actionTimeout: 15_000 });

test("active mortgage terms, previous terms and event editing stay consistent", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await completeOnboardingIfNeeded(page);
  const api = `${BASE_URL}/api/v1`;
  const response = await page.request.post(`${api}/alternative-assets`, {
    data: {
      kind: "liability",
      name: "Mortgage event management",
      currency: "CAD",
      currentValue: "100000",
      valueDate: "2021-06-15",
      metadata: {
        sub_type: "mortgage",
        original_amount: "100000",
        origination_date: "2021-06-15",
        interest_rate: "2",
        renewal_maturity_date: "2029-06-15",
        loan_projection: JSON.stringify({
          version: 1,
          annualRate: 2,
          paymentAmount: 500,
          frequency: "monthly",
          firstPaymentDate: "2021-07-15",
          amortizationEndDate: "2046-06-15",
        }),
        loan_events: JSON.stringify([
          {
            type: "renewal",
            effectiveDate: "2023-06-15",
            annualRate: 3,
            paymentAmount: 550,
            termEndDate: "2026-06-15",
          },
          {
            type: "renewal",
            effectiveDate: "2026-06-15",
            annualRate: 3.94,
            paymentAmount: 600,
            frequency: "monthly",
            termEndDate: "2029-06-15",
          },
          { type: "extra_repayment", effectiveDate: "2026-07-01", amount: 1000 },
        ]),
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  const { assetId } = await response.json();
  const getHolding = async () =>
    (await (await page.request.get(`${api}/alternative-holdings`)).json()).find(
      (holding: { id: string }) => holding.id === assetId,
    );
  const events = async () => {
    const raw = (await getHolding()).metadata.loan_events;
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  };
  await page.goto(`${BASE_URL}/holdings/${assetId}`);
  const header = page.getByTestId("loan-summary-header");
  await expect(header).toContainText("3.94%");
  await expect(header).toContainText("600.00");
  await expect(header).toContainText("2029");
  await expect(page.getByTestId("loan-terms-history")).toHaveCount(0);
  await page.goto(`${BASE_URL}/holdings/${assetId}?tab=history`);
  const previous = page.getByTestId("loan-terms-history");
  await expect(previous).toContainText("2%");
  await expect(previous).toContainText("3%");
  await expect(previous).toContainText("3.94%");
  await previous.screenshot({ path: test.info().outputPath("loan-terms.png") });
  const ledger = page.getByRole("region", { name: "Payments & events", exact: true });
  const rows = ledger.getByTestId("loan-ledger-row");
  await ledger.getByRole("button", { name: "Add event", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Confirm balance", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Renew loan", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Extra Repayment", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();

  await ledger.getByRole("button", { name: "Upcoming", exact: true }).click();
  await expect(rows.filter({ hasText: "Payment" }).first()).toBeVisible();
  await page.goto(`${BASE_URL}/holdings/${assetId}`);

  const marker = page.getByTestId("loan-extra-repayment-marker");
  await marker.click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("heading", { name: "Edit loan event" })).toBeVisible();
  await sheet.getByLabel("Extra Repayment", { exact: true }).fill("1500");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect.poll(async () => (await events())[2].amount).toBe(1500);
  await marker.focus();
  await page.keyboard.press("Enter");
  await expect(sheet.getByLabel("Extra Repayment", { exact: true })).toHaveValue("1500");
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();

  await page.goto(`${BASE_URL}/holdings/${assetId}?tab=history`);
  await ledger.getByRole("checkbox", { name: "Events only", exact: true }).click();
  // Past events exclude the upcoming renewal date.
  await expect(rows).toHaveCount(5);
  await ledger.getByRole("button", { name: "Upcoming", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Next renewal");
  await ledger.getByRole("button", { name: "Past", exact: true }).click();
  await expect(rows).toHaveCount(5);
  await ledger.screenshot({ path: test.info().outputPath("loan-ledger-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await expect(async () => {
    await ledger.screenshot({ path: test.info().outputPath("loan-ledger-mobile.png") });
  }).toPass();
  await rows
    .filter({ hasText: "3.94%" })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  const checkSheetLayout = async () => {
    await expect(sheet).toHaveClass(/bottom-0/);
    await expect(sheet.locator("select, input[type=number]")).toHaveCount(0);
    await expect(async () => {
      const bounds = await sheet.evaluate((element) => {
        const header = element
          .querySelector('[data-testid="loan-sheet-header"]')!
          .getBoundingClientRect();
        const footer = element
          .querySelector('[data-testid="loan-sheet-footer"]')!
          .getBoundingClientRect();
        return { top: header.top, bottom: footer.bottom, height: window.innerHeight };
      });
      expect(bounds.top).toBeGreaterThanOrEqual(0);
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
    }).toPass();
    // Measure the fixed header after the sheet's entrance animation settles.
    await sheet.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished.catch(() => {})),
      );
    });
    const headerTop = await sheet
      .getByTestId("loan-sheet-header")
      .evaluate((element) => element.getBoundingClientRect().top);
    await sheet.getByTestId("loan-sheet-body").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(
      await sheet
        .getByTestId("loan-sheet-header")
        .evaluate((element) => element.getBoundingClientRect().top),
    ).toBeCloseTo(headerTop, 0);
    await expect(sheet.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport();
  };
  await checkSheetLayout();
  await page.setViewportSize({ width: 390, height: 560 });
  await checkSheetLayout();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(sheet).not.toContainText("Keep existing");
  await sheet.getByRole("button", { name: "Interest calculation", exact: true }).click();
  const methodSheet = page.getByRole("dialog", { name: "Interest calculation", exact: true });
  await methodSheet.getByRole("button", { name: "Compounded semiannually", exact: true }).click();
  await expect(async () => {
    await sheet.screenshot({ path: test.info().outputPath("loan-renewal-editor-mobile.png") });
  }).toPass();
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  for (const action of [
    "Confirm balance",
    "Extra Repayment",
    "Renew mortgage",
    "Recalculate Schedule",
    "Edit loan details",
    "Close Loan",
  ]) {
    await page.locator('button.h-9.w-9[aria-haspopup="dialog"]').click();
    await page.getByRole("button", { name: action, exact: true }).click();
    await checkSheetLayout();
    await expect(async () => {
      await sheet.screenshot({
        path: test.info().outputPath(`mobile-${action.toLowerCase().replaceAll(" ", "-")}.png`),
      });
    }).toPass();
    await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await expect(ledger.getByRole("checkbox", { name: "Events only", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const renewal = rows.filter({ hasText: "3.94%" });
  await renewal.getByRole("button", { name: "Edit", exact: true }).click();
  await sheet.getByLabel("Interest Rate", { exact: true }).fill("4.25");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(ledger).toContainText("4.25%");
  await expect.poll(async () => (await events())[1].interestMethod).toBeUndefined();
  await expect(previous).toContainText("4.25%");
  await rows
    .filter({ hasText: "Extra Repayment" })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await sheet.getByRole("button", { name: "Delete", exact: true }).click();
  await sheet.getByRole("button", { name: "Delete event", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(rows).toHaveCount(4);
  await expect(ledger.getByRole("checkbox", { name: "Events only", exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect.poll(async () => (await events()).length).toBe(2);

  await page.goto(`${BASE_URL}/holdings/${assetId}`);
  await expect(header).toContainText("4.25%");
  await expect(page.getByTestId("loan-extra-repayment-marker")).toHaveCount(0);
  await header.screenshot({ path: test.info().outputPath("loan-header-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await expect(async () => {
    await header.screenshot({ path: test.info().outputPath("loan-header-mobile.png") });
  }).toPass();
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("wf:privacy-changed", { detail: { isBalanceHidden: true } }),
    ),
  );
  await expect(header).not.toContainText("600.00");
  await expect(header).toContainText("••••");
  const recorded = await (
    await page.request.get(`${api}/market-data/quotes/history?symbol=${assetId}`)
  ).json();
  expect(recorded).toHaveLength(1);
  const removed = await page.request.delete(
    `${api}/market-data/quotes/id/${encodeURIComponent(recorded[0].id)}`,
  );
  expect(removed.ok()).toBeTruthy();
  await expect.poll(async () => (await getHolding())?.id).toBe(assetId);
  await page.reload();
  await expect(page.getByTestId("mortgage-overview")).toBeVisible();
  await expect(header).toContainText("4.25%");
});

test("extra repayment starts without an error and validates after interaction", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await completeOnboardingIfNeeded(page);
  const response = await page.request.post(`${BASE_URL}/api/v1/alternative-assets`, {
    data: {
      kind: "liability",
      name: "Repayment validation",
      currency: "CAD",
      currentValue: "100000",
      valueDate: "2026-01-01",
      metadata: {
        sub_type: "mortgage",
        original_amount: "100000",
        origination_date: "2026-01-01",
        loan_projection: JSON.stringify({
          version: 1,
          annualRate: 4,
          paymentAmount: 600,
          frequency: "monthly",
          firstPaymentDate: "2026-02-01",
          amortizationEndDate: "2046-01-01",
        }),
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  const { assetId } = await response.json();
  await page.goto(`${BASE_URL}/holdings/${assetId}`);
  const openRepayment = async () => {
    await page.locator('button.h-9.w-9[aria-haspopup="dialog"]').click();
    await page.getByRole("button", { name: "Extra Repayment", exact: true }).click();
  };
  await openRepayment();
  const dialog = page.getByRole("dialog");
  const amount = dialog.getByLabel("Repayment Amount", { exact: true });
  const submit = dialog.getByRole("button", { name: "Record Repayment", exact: true });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(submit).toBeDisabled();
  await amount.focus();
  await amount.press("Tab");
  await expect(dialog.getByRole("alert")).toBeVisible();
  await amount.fill("100");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(submit).toBeEnabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await openRepayment();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(submit).toBeDisabled();
});

// FCAC's public 100,000 / 5% / 25-year monthly example, with a cent-posted payment.
test("interest convention reaches the shared engine and survives a renewal", async ({ page }) => {
  test.setTimeout(180_000);
  await completeOnboardingIfNeeded(page);
  const api = `${BASE_URL}/api/v1`;
  const metadata = {
    sub_type: "mortgage",
    original_amount: "100000",
    origination_date: "2026-01-01",
    loan_projection: JSON.stringify({
      version: 1,
      annualRate: 5,
      paymentAmount: 581.6,
      frequency: "monthly",
      interestMethod: "semiannual",
      firstPaymentDate: "2026-02-01",
      amortizationEndDate: "2051-01-01",
    }),
  };
  const response = await page.request.post(`${api}/loans/calculate`, {
    data: {
      metadata,
      balances: [{ date: "2026-01-01", balance: 100000 }],
      asOf: "2026-02-01",
    },
  });
  expect(response.ok()).toBeTruthy();
  const calculation = await response.json();
  expect(calculation.interestMethod).toBe("semiannual");
  expect(calculation.rows[1]).toMatchObject({
    interest: 412.39,
    principal: 169.21,
    balance: 99830.79,
  });
  const created = await page.request.post(`${api}/alternative-assets`, {
    data: {
      kind: "liability",
      name: "Interest convention reference",
      currency: "CAD",
      currentValue: "100000",
      valueDate: "2026-01-01",
      metadata,
    },
  });
  expect(created.ok()).toBeTruthy();
  const { assetId } = await created.json();
  await page.goto(`${BASE_URL}/holdings/${assetId}`);
  await page.locator('button.h-9.w-9[aria-haspopup="dialog"]').click();
  await page.getByRole("button", { name: "Renew mortgage", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").filter({ hasText: "Compounded semiannually" }).click();
  await page.getByRole("option", { name: "Compounded monthly", exact: true }).click();
  await dialog.getByRole("button", { name: "Renew mortgage", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect
    .poll(async () => {
      const holdings = await (await page.request.get(`${api}/alternative-holdings`)).json();
      const holding = holdings.find((h: { id: string }) => h.id === assetId);
      const events =
        typeof holding.metadata.loan_events === "string"
          ? JSON.parse(holding.metadata.loan_events)
          : holding.metadata.loan_events;
      return events?.at(-1)?.interestMethod;
    })
    .toBe("monthly");
  await page.reload();
  await expect(
    page.getByTestId("loan-payoff-card").getByRole("button", { name: /calculated since/i }),
  ).toBeVisible();
});

test("balance edits preserve notes, reject collisions and delete legacy corrections", async ({
  page,
}) => {
  await completeOnboardingIfNeeded(page);
  const api = `${BASE_URL}/api/v1`;
  const response = await page.request.post(`${api}/alternative-assets`, {
    data: {
      kind: "liability",
      name: "Balance editing regression",
      currency: "CAD",
      currentValue: "1200",
      valueDate: "2026-01-01",
      metadata: {
        sub_type: "mortgage",
        original_amount: "1200",
        origination_date: "2026-01-01",
        loan_projection: JSON.stringify({
          version: 1,
          annualRate: 0,
          paymentAmount: 100,
          frequency: "monthly",
          firstPaymentDate: "2026-02-01",
          amortizationEndDate: "2027-01-01",
        }),
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  const { assetId } = await response.json();
  const quoteResponse = await page.request.put(`${api}/market-data/quotes/${assetId}`, {
    data: {
      id: "",
      assetId,
      timestamp: "2026-03-15T00:00:00Z",
      createdAt: new Date().toISOString(),
      open: 500,
      high: 500,
      low: 500,
      close: 500,
      adjclose: 500,
      volume: 0,
      currency: "CAD",
      dataSource: "MANUAL",
      notes: "loan_event|type=balance_correction",
    },
  });
  expect(quoteResponse.ok()).toBeTruthy();
  const quotes = async () =>
    (await page.request.get(`${api}/market-data/quotes/history?symbol=${assetId}`)).json();
  await page.goto(`${BASE_URL}/holdings/${assetId}?tab=history&events=only`);
  const row = page
    .getByTestId("loan-ledger-row")
    .filter({ hasText: "Balance confirmed" })
    .filter({ hasText: "500.00" });
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await sheet.locator('input[type="date"]').first().fill("2026-01-01");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sheet).toContainText("A balance already exists on this date");
  expect(await quotes()).toHaveLength(2);
  await sheet.locator('input[type="date"]').first().fill("2026-03-15");
  await sheet.getByLabel("Notes", { exact: true }).fill("Checked against statement");
  await sheet.getByRole("button", { name: "Save", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(sheet.getByLabel("Notes", { exact: true })).toHaveValue("Checked against statement");
  await sheet.getByRole("button", { name: "Delete", exact: true }).click();
  await sheet.getByRole("button", { name: "Delete event", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(row).toHaveCount(0);
  const holdings = await (await page.request.get(`${api}/alternative-holdings`)).json();
  const holding = holdings.find((entry: { id: string }) => entry.id === assetId);
  const metadata = holding.metadata;
  // A confirmed balance is only a quote; deleting it leaves the loan terms untouched.
  expect(metadata.loan_events).toBeUndefined();
  const result = await page.request.post(`${api}/loans/calculate`, {
    data: {
      metadata,
      balances: (await quotes()).map((q: { timestamp: string; close: number; notes?: string }) => ({
        date: q.timestamp.slice(0, 10),
        balance: q.close,
        notes: q.notes,
      })),
      asOf: "2026-03-16",
    },
  });
  expect((await result.json()).currentBalance).toBe(1000);
});

test("recalculation endpoint follows changed cadence and settles the horizon", async ({ page }) => {
  await completeOnboardingIfNeeded(page);
  const response = await page.request.post(`${BASE_URL}/api/v1/loans/recalculate`, {
    data: {
      metadata: {
        loan_projection: {
          version: 1,
          annualRate: 0,
          paymentAmount: 100,
          frequency: "monthly",
          firstPaymentDate: "2026-02-01",
          amortizationEndDate: "2026-05-01",
        },
        loan_events: [
          { type: "payment_frequency_change", effectiveDate: "2026-02-10", frequency: "biweekly" },
        ],
      },
      balances: [{ date: "2026-01-01", balance: 1200 }],
      asOf: "2026-03-01",
      annualRate: 0,
    },
  });
  expect(response.ok()).toBeTruthy();
  expect(await response.json()).toEqual({
    currentBalance: 1000,
    paymentAmount: 250,
    remainingPayments: 4,
  });
});

test("backdated renewal inherits historical frequency and interest convention", async ({
  page,
}) => {
  await completeOnboardingIfNeeded(page);
  const api = `${BASE_URL}/api/v1`;
  const response = await page.request.post(`${api}/alternative-assets`, {
    data: {
      kind: "liability",
      name: "Historical renewal regression",
      currency: "CAD",
      currentValue: "1200",
      valueDate: "2026-01-01",
      metadata: {
        sub_type: "mortgage",
        original_amount: "1200",
        origination_date: "2026-01-01",
        loan_projection: JSON.stringify({
          version: 1,
          annualRate: 0,
          paymentAmount: 100,
          frequency: "monthly",
          interestMethod: "semiannual",
          firstPaymentDate: "2026-02-01",
          amortizationEndDate: "2027-01-01",
        }),
        loan_events: JSON.stringify([
          {
            type: "renewal",
            effectiveDate: "2026-06-10",
            annualRate: 0,
            frequency: "biweekly",
            interestMethod: "monthly",
          },
        ]),
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  const { assetId } = await response.json();
  await page.goto(`${BASE_URL}/holdings/${assetId}?tab=history`);
  await page.getByRole("button", { name: "Add event", exact: true }).click();
  await page.getByRole("menuitem", { name: "Renew loan", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await expect(sheet.getByRole("combobox", { name: "Interest calculation" })).toContainText(
    "Compounded monthly",
  );
  await sheet.locator('input[type="date"]').first().fill("2026-03-10");
  await expect(sheet.getByRole("combobox", { name: "Interest calculation" })).toContainText(
    "Compounded semiannually",
  );
  await sheet.getByRole("button", { name: "Renew mortgage", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  const holdings = await (await page.request.get(`${api}/alternative-holdings`)).json();
  const metadata = holdings.find((holding: { id: string }) => holding.id === assetId).metadata;
  const events = JSON.parse(metadata.loan_events);
  const renewal = events.find(
    (event: { effectiveDate: string }) => event.effectiveDate === "2026-03-10",
  );
  expect(renewal.frequency).toBeUndefined();
  expect(renewal.interestMethod).toBeUndefined();
  const calculated = await page.request.post(`${api}/loans/calculate`, {
    data: { metadata, balances: [{ date: "2026-01-01", balance: 1200 }], asOf: "2026-05-31" },
  });
  expect((await calculated.json()).currentBalance).toBe(800);
});

test("property deletion and mortgage linking preserve the loan and its history", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await completeOnboardingIfNeeded(page);
  const api = `${BASE_URL}/api/v1`;
  const create = async (data: Record<string, unknown>) => {
    const response = await page.request.post(`${api}/alternative-assets`, { data });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).assetId as string;
  };
  const property = () =>
    create({
      kind: "property",
      name: "Property deletion regression",
      currency: "CAD",
      currentValue: "2000",
      valueDate: "2026-01-01",
    });
  const propertyId = await property();
  const metadata = {
    sub_type: "mortgage",
    original_amount: "1200",
    origination_date: "2026-01-01",
    loan_projection: JSON.stringify({
      version: 1,
      annualRate: 0,
      paymentAmount: 100,
      frequency: "monthly",
      firstPaymentDate: "2026-02-01",
      paymentCount: 12,
    }),
    loan_events: JSON.stringify([
      { type: "extra_repayment", effectiveDate: "2026-03-01", amount: 50 },
    ]),
  };
  const loanId = await create({
    kind: "liability",
    name: "Preserved mortgage",
    currency: "CAD",
    currentValue: "1200",
    valueDate: "2026-01-01",
    metadata,
    linkedAssetId: propertyId,
  });
  const holdings = async () => (await page.request.get(`${api}/alternative-holdings`)).json();
  const loan = async () => (await holdings()).find((entry: { id: string }) => entry.id === loanId);
  const quotes = async () =>
    (await page.request.get(`${api}/market-data/quotes/history?symbol=${loanId}`)).json();
  const before = await loan();
  const beforeQuotes = await quotes();
  await page.goto(`${BASE_URL}/holdings/${propertyId}`);
  await page.locator('button.h-9.w-9[aria-haspopup="dialog"]').click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete", exact: true }).click();
  await expect
    .poll(async () => (await holdings()).some((entry: { id: string }) => entry.id === propertyId))
    .toBe(false);
  const after = await loan();
  expect(after).toBeDefined();
  expect(after.linkedAssetId).toBeNull();
  expect(after.metadata).toMatchObject(metadata);
  expect(after.marketValue).toBe(before.marketValue);
  expect(await quotes()).toEqual(beforeQuotes);
  await page.goto(`${BASE_URL}/holdings/${loanId}`);
  await expect(page.getByTestId("mortgage-overview")).toBeVisible();

  const replacement = await property();
  expect(
    (
      await page.request.post(`${api}/alternative-assets/${loanId}/link-liability`, {
        data: { targetAssetId: replacement },
      })
    ).ok(),
  ).toBeTruthy();
  expect((await loan()).metadata).toMatchObject({ ...metadata, linked_asset_id: replacement });
  expect(
    (await page.request.delete(`${api}/alternative-assets/${loanId}/link-liability`)).ok(),
  ).toBeTruthy();
  expect((await loan()).linkedAssetId).toBeNull();
  expect((await loan()).metadata).toMatchObject(metadata);
  expect(await quotes()).toEqual(beforeQuotes);

  // A loan without remaining confirmations must also survive unlink-on-delete.
  expect(
    (
      await page.request.post(`${api}/alternative-assets/${loanId}/link-liability`, {
        data: { targetAssetId: replacement },
      })
    ).ok(),
  ).toBeTruthy();
  for (const quote of beforeQuotes) {
    expect(
      (await page.request.delete(`${api}/market-data/quotes/id/${quote.id}`)).ok(),
    ).toBeTruthy();
  }
  expect((await page.request.delete(`${api}/alternative-assets/${replacement}`)).ok()).toBeTruthy();
  expect((await loan()).metadata).toMatchObject(metadata);
  expect((await loan()).linkedAssetId).toBeNull();
  expect((await loan()).marketValue).toBe(before.marketValue);
  await page.goto(`${BASE_URL}/holdings/${loanId}`);
  await expect(page.getByTestId("mortgage-overview")).toBeVisible();
});
