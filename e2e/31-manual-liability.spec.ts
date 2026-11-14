import { expect, test } from "./fixtures";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";

test.use({ actionTimeout: 15_000 });

test("manual liability retains origination, survives balance deletion and matches net worth", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await completeOnboardingIfNeeded(page);
  const api = `${BASE_URL}/api/v1`;
  const today = await page.evaluate(() => {
    const date = new Date();
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, "0"),
      String(date.getDate()).padStart(2, "0"),
    ].join("-");
  });
  const netWorth = async () => {
    const response = await page.request.get(`${api}/net-worth?date=${today}`);
    expect(response.ok()).toBeTruthy();
    const current = await response.json();
    const historyResponse = await page.request.get(
      `${api}/net-worth/history?startDate=${today}&endDate=${today}`,
    );
    expect(historyResponse.ok()).toBeTruthy();
    const history = await historyResponse.json();
    return {
      current: Number(current.liabilities.total),
      history: Number(history.at(-1)?.totalLiabilities ?? 0),
    };
  };
  const baseline = await netWorth();
  await page.goto(`${BASE_URL}/holdings?tab=assets`);
  await page.locator('button.h-9.w-9[aria-haspopup="dialog"]').click();
  await page.getByRole("dialog").getByRole("button", { name: "Add Asset", exact: true }).click();
  const sheet = page.getByRole("dialog");
  await sheet.getByRole("button", { name: /Liability.*Loans/ }).click();
  await sheet.getByRole("button", { name: "Continue", exact: true }).click();
  await sheet.getByPlaceholder("Home Mortgage, Car Loan...").fill("Manual liability regression");
  await sheet.getByRole("switch", { name: "Estimate balance from payments" }).click();
  await sheet
    .getByText("Original Amount", { exact: true })
    .locator("..")
    .getByPlaceholder("0.00")
    .fill("100");
  await sheet.locator('input[type="date"]').first().fill("2022-06-05");
  await sheet.getByPlaceholder("0", { exact: true }).fill("2");
  await sheet.getByRole("button", { name: "Add Liability", exact: true }).click();
  await expect(sheet).toHaveCount(0, { timeout: 15_000 });
  const holdings = async () => await (await page.request.get(`${api}/alternative-holdings`)).json();
  const created = (await holdings()).find(
    (holding: { name: string }) => holding.name === "Manual liability regression",
  );
  expect(created.metadata.origination_date).toBe("2022-06-05");
  const id = created.id;
  const holding = async () => (await holdings()).find((entry: { id: string }) => entry.id === id);
  const quotes = async () =>
    await (await page.request.get(`${api}/market-data/quotes/history?symbol=${id}`)).json();
  expect((await quotes())[0].timestamp.slice(0, 10)).toBe("2022-06-05");
  await page.goto(`${BASE_URL}/holdings/${id}?tab=history`);
  const ledger = page.getByRole("region", { name: "Payments & events", exact: true });
  await ledger.getByRole("button", { name: "Add event", exact: true }).click();
  await page.getByRole("menuitem", { name: "Confirm balance", exact: true }).click();
  await sheet.locator("input").last().fill("0");
  await sheet.getByRole("button", { name: "Confirm balance", exact: true }).click();
  await expect(sheet).toHaveCount(0, { timeout: 15_000 });
  expect(await quotes()).toHaveLength(2);
  expect(Number((await holding()).marketValue)).toBe(0);
  // A second confirmation on today must make daily replacement explicit.
  await ledger.getByRole("button", { name: "Add event", exact: true }).click();
  await page.getByRole("menuitem", { name: "Confirm balance", exact: true }).click();
  await expect(sheet).toContainText("Deleting it later will not restore the previous balance");
  await sheet.getByRole("button", { name: "Cancel", exact: true }).click();
  const rows = ledger.getByTestId("loan-ledger-row");
  await rows
    .filter({ hasText: "Balance confirmed" })
    .filter({ hasText: /\b0\.00\b/ })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await sheet.getByRole("button", { name: "Delete", exact: true }).click();
  await sheet.getByRole("button", { name: "Delete event", exact: true }).click();
  await expect(sheet).toHaveCount(0, { timeout: 15_000 });
  expect(Number((await holding()).marketValue)).toBe(100);
  // Delete the remaining opening quote to exercise the metadata fallback, too.
  const opening = (await quotes())[0];
  const removed = await page.request.post(`${api}/loans/${id}/actions`, {
    data: { type: "edit_balance", quoteId: opening.id, replacement: null },
  });
  expect(removed.ok()).toBeTruthy();
  expect(await quotes()).toHaveLength(0);
  expect((await holding()).loan.balanceSource).toBe("original");
  expect(Number((await holding()).marketValue)).toBe(100);
  const after = await netWorth();
  expect(after.current - baseline.current).toBe(100);
  expect(after.history - baseline.history).toBe(100);
  await page.goto(`${BASE_URL}/holdings/${id}`);
  await expect(
    page.getByTestId("loan-overview").or(page.getByTestId("mortgage-overview")),
  ).toContainText("100.00");
  await page.goto(`${BASE_URL}/holdings?tab=liabilities`);
  await expect(
    page.getByRole("link", { name: "Manual liability regression", exact: true }),
  ).toBeVisible();
});
