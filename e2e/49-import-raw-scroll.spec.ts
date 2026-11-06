import { expect, test, type Locator, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";

const CSV = [
  "date,symbol,instrumentType,quantity,activityType,unitPrice,currency,fee,comment",
  ...Array.from(
    { length: 29 },
    (_, index) =>
      `2024-01-${String(index + 1).padStart(2, "0")},MSFT,EQUITY,1,BUY,100,USD,0,${"long synthetic comment ".repeat(20)}`,
  ),
].join("\n");

// Both views use CSVFileViewer, but their parents constrain its height differently.
// Check browser geometry and actual scrolling, rather than Tailwind class names.
async function checkScrollBox(panel: Locator, page: Page, name: string, dir: string) {
  const table = panel.getByRole("table");
  await expect(table.locator("tbody tr")).toHaveCount(20);
  await table.scrollIntoViewIfNeeded();
  // Wait for the CSV rows' entrance transforms to finish before measuring sticky cells.
  await expect
    .poll(() =>
      table
        .locator("tbody tr")
        .last()
        .evaluate((row) => getComputedStyle(row).transform),
    )
    .toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);

  const geometry = await table.evaluate((node) => {
    const wrapper = node.parentElement!;
    const box = wrapper.parentElement!;
    box.scrollTop = 0;
    box.scrollLeft = 0;
    const boxRect = box.getBoundingClientRect();
    return {
      visibleWidth: box.clientWidth,
      contentWidth: box.scrollWidth,
      visibleHeight: box.clientHeight,
      contentHeight: box.scrollHeight,
      wrapperBottom: wrapper.getBoundingClientRect().bottom,
      boxBottom: boxRect.bottom,
      boxTop: boxRect.top,
      viewportHeight: window.innerHeight,
    };
  });
  await test.info().attach(`${name}-${dir}-geometry`, {
    body: JSON.stringify(geometry, null, 2),
    contentType: "application/json",
  });
  expect
    .soft(geometry.contentHeight, `${name}: exercise vertical overflow`)
    .toBeGreaterThan(geometry.visibleHeight);
  expect
    .soft(geometry.contentWidth, `${name}: the visible box owns horizontal overflow`)
    .toBeGreaterThan(geometry.visibleWidth);
  expect.soft(geometry.boxTop, `${name}: top edge is visible`).toBeGreaterThanOrEqual(0);
  expect
    .soft(geometry.boxBottom, `${name}: scrollbar edge is visible`)
    .toBeLessThanOrEqual(geometry.viewportHeight);

  const movement = await table.evaluate((node) => {
    const box = node.parentElement!.parentElement!;
    const cell = node.querySelector("tbody td")!;
    const content = node.querySelector("tbody td:last-child > div")!;
    const cellBefore = cell.getBoundingClientRect();
    const contentBefore = content.getBoundingClientRect();
    const rtl = getComputedStyle(box).direction === "rtl";
    box.scrollLeft = rtl ? -300 : 300;
    const cellAfter = cell.getBoundingClientRect();
    const contentAfter = content.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    const hit = document.elementFromPoint(
      cellAfter.x + cellAfter.width / 2,
      cellAfter.y + cellAfter.height / 2,
    );
    return {
      scrollLeft: box.scrollLeft,
      contentMoved: Math.abs(contentAfter.x - contentBefore.x),
      statusMoved: Math.abs(cellAfter.x - cellBefore.x),
      statusAtStart: Math.abs(
        rtl ? boxRect.right - cellAfter.right : cellAfter.left - boxRect.left,
      ),
      statusVisible: hit !== null && cell.contains(hit),
    };
  });
  await test.info().attach(`${name}-${dir}-movement`, {
    body: JSON.stringify(movement, null, 2),
    contentType: "application/json",
  });
  expect
    .soft(Math.abs(movement.scrollLeft), `${name}: scroll the visible box sideways`)
    .toBeGreaterThan(250);
  expect.soft(movement.contentMoved, `${name}: CSV content moves sideways`).toBeGreaterThan(250);
  expect.soft(movement.statusMoved, `${name}: status stays pinned`).toBeLessThan(1);
  expect.soft(movement.statusAtStart, `${name}: status stays at the logical start`).toBeLessThan(2);
  expect.soft(movement.statusVisible, `${name}: content does not cover status`).toBe(true);

  await test.info().attach(`${name}-${dir}`, {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  const verticalScroll = await table.evaluate((node) => {
    const box = node.parentElement!.parentElement!;
    box.scrollTop = 100;
    return box.scrollTop;
  });
  expect.soft(verticalScroll, `${name}: same box scrolls vertically`).toBeGreaterThan(50);
  await panel.getByRole("button", { name: "Go to next page" }).click();
  await expect(table.locator("tbody tr")).toHaveCount(10);
}

for (const dir of ["ltr", "rtl"]) {
  test(`raw CSV scrollbar stays at the visible preview edge (${dir})`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1366, height: 984 });
    await completeOnboardingIfNeeded(page);
    const response = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
      data: {
        name: `Raw CSV scroll ${dir} ${Date.now()}`,
        accountType: "SECURITIES",
        currency: "USD",
        isDefault: false,
        isActive: true,
        isArchived: false,
        trackingMode: "TRANSACTIONS",
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const { id } = (await response.json()) as { id: string };
    await page.goto(`${BASE_URL}/import?account=${id}&dir=${dir}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator("html")).toHaveAttribute("dir", dir);
    await page.locator('input[type="file"]').setInputFiles({
      name: "raw-scroll.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(CSV),
    });
    await page.getByRole("tab", { name: "Raw File", exact: true }).click();
    await checkScrollBox(
      page.getByRole("tabpanel", { name: "Raw File", exact: true }),
      page,
      "upload",
      dir,
    );

    const configureMapping = page.getByRole("button", { name: /Configure Mapping/i });
    await expect(configureMapping).toBeEnabled();
    await configureMapping.click();
    await page.getByRole("tab", { name: "File Preview", exact: true }).click();
    await checkScrollBox(
      page.getByRole("tabpanel", { name: "File Preview", exact: true }),
      page,
      "mapping",
      dir,
    );
  });
}
