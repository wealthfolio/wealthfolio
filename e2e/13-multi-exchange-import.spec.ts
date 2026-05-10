import { expect, Locator, Page, test } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import { BASE_URL, createAccount, loginIfNeeded, waitForSyncToast } from "./helpers";

test.describe.configure({ mode: "serial" });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures");
const MULTI_EXCHANGE_CSV = path.join(FIXTURES, "multi-exchange-import.csv");

const IMPORT_ACCOUNT = "Multi-Exchange EUR Account";

async function selectImportAccount(page: Page, accountName: string) {
  const selectorTrigger = page.getByRole("combobox", { name: /Select an account/i });
  await expect(selectorTrigger).toBeVisible({ timeout: 5000 });
  await selectorTrigger.click();
  await page.waitForTimeout(300);

  const searchInput = page.getByPlaceholder("Search accounts...");
  await searchInput.fill(accountName);
  await page.waitForTimeout(300);

  const accountOption = page.getByRole("option", { name: new RegExp(accountName, "i") }).first();
  await expect(accountOption).toBeVisible({ timeout: 5000 });
  await accountOption.click();
  await page.waitForTimeout(300);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Locates an asset-review row by the canonical (suffix-stripped) symbol shown in
 * the bold mono span. The row container is the grid div wrapping the symbol +
 * pills + actions.
 */
function rowFor(page: Page, symbol: string): Locator {
  return page
    .locator("div.grid")
    .filter({
      has: page
        .locator("span.font-mono")
        .filter({ hasText: new RegExp(`^${escapeRegex(symbol)}$`) }),
    })
    .first();
}

test.describe("Issue #855 — symbol resolution and region classification", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("0. Setup: login and create EUR import account", async () => {
    test.setTimeout(180000);
    await loginIfNeeded(page);
    await createAccount(page, IMPORT_ACCOUNT, "EUR", "Transactions");
  });

  test("1. Upload CSV and reach asset-review step", async () => {
    test.setTimeout(180000);

    await page.goto(`${BASE_URL}/import`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: /Import Activities/i })).toBeVisible({
      timeout: 10000,
    });
    await page.waitForTimeout(1000);

    await selectImportAccount(page, IMPORT_ACCOUNT);

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(MULTI_EXCHANGE_CSV);
    await page.waitForTimeout(1000);

    await expect(page.getByText("CSV Preview")).toBeVisible({ timeout: 10000 });

    await page.getByRole("button", { name: /Configure Mapping/i }).click();
    await page.waitForTimeout(1000);

    await page.getByRole("button", { name: /Review Assets/i }).click();
    await page.waitForTimeout(3000);

    // Asset resolution depends on Yahoo Finance — give it generous time
    await expect(page.getByRole("button", { name: /Review Activities/i })).toBeEnabled({
      timeout: 120000,
    });
  });

  test("2. German XETRA listings of US/NL issuers resolve to XETRA + EUR (not NASDAQ + USD)", async () => {
    test.setTimeout(60000);

    // APC.DE → Apple Inc., XETRA, EUR — not NASDAQ/USD.
    // The CSV also contains an APC row on US exchanges, which renders as a
    // separate review row with the same suffix-stripped symbol. Disambiguate
    // by the resolved issuer name so the lookup is order-independent.
    const apc = page
      .locator("div.grid")
      .filter({
        has: page.locator("span.font-mono").filter({ hasText: /^APC$/ }),
      })
      .filter({ hasText: /Apple/i })
      .first();
    await expect(apc).toContainText("XETRA");
    await expect(apc).toContainText("EUR");
    await expect(apc).not.toContainText(/EUR\s*→\s*USD/);

    // TL0.DE → Tesla, XETRA, EUR
    const tl0 = rowFor(page, "TL0");
    await expect(tl0).toContainText(/Tesla/i);
    await expect(tl0).toContainText("XETRA");
    await expect(tl0).toContainText("EUR");

    // MSF.DE → Microsoft, XETRA, EUR
    const msf = rowFor(page, "MSF");
    await expect(msf).toContainText(/Microsoft/i);
    await expect(msf).toContainText("XETRA");

    // ASME.DE → ASML Holding, XETRA, EUR
    const asme = rowFor(page, "ASME");
    await expect(asme).toContainText(/ASML/i);
    await expect(asme).toContainText("XETRA");
    await expect(asme).toContainText("EUR");
  });

  test("3. Genuine European issuer on XETRA (SAP) still resolves correctly", async () => {
    test.setTimeout(30000);

    const sap = rowFor(page, "SAP");
    await expect(sap).toContainText(/SAP/i);
    await expect(sap).toContainText("XETRA");
    await expect(sap).toContainText("EUR");
  });

  test("4. US-listed controls resolve to NASDAQ/NYSE in USD", async () => {
    test.setTimeout(30000);

    const aapl = rowFor(page, "AAPL");
    await expect(aapl).toContainText(/Apple/i);
    await expect(aapl).toContainText("NASDAQ");
    await expect(aapl).toContainText("USD");

    const jnj = rowFor(page, "JNJ");
    await expect(jnj).toContainText(/Johnson/i);
    await expect(jnj).toContainText("NYSE");
    await expect(jnj).toContainText("USD");
  });

  test("5. Canadian TSX listings resolve to TSX + CAD", async () => {
    test.setTimeout(30000);

    // SHOP.TO → Shopify on TSX in CAD. SHOP also exists as a separate row (NYSE/USD),
    // so scope by the CAD pill which only appears on the TSX row.
    const shopTsx = page
      .locator("div.grid")
      .filter({
        has: page.locator("span.font-mono").filter({ hasText: /^SHOP$/ }),
      })
      .filter({ hasText: "CAD" })
      .first();
    await expect(shopTsx).toContainText(/Shopify/i);
    await expect(shopTsx).toContainText("TSX");
    await expect(shopTsx).toContainText("CAD");
  });

  test("6. LSE pence: VOD.L resolves to LSE in GBp", async () => {
    test.setTimeout(30000);

    const vod = rowFor(page, "VOD");
    await expect(vod).toContainText(/Vodafone/i);
    await expect(vod).toContainText("LSE");
    await expect(vod).toContainText(/GBp|GBP/);

    const bp = rowFor(page, "BP");
    await expect(bp).toContainText("LSE");
  });

  test("7. Share-class dot is preserved (BRK.B, not stripped to BRK)", async () => {
    test.setTimeout(30000);

    const brk = rowFor(page, "BRK.B");
    await expect(brk).toContainText(/Berkshire/i);
    await expect(brk).toContainText(/NYSE/);
  });

  test("8. Precious metal ETCs are classified as METAL not EQUITY", async () => {
    test.setTimeout(30000);

    const gld = rowFor(page, "4GLD");
    await expect(gld).toContainText("METAL");
  });

  test("9. Crypto pair BTC-USD is classified as CRYPTO", async () => {
    test.setTimeout(30000);

    const btc = rowFor(page, "BTC");
    await expect(btc).toContainText("CRYPTO");
  });

  test("10. Cross-listed symbols produce distinct asset rows (no collision)", async () => {
    test.setTimeout(30000);

    // SHOP appears on TSX (CAD) and NYSE (USD) — must be 2 distinct review rows.
    const shopRows = page.locator("span.font-mono").filter({ hasText: /^SHOP$/ });
    expect(await shopRows.count()).toBeGreaterThanOrEqual(2);

    // APC.DE (Apple/XETRA/EUR) and APC (US/USD) — must NOT collapse to a single row.
    const apcRows = page.locator("span.font-mono").filter({ hasText: /^APC$/ });
    expect(await apcRows.count()).toBeGreaterThanOrEqual(2);
  });

  test("11. Complete the import", async () => {
    test.setTimeout(180000);

    await page.getByRole("button", { name: /Review Activities/i }).click();
    await page.waitForTimeout(3000);

    const continueBtn = page.getByRole("button", { name: /Continue to Import/i });
    await expect(continueBtn).toBeEnabled({ timeout: 90000 });
    await continueBtn.click();
    await page.waitForTimeout(1000);

    await expect(page.getByText("To Import", { exact: true }).first()).toBeVisible({
      timeout: 10000,
    });

    const importBtn = page.getByRole("button", { name: /Import \d+ Activit/i });
    await expect(importBtn).toBeEnabled({ timeout: 10000 });
    await importBtn.click();

    await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 120000 });
  });

  test("12. Holdings page shows imported assets across exchanges and currencies", async () => {
    test.setTimeout(120000);

    await page.goto(`${BASE_URL}/holdings`, { waitUntil: "domcontentloaded" });
    await waitForSyncToast(page, 90000);
    await page.waitForTimeout(2000);

    const holdingsTable = page.locator("table").first();
    await expect(holdingsTable).toBeVisible({ timeout: 15000 });

    // Each of these is a marker for a different exchange/currency lane:
    //  APC      → Apple via XETRA in EUR
    //  AAPL     → Apple on NASDAQ in USD
    //  SAP      → SAP on XETRA in EUR
    //  VOD      → Vodafone on LSE in GBp
    //  SHOP     → Shopify on TSX in CAD (and NYSE in USD)
    //  BRK.B    → share-class dot preserved
    //  4GLD     → Xetra-Gold ETC, METAL classification
    //  BTC-USD  → crypto
    for (const marker of ["APC", "AAPL", "SAP", "VOD", "SHOP", "BRK.B", "4GLD", "BTC"]) {
      await expect(
        page
          .getByRole("row")
          .filter({ hasText: new RegExp(escapeRegex(marker)) })
          .first(),
      ).toBeVisible({ timeout: 15000 });
    }
  });
});
