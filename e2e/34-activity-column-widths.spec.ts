import { expect, test, type Page } from "./fixtures";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

const api = `${BASE_URL}/api/v1`;

/**
 * An account whose newest rows are short deposits and whose older rows, further
 * down the list, are buys with long quantities and large amounts: rows whose
 * content wants different column widths than the ones mounted at the top.
 */
async function createAccountWithMixedActivities(page: Page) {
  await completeOnboardingIfNeeded(page);
  const runId = Date.now().toString(36);
  const accountResponse = await page.request.post(`${api}/accounts`, {
    data: {
      name: `Column widths ${runId}`,
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(accountResponse.ok(), await accountResponse.text()).toBeTruthy();
  const accountId = ((await accountResponse.json()) as { id: string }).id;
  for (let day = 1; day <= 28; day++) {
    const date = String(day).padStart(2, "0");
    const deposit = await page.request.post(`${api}/activities`, {
      data: {
        accountId,
        activityType: "DEPOSIT",
        activityDate: `2024-02-${date}T15:00:00Z`,
        amount: 5,
        currency: "USD",
        fee: 0,
        needsReview: false,
      },
    });
    expect(deposit.ok(), await deposit.text()).toBeTruthy();
    const buy = await page.request.post(`${api}/activities`, {
      data: {
        accountId,
        activityType: "BUY",
        activityDate: `2024-01-${date}T15:00:00Z`,
        currency: "USD",
        fee: 1234.56,
        tax: 789.12,
        needsReview: false,
        quantity: 12345.6789012345,
        unitPrice: 9876.54,
        asset: {
          name: `Column widths asset ${runId}`,
          symbol: `COLW${runId}`.toUpperCase(),
          kind: "INVESTMENT",
          quoteCcy: "USD",
          quoteMode: "MANUAL",
        },
      },
    });
    expect(buy.ok(), await buy.text()).toBeTruthy();
  }
  return accountId;
}

/** Scrolls the page one screen at a time to its end, recording the header cells' widths at each step. */
async function headerWidthsWhileScrolling(page: Page) {
  return page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>("[data-page-scroll-container]");
    const box = document
      .querySelector("main table")
      ?.closest<HTMLElement>("[data-virtual-scroll-parent]");
    if (!scroller || !box) throw new Error("page scroller or table missing");
    const nextFrame = () =>
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const widths = () =>
      [...box.querySelectorAll("thead th")].map((th) => th.getBoundingClientRect().width);
    const steps = [widths()];
    for (let step = 0; step < 20; step++) {
      scroller.scrollBy({ top: scroller.clientHeight, behavior: "instant" });
      await nextFrame();
      steps.push(widths());
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1) break;
    }
    return steps;
  });
}

test.use({ viewport: { width: 1440, height: 900 } });

test("the activity table's columns keep their widths while it scrolls", async ({ page }) => {
  test.setTimeout(120_000);
  const accountId = await createAccountWithMixedActivities(page);
  await gotoAppPath(page, `/activities?tab=investments&account=${accountId}`);
  // Edit mode shows the data grid instead of this table.
  await page.getByTitle("View mode").click();
  await expect(page.getByRole("columnheader", { name: "Date" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("cell", { name: "Deposit", exact: true }).first()).toBeVisible();

  const [atTop, ...scrolled] = await headerWidthsWhileScrolling(page);
  // The buys must have come into view, or this proves nothing.
  await expect(page.getByRole("cell", { name: "Buy", exact: true }).first()).toBeAttached();
  expect(scrolled.length).toBeGreaterThan(1);
  for (const widths of scrolled) {
    expect(widths).toHaveLength(atTop.length);
    widths.forEach((width, column) => expect(width).toBeCloseTo(atTop[column], 0));
  }
});
