import { expect, test, type Locator, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

const api = `${BASE_URL}/api/v1`;
const HOLDING_COUNT = 15;
let holdingsAccountId: string | undefined;

// One account with enough manually priced holdings that its tables are taller than the window,
// created once for the tests in this file.
async function createHoldings(page: Page) {
  await completeOnboardingIfNeeded(page);
  if (holdingsAccountId) return holdingsAccountId;
  const runId = Date.now().toString(36).toUpperCase();
  const accountResponse = await page.request.post(`${api}/accounts`, {
    data: {
      name: `Sticky holdings ${runId}`,
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(accountResponse.ok(), await accountResponse.text()).toBeTruthy();
  const accountId = ((await accountResponse.json()) as { id: string }).id;

  for (let i = 0; i < HOLDING_COUNT; i++) {
    const response = await page.request.post(`${api}/activities`, {
      data: {
        accountId,
        activityType: "BUY",
        activityDate: "2024-01-02T15:00:00Z",
        currency: "USD",
        fee: 0,
        needsReview: false,
        quantity: 10,
        unitPrice: 100 + i,
        asset: {
          name: `Sticky header asset ${i}`,
          symbol: `STICKY${i}X${runId}`,
          kind: "INVESTMENT",
          quoteCcy: "USD",
          quoteMode: "MANUAL",
        },
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  }

  await expect
    .poll(
      async () => {
        const holdingsResponse = await page.request.post(`${api}/holdings/list/query`, {
          data: { filter: { type: "account", accountId }, includeClosed: true },
        });
        expect(holdingsResponse.ok()).toBeTruthy();
        return ((await holdingsResponse.json()) as { holdings: unknown[] }).holdings.length;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(HOLDING_COUNT);
  holdingsAccountId = accountId;
  return accountId;
}

async function openTable(page: Page, path: string, column: string) {
  await gotoAppPath(page, path);
  const table = page
    .getByRole("table")
    .filter({ has: page.getByRole("columnheader", { name: column }) });
  // Wait past the loading skeleton's placeholder rows.
  await expect
    .poll(() => table.locator("tbody tr").count(), { message: path, timeout: 30_000 })
    .toBeGreaterThanOrEqual(HOLDING_COUNT);
  return table;
}

// The header is on screen and nothing covers it.
function headerOnTop(header: Locator) {
  return header.evaluate((thead) => {
    const rect = thead.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + 40, rect.top + rect.height / 2);
    return !!hit && thead.contains(hit);
  });
}

// Wheel over the rows and report how far the header and the first row moved.
async function wheelOverRows(page: Page, table: Locator) {
  const header = table.locator("thead");
  const firstRow = table.locator("tbody tr").first();
  await header.scrollIntoViewIfNeeded();
  const before = { header: (await header.boundingBox())!, row: (await firstRow.boundingBox())! };

  await page.mouse.move(
    before.header.x + before.header.width / 2,
    before.header.y + before.header.height + 60,
  );
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => (await firstRow.boundingBox())!.y).toBeLessThan(before.row.y - 200);

  const after = { header: (await header.boundingBox())!, row: (await firstRow.boundingBox())! };
  return {
    headerMoved: after.header.y - before.header.y,
    rowMoved: after.row.y - before.row.y,
    headerOnTop: await headerOnTop(header),
  };
}

test("holdings and securities tables keep their header pinned while their rows scroll", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  const accountId = await createHoldings(page);

  for (const [path, column] of [
    ["/holdings", "Position"],
    [`/accounts/${accountId}?tab=holdings`, "Position"],
    ["/settings/securities", "Security"],
  ]) {
    const table = await openTable(page, path, column);
    const result = await wheelOverRows(page, table);
    // Soft, so one run reports every page.
    expect.soft(result.rowMoved, path).toBeLessThan(-200);
    expect.soft(Math.abs(result.headerMoved), path).toBeLessThanOrEqual(1);
    expect.soft(result.headerOnTop, path).toBe(true);
  }
});

test("the Securities header stays in view when scrolling goes on past the table's end", async ({
  page,
}) => {
  test.setTimeout(180_000);
  // Shorter than the Settings sidebar.
  const viewport = { width: 1280, height: 500 };
  await page.setViewportSize(viewport);
  await createHoldings(page);
  const table = await openTable(page, "/settings/securities", "Security");
  // DataTable's scroll box, around Table's own wrapper.
  const box = table.locator("xpath=../..");

  await box.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  const rect = (await box.boundingBox())!;
  await page.mouse.move(
    rect.x + rect.width / 2,
    (rect.y + Math.min(rect.y + rect.height, viewport.height)) / 2,
  );
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, 300);
  // The table is at its end, so the wheel scrolls the page, as far as it goes.
  await expect
    .poll(
      () =>
        box.evaluate((el) => {
          let scroller = el.parentElement;
          while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) {
            scroller = scroller.parentElement;
          }
          return (
            !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1
          );
        }),
      { message: "page scrolled to its end" },
    )
    .toBe(true);

  await expect(table.locator("tbody tr").last()).toBeInViewport();
  expect(await headerOnTop(table.locator("thead"))).toBe(true);
});

test("the Settings nav scrolls its last link fully into view", async ({ page }) => {
  await completeOnboardingIfNeeded(page);
  // 1024 px is the first desktop width, where globals.css still gives `.flex` boxes overflow-x: hidden.
  for (const [width, height] of [
    [1024, 500],
    [1024, 768],
    [1280, 500],
  ]) {
    await page.setViewportSize({ width, height });
    await gotoAppPath(page, "/settings/general");
    const links = page.locator("aside a");
    await links.nth(-2).focus();
    await page.keyboard.press("Tab");
    await expect(links.last()).toBeFocused();
    await expect(links.last(), `${width}x${height}`).toBeInViewport({ ratio: 1 });
  }
});

test("Shift+Tab back through the Holdings and Securities rows keeps each focus outline clear of the header", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await createHoldings(page);

  // Holdings rows have one stop (the actions menu), Securities rows two (the security too),
  // so these walks keep focus in the rows.
  for (const [path, column, stops] of [
    ["/holdings", "Position", HOLDING_COUNT - 1],
    ["/settings/securities", "Security", 2 * HOLDING_COUNT - 1],
  ] as const) {
    const table = await openTable(page, path, column);
    const focused = table.locator("tbody :focus");
    // The focused control and the outline drawn around it.
    const pxUnderHeader = () =>
      focused.evaluate((el) => {
        const style = getComputedStyle(el);
        const outline =
          style.outlineStyle === "none"
            ? 0
            : parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
        const control = el.getBoundingClientRect();
        const header = el.closest("table")!.querySelector("thead")!.getBoundingClientRect();
        return (
          Math.min(control.bottom + outline, header.bottom) -
          Math.max(control.top - outline, header.top)
        );
      });

    // A query refresh soon after load re-creates the cells and drops focus; start over if it does.
    await expect(async () => {
      // The last row can be the cash balance, which has no actions menu.
      await table.locator("tbody").getByRole("button").last().focus();
      for (let stop = 1; stop <= stops; stop++) {
        await page.keyboard.press("Shift+Tab");
        await expect(focused).toHaveCount(1, { timeout: 1_000 });
        await expect
          .poll(pxUnderHeader, {
            message: `${path}: px of focus stop ${stop} under the header`,
            timeout: 2_000,
          })
          .toBeLessThanOrEqual(1);
      }
    }).toPass({ timeout: 60_000 });
  }
});
