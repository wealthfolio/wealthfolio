import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test.describe.configure({ mode: "serial" });

const api = `${BASE_URL}/api/v1`;
const accountIds: string[] = [];
const portfolioName = `Cash breakdown ${Date.now()}`;

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await completeOnboardingIfNeeded(page);
  const rate = await page.request.post(`${api}/exchange-rates`, {
    data: { fromCurrency: "USD", toCurrency: "EUR", rate: 0.9, source: "MANUAL" },
  });
  expect(rate.ok()).toBeTruthy();
  for (const [name, cashBalances] of [
    ["Cash brokerage", { USD: "750", EUR: "100" }],
    ["Cash savings", { USD: "250", EUR: "-100" }],
    ["Cash outside portfolio", { USD: "9999" }],
  ] as const) {
    const account = await page.request.post(`${api}/accounts`, {
      data: {
        name,
        accountType: "SECURITIES",
        currency: "USD",
        trackingMode: "HOLDINGS",
        isActive: true,
        isDefault: false,
      },
    });
    expect(account.ok()).toBeTruthy();
    const { id: accountId } = (await account.json()) as { id: string };
    accountIds.push(accountId);
    const snapshot = await page.request.post(`${api}/snapshots`, {
      data: { accountId, holdings: [], cashBalances, snapshotDate: "2026-05-11" },
    });
    expect(snapshot.ok(), await snapshot.text()).toBeTruthy();
  }
  const portfolio = await page.request.post(`${api}/portfolios`, {
    data: { name: portfolioName, accountIds: accountIds.slice(0, 2) },
  });
  expect(portfolio.ok()).toBeTruthy();
  await page.close();
});

for (const width of [1440, 390]) {
  for (const direction of ["ltr", "rtl"]) {
    test(`cash account breakdown at ${width}px in ${direction}`, async ({ page }) => {
      test.setTimeout(90_000);
      // Pick the saved scope with the desktop selector before exercising either viewport.
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoAppPath(page, `/holdings?dir=${direction}`);
      await page.getByRole("combobox", { name: "All Accounts" }).click();
      await page.getByRole("option", { name: portfolioName }).click();
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator("html")).toHaveAttribute("dir", direction);
      const trigger = page.getByRole("button", { name: "Details for Cash (USD)" });
      await expect(trigger).toBeVisible();
      // Keyboard activation is also the pointer activation path for this native button.
      await trigger.focus();
      await page.keyboard.press("Enter");
      const sheet = page.getByRole("dialog", { name: "Cash (USD)" });
      await expect(sheet).toBeVisible();
      const brokerage = sheet.getByRole("link", { name: /Cash brokerage/ });
      await expect(brokerage).toContainText("750.00");
      await expect(sheet.getByRole("link", { name: /Cash savings/ })).toContainText("250.00");
      await expect(sheet.getByRole("link")).toHaveCount(2);
      await expect(sheet.getByText("Total", { exact: true }).locator("..")).toContainText(
        "1,000.00",
      );
      await expect(sheet.getByRole("heading", { name: "Cash (USD)" })).toBeFocused();
      expect(
        await sheet.evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBeTruthy();
      await page.screenshot({ path: test.info().outputPath(`cash-${width}-${direction}.png`) });

      // The application privacy event updates all mounted amount displays.
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("wf:privacy-changed", { detail: { isBalanceHidden: true } }),
        );
      });
      await expect(brokerage).not.toContainText("750.00");
      await expect(sheet.getByText("Total", { exact: true }).locator("..")).toContainText("••••");
      await page.evaluate(() => {
        window.dispatchEvent(
          new CustomEvent("wf:privacy-changed", { detail: { isBalanceHidden: false } }),
        );
      });
      await page.keyboard.press("Escape");
      await expect(sheet).not.toBeVisible();
      await expect(trigger).toBeFocused();

      await page.getByRole("button", { name: "Details for Cash (EUR)" }).click();
      const euros = page.getByRole("dialog", { name: "Cash (EUR)" });
      await expect(euros.getByRole("link", { name: /Cash savings/ })).toContainText("-€100.00");
      await expect(euros.getByText("Total", { exact: true }).locator("..")).toContainText("€0.00");
      await expect(euros.getByText(/%/)).toHaveCount(0);
      await euros.getByRole("link", { name: /Cash brokerage/ }).click();
      await expect(page).toHaveURL(new RegExp(`/accounts/${accountIds[0]}`));
      await expect(euros).not.toBeVisible();
    });
  }
}
