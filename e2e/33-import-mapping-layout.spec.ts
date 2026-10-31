import { expect, test, type Locator, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";

// One preview row per distinct symbol, enough for the mapping table to scroll.
const SYMBOLS = (
  "MSFT AAPL VOO GOOGL AMZN NVDA META TSLA BRK.B JPM V MA UNH HD PG KO PEP COST WMT DIS NFLX " +
  "ADBE CRM INTC AMD QQQ SPY VTI BND"
).split(" ");

function buildCsv() {
  const header =
    "date,symbol,instrumentType,quantity,activityType,unitPrice,currency,fee,amount,fxRate,subtype";
  const rows = SYMBOLS.map((symbol, index) => {
    const day = String(index + 1).padStart(2, "0");
    return `2024-01-${day},${symbol},EQUITY,${index + 1},BUY,${100 + index}.25,USD,4.95,,,`;
  });
  return [header, ...rows].join("\n") + "\n";
}

// Lists the ancestors whose overflow clipping hides part of the element vertically.
async function clippingAncestors(element: Locator) {
  return element.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const clipped: string[] = [];
    for (let el = node.parentElement; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const rect = el.getBoundingClientRect();
      const hidden = Math.max(rect.top - box.top, box.bottom - rect.bottom);
      if (hidden > 0.5) clipped.push(`${el.className} (${Math.round(hidden)}px)`);
    }
    return clipped;
  });
}

// Without an account, the Mapping step asks for one in an extra alert. `dir=rtl` is the
// development-only direction override (i18n/direction.tsx).
async function openMapping(page: Page, { withAccount = true, dir = "ltr" } = {}) {
  await completeOnboardingIfNeeded(page);

  const params = new URLSearchParams();
  if (withAccount) {
    const runId = Date.now().toString(36);
    const accountResponse = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
      data: {
        name: `Mapping layout ${runId}`,
        accountType: "SECURITIES",
        currency: "USD",
        isDefault: false,
        isActive: true,
        isArchived: false,
        trackingMode: "TRANSACTIONS",
      },
    });
    expect(accountResponse.ok(), await accountResponse.text()).toBeTruthy();
    params.set("account", ((await accountResponse.json()) as { id: string }).id);
  }
  if (dir === "rtl") params.set("dir", "rtl");

  await page.goto(`${BASE_URL}/import?${params}`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("dir", dir);
  await page.locator('input[type="file"]').setInputFiles({
    name: "mapping-layout.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(buildCsv()),
  });
  const configureMapping = page.getByRole("button", { name: /Configure Mapping/i });
  await expect(configureMapping).toBeEnabled({ timeout: 10_000 });
  await configureMapping.click();

  const activityPreview = page.getByRole("tabpanel", { name: "Activity Preview" });
  await expect(activityPreview.locator("tbody tr")).toHaveCount(SYMBOLS.length, {
    timeout: 15_000,
  });
  return {
    table: activityPreview.locator(':scope > [data-slot="card"]'),
    openFilePreview: async () => {
      await page.getByRole("tab", { name: "File Preview" }).click();
      const filePreview = page.getByRole("tabpanel", { name: "File Preview" });
      const pagination = filePreview.getByRole("button", { name: "Go to next page" });
      await expect(pagination).toBeVisible();
      return {
        panel: filePreview,
        search: filePreview.getByPlaceholder(/Search/i),
        lines: filePreview.locator("div:has(> div > table)"),
        pagination,
      };
    },
  };
}

// Issue #2002: at the 1920x984 reproduction viewport, about the content area of the reported
// 1920x1048 window, the table's bottom edge, with its horizontal scrollbar, fell below the step
// area. 1366px keeps that layout and makes the table clearly wider than the card.
test("mapping previews fit the visible step area", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1366, height: 984 });
  const { table, openFilePreview } = await openMapping(page);

  // The table scrolls on its own in both directions, so its scrollbars sit on its edges.
  const tableScroll = await table.evaluate((el) => ({
    overflowX: getComputedStyle(el).overflowX,
    sideways: el.scrollWidth > el.clientWidth,
    vertically: el.scrollHeight > el.clientHeight,
  }));
  expect(tableScroll).toEqual({ overflowX: "auto", sideways: true, vertically: true });
  await expect.poll(() => clippingAncestors(table), { message: "table" }).toEqual([]);

  const { lines, pagination } = await openFilePreview();
  const linesScroll = await lines.evaluate((el) => ({
    tallerThan100: el.clientHeight > 100,
    vertically: el.scrollHeight > el.clientHeight,
  }));
  expect(linesScroll).toEqual({ tallerThan100: true, vertically: true });
  await expect.poll(() => clippingAncestors(lines), { message: "CSV lines" }).toEqual([]);
  await expect.poll(() => clippingAncestors(pagination), { message: "pagination" }).toEqual([]);
});

// Up to 1024px wide, globals.css makes every .flex and .grid a scroll container, which a
// flex parent can shrink to nothing. The step doesn't fit on a phone, so it scrolls.
test("mapping step keeps its blocks whole on a phone", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const { table, openFilePreview } = await openMapping(page);

  const fieldsCard = page.getByRole("alert").filter({ hasText: "Fields" });
  await expect.poll(() => clippingAncestors(fieldsCard), { message: "Fields card" }).toEqual([]);
  await table.scrollIntoViewIfNeeded();
  await expect.poll(() => clippingAncestors(table), { message: "table" }).toEqual([]);

  // Scroll only the step, not the squeezable blocks inside the panel, which scroll too.
  const { panel, search, pagination } = await openFilePreview();
  await panel.scrollIntoViewIfNeeded();
  for (const [name, part] of Object.entries({ search, pagination })) {
    await expect.poll(() => clippingAncestors(part), { message: name }).toEqual([]);
  }
});

// The "Account assignment required" alert is a .grid too, so the same rule lets the step squeeze
// it until its own text scrolls inside it.
for (const dir of ["ltr", "rtl"]) {
  test(`account warning keeps its text whole on a phone (${dir})`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await openMapping(page, { withAccount: false, dir });

    const warning = page.getByRole("alert").filter({ hasText: "Account assignment required" });
    await warning.scrollIntoViewIfNeeded();
    const text = warning.locator('[data-slot="alert-description"]');
    await expect.poll(() => clippingAncestors(text), { message: "warning text" }).toEqual([]);
  });
}

// A template that skips every data row leaves the step showing only a "No CSV data available"
// alert, another .grid, which a phone held sideways is short enough to squeeze.
test("empty mapping alert keeps its text whole on a landscape phone", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 844, height: 390 });
  const name = `Skip all rows ${Date.now().toString(36)}`;
  const saved = await page.request.post(`${BASE_URL}/api/v1/activities/import/templates`, {
    data: {
      template: {
        id: name.replaceAll(" ", "-"),
        name,
        scope: "USER",
        kind: "CSV_ACTIVITY",
        fieldMappings: {},
        activityMappings: {},
        symbolMappings: {},
        accountMappings: {},
        parseConfig: {
          hasHeaderRow: true,
          headerRowIndex: 0,
          delimiter: ",",
          quoteChar: '"',
          skipTopRows: 0,
          skipBottomRows: SYMBOLS.length,
          skipEmptyRows: true,
          dateFormat: "auto",
          decimalSeparator: "auto",
          thousandsSeparator: "auto",
          defaultCurrency: "USD",
        },
      },
    },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await openMapping(page);

  await page.getByRole("combobox", { name: "Template", exact: true }).click();
  await page.getByRole("option", { name, exact: true }).click();
  const alert = page.getByRole("alert").filter({ hasText: "No CSV data available" });
  await alert.scrollIntoViewIfNeeded();
  const text = alert.locator('[data-slot="alert-description"]');
  await expect.poll(() => clippingAncestors(text), { message: "empty-state text" }).toEqual([]);
});

// Filtering adds a Reset button, which wraps the toolbar on a narrow phone and leaves little
// room for the CSV lines between it and the stacked pagination.
test("filtered file preview keeps a whole line on a narrow phone", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 320, height: 844 });
  const { openFilePreview } = await openMapping(page);

  const { panel, search, lines } = await openFilePreview();
  await search.fill(SYMBOLS[0]);
  await search.press("Enter");
  const line = lines.locator("tbody tr");
  await expect(line).toHaveCount(1);
  await panel.scrollIntoViewIfNeeded();
  await expect.poll(() => clippingAncestors(line), { message: "matching line" }).toEqual([]);
});
