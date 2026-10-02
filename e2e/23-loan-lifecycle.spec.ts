import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";
import fixtures from "../crates/core/src/assets/loan/fixtures.json" with { type: "json" };

const fixture = fixtures.lifecycle;

test.use({ actionTimeout: 15_000 });

async function netWorthAt(page: Page, date: string) {
  const api = `${BASE_URL}/api/v1`;
  const response = await page.request.get(`${api}/net-worth?date=${date}`);
  expect(response.ok()).toBeTruthy();
  const worth = await response.json();
  const historyResponse = await page.request.get(
    `${api}/net-worth/history?startDate=${date}&endDate=${date}`,
  );
  expect(historyResponse.ok()).toBeTruthy();
  const history = await historyResponse.json();
  return {
    liabilities: Number(worth.liabilities.total),
    netWorth: Number(worth.netWorth),
    historyLiabilities: Number(history.at(-1)?.totalLiabilities ?? 0),
    historyNetWorth: Number(history.at(-1)?.netWorth ?? 0),
  };
}

// One real persisted loan, driven through its lifecycle by the UI. Financial
// expectations come from the shared independent worksheet, never from the API.
test("loan lifecycle matches the independent fixture in the page and net worth", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.clock.setFixedTime(new Date("2025-01-01T12:00:00"));
  await completeOnboardingIfNeeded(page);
  const api = `${BASE_URL}/api/v1`;
  // The full suite shares a profile: loan assertions must tolerate unrelated holdings.
  for (const kind of ["property", "liability"] as const) {
    const background = await page.request.post(`${api}/alternative-assets`, {
      data: {
        kind,
        name: `Fixture background ${kind}`,
        currency: "CAD",
        currentValue: kind === "property" ? "2000" : "200",
        valueDate: "2024-01-01",
        metadata: { tracking_mode: "manual" },
      },
    });
    expect(background.ok()).toBeTruthy();
  }
  const baseline = new Map<string, Awaited<ReturnType<typeof netWorthAt>>>();
  for (const date of new Set(fixture.stages.map((entry) => entry.asOf))) {
    baseline.set(date, await netWorthAt(page, date));
  }
  const sheet = page.getByRole("dialog");
  await page.goto(`${BASE_URL}/holdings?tab=assets`);
  await page.locator('button.h-9.w-9[aria-haspopup="dialog"]').click();
  await page.getByRole("button", { name: "Add Asset", exact: true }).click();
  await sheet.getByRole("button", { name: /Liability.*Loans/ }).click();
  await sheet.getByRole("button", { name: "Continue", exact: true }).click();
  await sheet.getByPlaceholder("Home Mortgage, Car Loan...").fill("Lifecycle fixture");
  await sheet
    .getByText("Original Amount", { exact: true })
    .locator("..")
    .getByPlaceholder("0.00")
    .fill(fixture.metadata.original_amount);
  await sheet.locator('input[type="date"]').first().fill(fixture.metadata.origination_date);
  await sheet.getByPlaceholder("0", { exact: true }).first().fill("12");
  await sheet.getByPlaceholder("0", { exact: true }).last().fill("1");
  await sheet.getByRole("button", { name: "Add Liability", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  const allHoldings = async () => (await page.request.get(`${api}/alternative-holdings`)).json();
  const created = (await allHoldings()).find(
    (holding: { name: string }) => holding.name === "Lifecycle fixture",
  );
  const assetId: string = created.id;
  expect(JSON.parse(created.metadata.loan_projection).paymentAmount).toBe(
    fixture.metadata.loan_projection.paymentAmount,
  );
  const holding = async () =>
    (await allHoldings()).find((entry: { id: string }) => entry.id === assetId);
  const quotes = async () =>
    (await page.request.get(`${api}/market-data/quotes/history?symbol=${assetId}`)).json();
  const stage = (id: string) => fixture.stages.find((entry) => entry.id === id)!;
  const checkpoint = async (id: string) => {
    const expected = stage(id);
    await page.clock.setFixedTime(new Date(`${expected.asOf}T12:00:00`));
    await page.goto(`${BASE_URL}/holdings/${assetId}`);
    const balanceText = expected.expected.balance.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    await expect(
      page.getByTestId("mortgage-overview").locator('[aria-label="Mortgage timeline"]'),
    ).toContainText(balanceText);
    const metadata = (await holding()).metadata;
    const response = await page.request.post(`${api}/loans/calculate`, {
      data: {
        metadata,
        asOf: expected.asOf,
        balances: (await quotes()).map(
          (q: { timestamp: string; close: number; notes?: string }) => ({
            date: q.timestamp.slice(0, 10),
            balance: Number(q.close),
            notes: q.notes,
          }),
        ),
      },
    });
    expect(response.ok()).toBeTruthy();
    const calculation = await response.json();
    expect(calculation.currentBalance).toBe(expected.expected.balance);
    expect(calculation.interestToDate).toBe(expected.expected.interestToDate);
    expect(calculation.payoffDate).toBe(expected.expected.payoffDate);
    const before = baseline.get(expected.asOf)!;
    const after = await netWorthAt(page, expected.asOf);
    expect(after.liabilities - before.liabilities).toBeCloseTo(expected.expected.balance, 2);
    expect(after.netWorth - before.netWorth).toBeCloseTo(expected.expected.netWorth, 2);
    expect(after.historyLiabilities - before.historyLiabilities).toBeCloseTo(
      expected.expected.balance,
      2,
    );
    expect(after.historyNetWorth - before.historyNetWorth).toBeCloseTo(
      expected.expected.netWorth,
      2,
    );
  };
  const history = async () => {
    await page.goto(`${BASE_URL}/holdings/${assetId}?tab=history&events=only`);
  };
  const addEvent = async (name: string) => {
    await history();
    await page.getByRole("button", { name: "Add event", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  };
  const saveSheet = async (name: string) => {
    await sheet.getByRole("button", { name, exact: true }).click();
    await expect(sheet).toHaveCount(0);
  };
  await checkpoint("created");
  await checkpoint("payments");
  await addEvent("Extra Repayment");
  await sheet.locator('input[type="date"]').first().fill(fixture.events.extra.effectiveDate);
  await sheet
    .getByLabel("Repayment Amount", { exact: true })
    .fill(String(fixture.events.extra.amount));
  await saveSheet("Record Repayment");
  await checkpoint("extra");
  await page.clock.setFixedTime(new Date("2025-04-01T12:00:00"));
  await addEvent("Confirm balance");
  await sheet.locator('input[type="date"]').first().fill("2025-04-01");
  await sheet.locator("input").last().fill("800");
  await saveSheet("Confirm balance");
  await checkpoint("confirmed");
  await page.clock.setFixedTime(new Date("2025-06-15T12:00:00"));
  for (const [id, event] of [
    ["renewed", fixture.events.renewal],
    ["backdated", fixture.events.olderRenewal],
  ] as const) {
    await addEvent("Renew loan");
    await sheet.locator('input[type="date"]').first().fill(event.effectiveDate);
    await sheet.getByLabel("New Annual Rate (%)", { exact: true }).fill(String(event.annualRate));
    if ("paymentAmount" in event)
      await sheet.getByLabel("Payment", { exact: true }).fill(String(event.paymentAmount));
    await sheet.locator('input[type="date"]').last().fill(event.termEndDate);
    await saveSheet("Renew loan");
    expect((await holding()).metadata.renewal_maturity_date).toBe(
      fixture.events.renewal.termEndDate,
    );
    await checkpoint(id);
  }
  await history();
  const rows = page.getByTestId("loan-ledger-row");
  await rows
    .filter({ hasText: "Extra Repayment" })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await sheet.getByLabel("Extra Repayment", { exact: true }).fill("150");
  await saveSheet("Save");
  await checkpoint("extraEdited");
  const editBalance = async (amount: string) => {
    await history();
    await rows
      .filter({ hasText: "Balance confirmed" })
      .filter({ hasText: amount })
      .getByRole("button", { name: "Edit", exact: true })
      .click();
  };
  const removeBalance = async () => {
    await sheet.getByRole("button", { name: "Delete", exact: true }).click();
    await saveSheet("Delete event");
  };
  await editBalance("800.00");
  await removeBalance();
  await checkpoint("confirmationDeleted");
  await editBalance("1,200.00");
  await sheet.getByLabel("Confirmed balance", { exact: true }).fill("1300");
  await saveSheet("Save");
  await checkpoint("openingEdited");
  await editBalance("1,300.00");
  await removeBalance();
  await checkpoint("openingDeleted");
  await checkpoint("paidOff");
  expect(await quotes()).toHaveLength(0);
});

// Uses the real server and isolated installation prepared by run-e2e.mjs.
test("loan estimates, dated actions and net worth stay consistent", async ({ page }) => {
  test.setTimeout(180_000);
  await completeOnboardingIfNeeded(page);
  const api = `${BASE_URL}/api/v1`;
  const now = new Date();
  const day = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const origin = day(new Date(now.getFullYear(), now.getMonth() - 2, 1));
  const first = day(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const end = day(new Date(now.getFullYear(), now.getMonth() + 10, 1));
  const baseline = await netWorthAt(page, day(now));
  const created = await page.request.post(`${api}/alternative-assets`, {
    data: {
      kind: "liability",
      name: "Automatic loan regression",
      currency: "CAD",
      currentValue: "1200",
      valueDate: origin,
      metadata: {
        sub_type: "mortgage",
        original_amount: "1200",
        origination_date: origin,
        loan_projection: JSON.stringify({
          version: 1,
          annualRate: 0,
          paymentAmount: 100,
          frequency: "monthly",
          firstPaymentDate: first,
          amortizationEndDate: end,
        }),
      },
    },
  });
  expect(created.ok()).toBeTruthy();
  const { assetId } = await created.json();
  const holdings = async () =>
    (await (await page.request.get(`${api}/alternative-holdings`)).json()).find(
      (h: { id: string }) => h.id === assetId,
    );
  expect(Number((await holdings()).marketValue)).toBe(1000);
  const quotes = async () =>
    (
      await page.request.get(
        `${api}/market-data/quotes/history?symbol=${encodeURIComponent(assetId)}`,
      )
    ).json();
  expect(await quotes()).toHaveLength(1);
  const openActions = () => page.locator('button.h-9.w-9[aria-haspopup="dialog"]').click();

  await page.goto(`${BASE_URL}/holdings/${assetId}?tab=history`);
  await openActions();
  await page.getByRole("button", { name: "Renew mortgage", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("Renewal maturity", { exact: true }),
  ).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();

  await openActions();
  await page.getByRole("button", { name: "Extra Repayment", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("input").last().fill("50");
  await dialog.getByRole("button", { name: "Record Repayment" }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => Number((await holdings()).marketValue)).toBe(950);
  expect(await quotes()).toHaveLength(1);
  const holding = await holdings();
  const events =
    typeof holding.metadata.loan_events === "string"
      ? JSON.parse(holding.metadata.loan_events)
      : holding.metadata.loan_events;
  expect(events.at(-1)).toMatchObject({ type: "extra_repayment", amount: 50 });
  const after = await netWorthAt(page, day(now));
  expect(after.liabilities - baseline.liabilities).toBeCloseTo(950, 2);
  expect(after.historyLiabilities - baseline.historyLiabilities).toBeCloseTo(950, 2);
  await page.reload();
  await openActions();
  await expect(page.getByRole("button", { name: "Renew mortgage", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  const calculate = async () => {
    const h = await holdings();
    const balances = (await quotes()).map(
      (q: { timestamp: string; close: number; notes?: string }) => ({
        date: q.timestamp.slice(0, 10),
        balance: Number(q.close),
        notes: q.notes,
      }),
    );
    return (
      await page.request.post(`${api}/loans/calculate`, {
        data: { metadata: h.metadata, balances, asOf: day(now) },
      })
    ).json();
  };
  const before = await calculate();
  await openActions();
  await page.getByRole("button", { name: "Recalculate Schedule", exact: true }).click();
  await dialog.getByLabel("New Annual Rate (%)", { exact: true }).fill("12");
  await dialog.getByRole("button", { name: "Recalculate", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const recalculated = await calculate();
  expect(recalculated.annualRate).toBe(12);
  expect(recalculated.paymentAmount).not.toBe(100);
  expect(recalculated.rows.filter((r: { date: string }) => r.date < day(now))).toEqual(
    before.rows.filter((r: { date: string }) => r.date < day(now)),
  );
  expect(await quotes()).toHaveLength(1);

  await openActions();
  await page.getByRole("button", { name: "Renew mortgage", exact: true }).click();
  await dialog.getByLabel("New Annual Rate (%)", { exact: true }).fill("24");
  await dialog.getByLabel("Payment", { exact: true }).fill("150");
  const maturity = day(new Date(now.getFullYear(), now.getMonth() + 1, 1));
  await dialog.locator('input[type="date"]').last().fill(maturity);
  await dialog.getByRole("button", { name: "Renew loan", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const renewed = await calculate();
  expect(renewed.annualRate).toBe(24);
  expect(renewed.paymentAmount).toBe(150);
  expect(renewed.rows.filter((r: { date: string }) => r.date < day(now))).toEqual(
    before.rows.filter((r: { date: string }) => r.date < day(now)),
  );
  const projection = (await holdings()).metadata.loan_projection;
  expect(
    (typeof projection === "string" ? JSON.parse(projection) : projection).amortizationEndDate,
  ).toBe(end);
  expect((await holdings()).metadata.renewal_maturity_date).toBe(maturity);
  expect(renewed.rows.at(-1).date > maturity).toBeTruthy();
  expect(await quotes()).toHaveLength(1);

  await page.goto(`${BASE_URL}/holdings/${assetId}?tab=overview`);
  const outlook = page.getByRole("region", { name: "Mortgage timeline" });
  await expect(outlook).toBeVisible();
  const overview = page.getByTestId("mortgage-overview");
  await expect(overview).toBeVisible();
  await expect(overview.getByRole("button", { name: "Confirm balance", exact: true })).toHaveCount(
    0,
  );
  await openActions();
  await page.getByRole("button", { name: "Confirm balance", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Confirm balance" })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

  await expect(overview.getByText("Balance at renewal", { exact: true })).toBeVisible();
  const paymentsUntilRenewal = renewed.rows.filter(
    (row: { date: string; scheduledPayment: boolean }) =>
      row.date > day(now) && row.date <= maturity && row.scheduledPayment,
  ).length;
  await expect(
    overview
      .getByTestId("loan-term-card")
      .getByText("Payments left", { exact: true })
      .locator("..")
      .locator("dd"),
  ).toHaveText(String(paymentsUntilRenewal));
  await expect(outlook.getByRole("group", { name: "Chart view" })).toHaveCount(0);
  await expect(outlook.locator("details")).toHaveCount(0);
  const extraMarker = outlook.getByTestId("loan-extra-repayment-marker");
  await expect(extraMarker).toHaveCount(1);
  await extraMarker.hover();
  await expect(page.getByRole("tooltip")).toContainText("Extra Repayment");
  await expect(page.getByRole("tooltip")).toContainText("50.00");
  await page.mouse.move(0, 0);
  await extraMarker.focus();
  await expect(page.getByRole("tooltip")).toContainText("50.00");
  await page.keyboard.press("Escape");
  const renewalMarkers = outlook.getByTestId("loan-renewal-marker");
  await expect(renewalMarkers.first()).toBeVisible();
  await renewalMarkers.last().focus();
  await expect(page.getByRole("tooltip")).toContainText("Next renewal");
  await page.keyboard.press("Escape");
  await outlook.screenshot({ path: test.info().outputPath("renewal-outlook-desktop.png") });
  await overview.screenshot({ path: test.info().outputPath("mortgage-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(outlook).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await expect(outlook.getByRole("group", { name: "Chart view" })).toHaveCount(0);
  await expect(outlook.locator("details")).toHaveCount(0);

  await expect(extraMarker).toHaveCount(1);
  await extraMarker.hover();
  await expect(page.getByRole("tooltip")).toContainText("Extra Repayment");
  await expect(page.getByRole("tooltip")).toContainText("50.00");
  await page.mouse.move(0, 0);
  await extraMarker.focus();
  await expect(page.getByRole("tooltip")).toContainText("50.00");
  await page.keyboard.press("Escape");
  await outlook.screenshot({ path: test.info().outputPath("renewal-outlook-mobile.png") });
  await overview.screenshot({ path: test.info().outputPath("mortgage-mobile.png") });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("wf:privacy-changed", { detail: { isBalanceHidden: true } }),
    ),
  );
  await expect(outlook.locator("p").first()).toContainText("••••");
  await expect(outlook.locator("svg")).toHaveCount(0);
  await page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("wf:privacy-changed", { detail: { isBalanceHidden: false } }),
    ),
  );

  await outlook.getByTitle("All Time", { exact: true }).click();
  await expect(outlook.getByTestId("loan-period-change")).not.toContainText("Unavailable");
  await outlook.getByTitle("year to date", { exact: true }).click();
  await expect(outlook.getByTestId("loan-period-change")).toContainText("Unavailable");

  await page.goto(`${BASE_URL}/holdings/${assetId}?tab=history`);

  // Correct original terms after a renewal: base estimates change, observations/events survive.
  const confirmedBeforeEdit = await quotes();
  const eventsBeforeEdit = (await holdings()).metadata.loan_events;
  await openActions();
  await page.getByRole("button", { name: "Correct original terms", exact: true }).click();
  const details = page.getByRole("dialog");
  await expect(details.getByLabel("Original Amount", { exact: true })).toBeEnabled();
  await details.getByLabel("Original Amount", { exact: true }).fill("1300");
  await details.getByLabel("Interest Rate (%)", { exact: true }).fill("6");
  await details.getByLabel("Payment", { exact: true }).fill("110");
  await expect(details.locator('input[type="date"]')).toHaveCount(4);
  const dates = details.locator('input[type="date"]');
  await expect(dates.nth(0)).toBeEnabled();
  await dates.nth(1).fill(day(new Date(now.getFullYear(), now.getMonth() + 12, 1)));
  await expect(dates.nth(2)).toBeEnabled();
  await details.getByRole("button", { name: "Save Details", exact: true }).click();
  await expect(details).not.toBeVisible();
  const correctedTerms = await calculate();
  const correctedHolding = await holdings();
  expect(correctedHolding.metadata.original_amount).toBe("1300");
  expect(JSON.parse(correctedHolding.metadata.loan_projection)).toMatchObject({
    annualRate: 6,
    paymentAmount: 110,
  });
  expect(correctedHolding.metadata.loan_events).toEqual(eventsBeforeEdit);
  expect(await quotes()).toEqual(confirmedBeforeEdit);
  expect(correctedTerms.annualRate).toBe(24); // the dated renewal still wins today
  expect(correctedTerms.paymentAmount).toBe(150);
  expect(correctedTerms.rows.filter((r: { date: string }) => r.date < day(now))).not.toEqual(
    renewed.rows.filter((r: { date: string }) => r.date < day(now)),
  );

  await page.screenshot({ path: test.info().outputPath("loan-history.png"), fullPage: true });
  await openActions();
  await page.getByRole("button", { name: "Confirm balance", exact: true }).click();
  await dialog.locator("input").last().fill("800");
  await dialog.getByRole("button", { name: "Confirm balance", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => Number((await holdings()).marketValue)).toBe(800);
  const ledger = page.getByRole("region", { name: "Payments & events", exact: true });
  await expect(
    ledger.getByTestId("loan-ledger-row").filter({ hasText: "Balance confirmed" }),
  ).toHaveCount(2); // Opening confirmation and today's confirmation.
  await openActions();
  await page.getByRole("button", { name: "Close Loan", exact: true }).click();
  await dialog.getByRole("button", { name: "Close Loan", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => Number((await holdings()).marketValue)).toBe(0);
  expect((await calculate()).remainingPayments).toBe(0);
  await page.goto(`${BASE_URL}/holdings?tab=assets`);
  await page.locator('button.h-9.w-9[aria-haspopup="dialog"]').click();
  await page.getByRole("button", { name: "Add Asset", exact: true }).click();
  await dialog.getByRole("button", { name: /Liability.*Loans/ }).click();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog
    .getByPlaceholder("Home Mortgage, Car Loan...")
    .fill("Accelerated creation regression");
  await dialog
    .getByText("Original Amount", { exact: true })
    .locator("..")
    .getByPlaceholder("0.00")
    .fill("1200");
  await dialog.locator('input[type="date"]').first().fill(origin);
  await dialog.getByPlaceholder("0", { exact: true }).last().fill("1");
  await dialog.getByRole("combobox").filter({ hasText: "Monthly" }).click();
  await page.getByRole("option", { name: "Accelerated biweekly", exact: true }).click();
  await expect(dialog.getByText("First payment date", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Add Liability", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const accelerated = (await (await page.request.get(`${api}/alternative-holdings`)).json()).find(
    (h: { name: string }) => h.name === "Accelerated creation regression",
  );
  expect(Number(accelerated.marketValue)).toBeLessThan(1200);
  const terms = JSON.parse(accelerated.metadata.loan_projection);
  expect(terms).toMatchObject({ version: 1, frequency: "accelerated_biweekly" });
  expect(terms.firstPaymentDate > origin).toBeTruthy();
  const recorded = await (
    await page.request.get(
      `${api}/market-data/quotes/history?symbol=${encodeURIComponent(accelerated.id)}`,
    )
  ).json();
  expect(recorded).toHaveLength(1);
  expect(recorded[0].timestamp.slice(0, 10)).toBe(origin);
  expect(Number(recorded[0].close)).toBe(1200);
});

test("mortgage presentation stays separate from other assets and manual liabilities", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await completeOnboardingIfNeeded(page);
  const api = `${BASE_URL}/api/v1`;
  const now = new Date();
  const day = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const origin = day(new Date(now.getFullYear(), now.getMonth() - 2, 1));
  const first = day(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const end = day(new Date(now.getFullYear() + 1, now.getMonth(), 1));
  const create = async (kind: string, name: string, metadata: Record<string, string>) => {
    const response = await page.request.post(`${api}/alternative-assets`, {
      data: { kind, name, currency: "CAD", currentValue: "1200", valueDate: origin, metadata },
    });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).assetId;
  };
  const loanMetadata = {
    original_amount: "1200",
    origination_date: origin,
    loan_projection: JSON.stringify({
      version: 1,
      annualRate: 0,
      paymentAmount: 100,
      frequency: "monthly",
      firstPaymentDate: first,
      amortizationEndDate: end,
    }),
  };
  const car = await create("liability", "Car loan UX regression", {
    ...loanMetadata,
    sub_type: "auto_loan",
  });
  await page.goto(`${BASE_URL}/holdings/${car}`);
  await expect(page.getByTestId("loan-overview")).toBeVisible();
  await expect(page.getByRole("button", { name: "Full term", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Renew mortgage", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Until renewal", exact: true })).toHaveCount(0);

  await page.goto(`${BASE_URL}/holdings/${car}?tab=history`);
  const terms = page.getByTestId("loan-terms-history");
  const todayMarker = terms.getByTestId("loan-term-today");
  await expect(todayMarker).toContainText("Today");
  await expect(terms).toContainText("Current term");
  const markerPosition = await todayMarker.evaluate((element) => parseFloat(element.style.left));
  expect(markerPosition).toBeGreaterThan(0);
  expect(markerPosition).toBeLessThan(100);
  await terms.screenshot({ path: test.info().outputPath("car-term-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(todayMarker).toBeVisible();
  await expect(async () => {
    await terms.screenshot({ path: test.info().outputPath("car-term-mobile.png") });
  }).toPass();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
  ).toBeTruthy();
  await page.setViewportSize({ width: 1280, height: 720 });

  const card = await create("liability", "Manual card UX regression", {
    sub_type: "credit_card",
    tracking_mode: "manual",
  });
  await page.goto(`${BASE_URL}/holdings/${card}`);
  await expect(page.getByTestId("loan-overview")).toBeVisible();
  await expect(page.getByRole("button", { name: "Full term", exact: true })).toHaveCount(0);
  await expect(page.getByText("Estimated payoff", { exact: true })).toHaveCount(0);
  await page.locator('button.h-9.w-9[aria-haspopup="dialog"]').click();
  await page.getByRole("button", { name: "Confirm balance", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "Confirm balance" }),
  ).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();

  const property = await create("property", "Property UX regression", {
    purchase_price: "1200",
    purchase_date: origin,
  });
  await page.goto(`${BASE_URL}/holdings/${property}`);
  await expect(page.getByTestId("mortgage-overview")).toHaveCount(0);
  await expect(page.getByTestId("loan-overview")).toHaveCount(0);
  await page.locator('button.h-9.w-9[aria-haspopup="dialog"]').click();
  await expect(page.getByRole("button", { name: "Update Value", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Edit Details", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");

  const mortgage = await create("liability", "Expired mortgage UX regression", {
    ...loanMetadata,
    sub_type: "mortgage",
    renewal_maturity_date: origin,
  });
  await page.goto(`${BASE_URL}/holdings/${mortgage}`);
  await expect(page.getByTestId("mortgage-overview")).toBeVisible();
  await expect(page.getByRole("button", { name: "Full mortgage", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Until renewal", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Renew mortgage", exact: true })).toBeVisible();
});
