import { expect, test } from "./fixtures";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test("Holdings and Transactions restore selected columns in a new browser session", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  await completeOnboardingIfNeeded(page);
  const api = `${BASE_URL}/api/v1`;
  const accountResponse = await page.request.post(`${api}/accounts`, {
    data: {
      name: "Column preferences",
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(accountResponse.ok()).toBeTruthy();
  const accountId = ((await accountResponse.json()) as { id: string }).id;
  const activityResponse = await page.request.post(`${api}/activities`, {
    data: {
      accountId,
      activityType: "BUY",
      activityDate: "2024-01-02T15:00:00Z",
      currency: "USD",
      fee: 0,
      needsReview: false,
      quantity: 10,
      unitPrice: 100,
      asset: {
        name: "Column preferences asset",
        symbol: "COLUMNTEST",
        kind: "INVESTMENT",
        quoteCcy: "USD",
        quoteMode: "MANUAL",
      },
    },
  });
  expect(activityResponse.ok()).toBeTruthy();

  const views = [
    { path: "/holdings", toggle: "Columns", hiddenColumn: "Quantity" },
    { path: "/activities", toggle: "Toggle columns", hiddenColumn: "Quantity" },
  ];
  for (const { path, toggle, hiddenColumn } of views) {
    await gotoAppPath(page, path);
    await expect(page.getByRole("button", { name: toggle, exact: true })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "Currency", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: toggle, exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Currency", exact: true }).click();
    await expect(page.getByRole("columnheader", { name: "Currency", exact: true })).toBeVisible();
    await page.getByRole("button", { name: toggle, exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: hiddenColumn, exact: true }).click();
    await expect(page.getByRole("columnheader", { name: hiddenColumn, exact: true })).toHaveCount(
      0,
    );
  }

  // Carry persisted browser storage into a fresh context, with no mounted app state.
  const storageState = await page.context().storageState();
  await page.close();
  const restoredContext = await browser.newContext({ storageState });
  try {
    const restoredPage = await restoredContext.newPage();
    for (const { path, toggle, hiddenColumn } of views) {
      await gotoAppPath(restoredPage, path);
      await expect(restoredPage.getByRole("button", { name: toggle, exact: true })).toBeVisible();
      await expect(
        restoredPage.getByRole("columnheader", { name: "Currency", exact: true }),
      ).toBeVisible();
      await expect(
        restoredPage.getByRole("columnheader", { name: hiddenColumn, exact: true }),
      ).toHaveCount(0);
    }
  } finally {
    await restoredContext.close();
  }
});
