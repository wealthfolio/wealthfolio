import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";

const api = `${BASE_URL}/api/v1`;

// Symbols from e2e/fixtures/quotes, one BUY and one DIVIDEND each, so the preview overflows.
const SYMBOLS = ["AAPL", "SHOP", "PANW", "MSFT", "TSLA", "NVDA", "ASML", "VOO", "KWEB", "JNJ"];

function buildCsv() {
  const lines = ["date,symbol,quantity,activityType,unitPrice,currency,fee,amount"];
  SYMBOLS.forEach((symbol, i) => {
    const day = String(i + 1).padStart(2, "0");
    lines.push(`2024-01-${day},${symbol},10,BUY,100.00,USD,1.00,`);
    lines.push(`2024-03-${day},${symbol},1,DIVIDEND,0.50,USD,0,0.50`);
  });
  return lines.join("\n") + "\n";
}

// Each row's activity type is one the importer doesn't know, so each row gets a select to map it.
function buildUnknownTypeCsv() {
  const lines = ["date,symbol,quantity,activityType,unitPrice,currency,fee,amount"];
  for (let i = 0; i < 20; i++) {
    lines.push(`2024-01-${String(i + 1).padStart(2, "0")},AAPL,1,ODDTYPE${i},100.00,USD,0,`);
  }
  return lines.join("\n") + "\n";
}

async function openActivityPreview(page: Page, csv: string) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await completeOnboardingIfNeeded(page);

  const accountName = `Sticky header ${Date.now().toString(36)}`;
  const accountResponse = await page.request.post(`${api}/accounts`, {
    data: {
      name: accountName,
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(accountResponse.ok(), await accountResponse.text()).toBeTruthy();

  await page.goto(`${BASE_URL}/import`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: /Import Activities/i })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole("combobox", { name: /Select an account/i }).click();
  await page.getByPlaceholder("Search accounts...").fill(accountName);
  await page.getByRole("option", { name: accountName }).first().click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "sticky-header.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await expect(page.getByText("CSV Preview")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /Configure Mapping/i }).click();

  const table = page.getByRole("tabpanel", { name: "Activity Preview" }).locator("table");
  await expect(table.locator("tbody tr").last()).toHaveCSS("opacity", "1", { timeout: 10_000 });
  return table;
}

test("mapping preview keeps its header and # column pinned while it scrolls", async ({ page }) => {
  test.setTimeout(120_000);
  const table = await openActivityPreview(page, buildCsv());

  const result = await table.evaluate((tableEl) => {
    // The preview's scroll box is the nearest ancestor that actually overflows.
    let box = tableEl.parentElement;
    while (box && box.scrollHeight <= box.clientHeight) box = box.parentElement;
    if (!box) throw new Error("no scrolling ancestor");
    box.scrollTo({ top: 200, left: 300 });

    const boxRect = box.getBoundingClientRect();
    const thead = tableEl.querySelector("thead")!;
    const corner = thead.querySelector("th")!;
    const firstCell = tableEl.querySelector("tbody tr td")!;
    const theadRect = thead.getBoundingClientRect();
    const cornerRect = corner.getBoundingClientRect();
    const hit = (x: number, y: number) => document.elementFromPoint(x, y);

    // A body row now sits under the header and a body # cell under the corner.
    const midX = boxRect.left + boxRect.width / 2;
    const headerHit = hit(midX, theadRect.top + theadRect.height / 2);
    const cornerHit = hit(cornerRect.left + 4, cornerRect.top + 4);
    const numberColumnHit = hit(cornerRect.left + 4, theadRect.bottom + 20);

    return {
      scrollTop: box.scrollTop,
      scrollLeft: box.scrollLeft,
      headerOffset: theadRect.top - boxRect.top,
      numberColumnOffset: firstCell.getBoundingClientRect().left - boxRect.left,
      headerOnTop: !!headerHit && thead.contains(headerHit),
      cornerOnTop: !!cornerHit && corner.contains(cornerHit),
      numberColumnOnTop: !!numberColumnHit?.closest("td")?.matches("td:first-child"),
    };
  });

  expect(result.scrollTop).toBeGreaterThan(0);
  expect(result.scrollLeft).toBeGreaterThan(0);
  expect(result.headerOffset).toBeGreaterThanOrEqual(0);
  expect(result.headerOffset).toBeLessThanOrEqual(2);
  expect(result.numberColumnOffset).toBeGreaterThanOrEqual(0);
  expect(result.numberColumnOffset).toBeLessThanOrEqual(2);
  expect(result.headerOnTop).toBe(true);
  expect(result.cornerOnTop).toBe(true);
  expect(result.numberColumnOnTop).toBe(true);
});

test("keyboard focus doesn't leave a row's select under the pinned header", async ({ page }) => {
  test.setTimeout(120_000);
  const table = await openActivityPreview(page, buildUnknownTypeCsv());
  const selects = table.locator("tbody").getByRole("combobox");
  await expect(selects).toHaveCount(20);

  // Shift+Tab up from the last row. A select above the visible rows is scrolled into view; it
  // has to land below the pinned header, with room for its 4px focus outline.
  await selects.last().focus();
  const stops: { row: number; gapBelowHeader: number }[] = [];
  for (let i = 0; i < 20; i++) {
    if (i > 0) await page.keyboard.press("Shift+Tab");
    stops.push(
      await page.evaluate(() => {
        const select = document.activeElement as HTMLElement;
        const row = select.closest("tr") as HTMLTableRowElement;
        const header = select.closest("table")!.querySelector("thead")!.getBoundingClientRect();
        return {
          row: row.rowIndex,
          gapBelowHeader: Math.round(select.getBoundingClientRect().top - header.bottom),
        };
      }),
    );
  }

  expect(stops.map((stop) => stop.row)).toEqual(Array.from({ length: 20 }, (_, i) => 20 - i));
  expect(stops.filter((stop) => stop.gapBelowHeader < 4)).toEqual([]);
});
