import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

const api = `${BASE_URL}/api/v1`;

/** An account with enough activities for the page to scroll well past its table's top. */
async function createAccountWithActivities(page: Page) {
  await completeOnboardingIfNeeded(page);
  const runId = Date.now().toString(36);
  const accountResponse = await page.request.post(`${api}/accounts`, {
    data: {
      name: `Sticky header ${runId}`,
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(accountResponse.ok(), await accountResponse.text()).toBeTruthy();
  const accountId = ((await accountResponse.json()) as { id: string }).id;
  for (let day = 1; day <= 30; day++) {
    const response = await page.request.post(`${api}/activities`, {
      data: {
        accountId,
        activityType: "DEPOSIT",
        activityDate: `2024-01-${String(day).padStart(2, "0")}T15:00:00Z`,
        amount: 100 + day,
        currency: "USD",
        fee: 0,
        needsReview: false,
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  return accountId;
}

/**
 * Scrolls the page until the table's top is 400px above the visible area and
 * reports where the column header is: it should sit right below the page's
 * sticky header, or at the top of the page when there is none, and hide the
 * rows passing under it.
 */
async function scrollPastTableTop(page: Page) {
  return page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>("[data-page-scroll-container]");
    const table = document.querySelector<HTMLElement>("[data-virtual-scroll-parent] table");
    const thead = table?.querySelector("thead");
    if (!scroller || !table || !thead) throw new Error("page scroller or table missing");
    const pageHeader = [...scroller.querySelectorAll("header")].find(
      (header) => getComputedStyle(header).position === "sticky",
    );
    const scrollerTop = scroller.getBoundingClientRect().top;
    // The table's own top, unlike its header's, doesn't move when the header pins.
    scroller.scrollBy({
      top: table.getBoundingClientRect().top - scrollerTop + 400,
      behavior: "instant",
    });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rect = thead.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + 40, rect.top + rect.height / 2);
    // Paint the computed background on a canvas to read its alpha, whatever its colour syntax.
    const context = document.createElement("canvas").getContext("2d");
    if (!context) throw new Error("no canvas context");
    context.fillStyle = getComputedStyle(thead).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return {
      top: rect.top,
      expectedTop: pageHeader ? pageHeader.getBoundingClientRect().bottom : scrollerTop,
      onTop: hit !== null && thead.contains(hit),
      opaque: context.getImageData(0, 0, 1, 1).data[3] === 255,
    };
  });
}

/** Whether the table is wider than its box, and whether the box then scrolls to its last column. */
async function sidewaysScroll(page: Page) {
  return page.locator("[data-virtual-scroll-parent]").evaluate((box) => {
    const table = box.querySelector("table");
    const lastHeader = box.querySelector("thead th:last-child");
    if (!table || !lastHeader) throw new Error("table missing");
    box.scrollLeft = box.scrollWidth;
    return {
      overflows: table.offsetWidth > box.clientWidth,
      scrollLeft: box.scrollLeft,
      lastColumnVisible:
        lastHeader.getBoundingClientRect().right <= box.getBoundingClientRect().right + 1,
    };
  });
}

async function scrollPageToTop(page: Page) {
  await page.locator("[data-page-scroll-container]").evaluate((scroller) => {
    scroller.scrollTo({ top: 0, behavior: "instant" });
  });
}

/** With the page scrolled to its top, how far the column header sits from the table's top edge. */
async function headerOffsetAtRest(page: Page) {
  await scrollPageToTop(page);
  return page.locator("[data-virtual-scroll-parent] table").evaluate((table) => {
    const header = table.querySelector("thead");
    if (!header) throw new Error("table header missing");
    return Math.abs(header.getBoundingClientRect().top - table.getBoundingClientRect().top);
  });
}

async function toggleColumns(page: Page, labels: string[], visible: boolean) {
  await scrollPageToTop(page);
  for (const label of labels) {
    await page.getByTitle("Toggle columns").click();
    await page.getByRole("menuitemcheckbox", { name: label }).click();
    await expect(page.getByRole("columnheader", { name: label })).toHaveCount(visible ? 1 : 0);
    // Picking a column closes the menu; reopening it mid-close does nothing.
    await expect(page.getByRole("menu")).toHaveCount(0);
  }
}

async function expectHeaderPinned(page: Page) {
  const header = await scrollPastTableTop(page);
  expect(Math.abs(header.top - header.expectedTop)).toBeLessThanOrEqual(1);
  expect(header.onTop).toBe(true);
  expect(header.opaque).toBe(true);
}

test.use({ viewport: { width: 1440, height: 900 } });

test("account activities keep the column header below the page header", async ({ page }) => {
  test.setTimeout(120_000);
  const accountId = await createAccountWithActivities(page);
  await gotoAppPath(page, `/accounts/${accountId}?tab=activities`);
  await expect(page.getByRole("columnheader", { name: "Date" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("cell", { name: "Deposit", exact: true }).first()).toBeVisible();

  await expectHeaderPinned(page);
  // The table fits, so nothing is cut off at its right edge.
  expect(await sidewaysScroll(page)).toMatchObject({ overflows: false, lastColumnVisible: true });

  // Too narrow for every column (the hidden Currency column adds width, so
  // this doesn't hinge on a few pixels): the table scrolls sideways instead.
  // Its header then pins to the table's own box, so it must stay at the
  // table's top rather than move down by the page header's height.
  await toggleColumns(page, ["Currency"], true);
  await page.setViewportSize({ width: 1040, height: 900 });
  await expect
    .poll(() => sidewaysScroll(page))
    .toMatchObject({ overflows: true, lastColumnVisible: true });
  expect((await sidewaysScroll(page)).scrollLeft).toBeGreaterThan(0);
  await expect.poll(() => headerOffsetAtRest(page)).toBeLessThanOrEqual(1);

  // Wide again: the header pins again.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => (await sidewaysScroll(page)).overflows).toBe(false);
  await expectHeaderPinned(page);

  // At 1024px and below, `globals.css` makes flex ancestors scroll containers,
  // so even a table that fits keeps its header at its own top.
  await toggleColumns(page, ["Currency", "Quantity", "Fee", "Tax"], false);
  await page.setViewportSize({ width: 1024, height: 900 });
  await expect.poll(async () => (await sidewaysScroll(page)).overflows).toBe(false);
  await expect.poll(() => headerOffsetAtRest(page)).toBeLessThanOrEqual(1);
});

test("Activities keeps the investment table's column header in view", async ({ page }) => {
  test.setTimeout(120_000);
  const accountId = await createAccountWithActivities(page);
  await gotoAppPath(page, `/activities?tab=investments&account=${accountId}`);
  // Edit mode shows the data grid instead of this table.
  await page.getByTitle("View mode").click();
  await expect(page.getByRole("columnheader", { name: "Date" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("cell", { name: "Deposit", exact: true }).first()).toBeVisible();

  await expectHeaderPinned(page);
  expect(await sidewaysScroll(page)).toMatchObject({ overflows: false, lastColumnVisible: true });
});
