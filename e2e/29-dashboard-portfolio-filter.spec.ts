import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";

test("dashboard portfolio selection, creation, persistence, deletion and mobile layout", async ({
  page,
}, testInfo) => {
  test.setTimeout(180000);
  await completeOnboardingIfNeeded(page);
  const originalSettings = await page.request.get(`${BASE_URL}/api/v1/settings`);
  expect(originalSettings.ok()).toBe(true);
  const original = (await originalSettings.json()) as {
    baseCurrency: string;
    formattingRegion: string;
    currencyFormattingRegions?: Record<string, string>;
  };
  const originalCurrency = original.baseCurrency;
  try {
    // These exact portfolio amounts are in CAD, written as the US region shows it
    // (CA$); earlier specs can change the profile's reporting currency and region.
    const currency = await page.request.put(`${BASE_URL}/api/v1/settings`, {
      data: { baseCurrency: "CAD", formattingRegion: "US", currencyFormattingRegions: {} },
    });
    expect(currency.ok()).toBe(true);
    const accountIds: string[] = [];
    for (const [name, amount] of [
      ["Portfolio filter savings", 1000000],
      ["Portfolio filter checking", 200],
    ] as const) {
      const response = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
        data: {
          name,
          accountType: "CASH",
          currency: "CAD",
          isDefault: false,
          isActive: true,
          trackingMode: "TRANSACTIONS",
        },
      });
      expect(response.ok()).toBe(true);
      const { id } = (await response.json()) as { id: string };
      accountIds.push(id);
      const deposit = await page.request.post(`${BASE_URL}/api/v1/activities`, {
        data: {
          accountId: id,
          activityType: "DEPOSIT",
          activityDate: "2026-05-01T12:00:00Z",
          amount,
          currency: "CAD",
          fee: 0,
        },
      });
      expect(deposit.ok()).toBe(true);
    }
    // Wait for our deposits to be valued independently of the shared profile's
    // other assets and liabilities; its net total may be less than our deposits.
    for (const [index, accountId] of accountIds.entries()) {
      await expect
        .poll(
          async () => {
            const response = await page.request.post(
              `${BASE_URL}/api/v1/valuations/current/query`,
              {
                data: { filter: { type: "account", accountId } },
              },
            );
            expect(response.ok()).toBe(true);
            return ((await response.json()) as { summary: { totalValueBase: number } }).summary
              .totalValueBase;
          },
          { timeout: 30000 },
        )
        .toBe(index === 0 ? 1_000_000 : 200);
    }
    // Other specs share this profile, so All Accounts shows whatever the whole
    // profile is worth: compare it with the valuation the dashboard reads. The
    // portfolio totals below stay exact.
    const allAccountsTotal = async () => {
      const response = await page.request.post(`${BASE_URL}/api/v1/valuations/current/query`, {
        data: { filter: { type: "all" } },
      });
      expect(response.ok()).toBe(true);
      const { summary } = (await response.json()) as { summary: { totalValueBase: number } };
      return summary.totalValueBase;
    };
    const expectAllAccountsTotal = async () => {
      await expect
        .poll(
          async () => {
            const total = await allAccountsTotal();
            const text = total.toLocaleString("en-US", {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            });
            return ((await balanceValue.textContent()) ?? "").includes(text);
          },
          { timeout: 30000 },
        )
        .toBe(true);
    };
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
    const filter = page.getByRole("combobox", { name: /^Choose portfolio:/ });
    // Mobile keeps neighbouring views mounted; scope assertions to the investment headline.
    const headlineContainer = page
      .getByRole("button", { name: /^(Hide|Show) Balance$/ })
      .locator("..");
    const balanceValue = headlineContainer.getByTestId("portfolio-balance-value");
    await expect(filter).toHaveAccessibleName("Choose portfolio: All Accounts");
    await expect(
      headlineContainer.locator("..").getByText("All Accounts", { exact: true }),
    ).toHaveCount(0);
    await expectAllAccountsTotal();
    const privacy = page.getByRole("button", { name: /^(Hide|Show) Balance$/ });
    expect(await privacy.evaluate((element) => element.closest("a"))).toBeNull();
    await privacy.focus();
    await expect(privacy).toBeFocused();
    // Focus used to open the update hover card after its 700ms delay.
    await page.waitForTimeout(800);
    await expect(page.getByRole("button", { name: "Update prices", exact: true })).toHaveCount(0);
    await privacy.press("Enter");
    await expect(headlineContainer.getByTestId("portfolio-balance")).toContainText("•••");
    await privacy.press("Enter");
    await expectAllAccountsTotal();
    await headlineContainer.getByTestId("portfolio-balance").hover();
    await expect(page.getByRole("button", { name: "Update prices", exact: true })).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(
      page.getByRole("button", { name: "Update prices", exact: true }),
    ).not.toBeVisible();
    await filter.click();
    await page.getByRole("button", { name: "Add portfolio" }).click();
    await expect(page).toHaveURL(`${BASE_URL}/settings/portfolios`);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Add portfolio", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New portfolio" });
    await dialog.getByLabel("Name", { exact: true }).fill("Dashboard savings");
    await dialog
      .locator("label")
      .filter({ hasText: "Portfolio filter savings" })
      .getByRole("checkbox")
      .click();
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
    await expect(filter).toHaveAccessibleName("Choose portfolio: All Accounts");
    await filter.click();
    await expect(page.getByRole("button", { name: "Add portfolio" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit portfolio" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Manage portfolios" })).toBeVisible();
    await page.getByRole("option", { name: "Dashboard savings" }).click();
    await expect(filter).toHaveAccessibleName("Choose portfolio: Dashboard savings");
    await expect(
      headlineContainer.locator("..").getByText("Dashboard savings", { exact: true }),
    ).toBeVisible();
    await expect(balanceValue).toContainText("1,000,000.00", {
      timeout: 30000,
    });
    await expect(page.locator(`a[href="/accounts/${accountIds[0]}"]`)).toBeVisible();
    await expect(page.locator(`a[href="/accounts/${accountIds[1]}"]`)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("desktop-dashboard.png") });
    await filter.click();
    await expect
      .poll(() => page.getByRole("dialog").evaluate((element) => getComputedStyle(element).opacity))
      .toBe("1");
    const optionIcon = await page
      .getByRole("option", { name: "Dashboard savings" })
      .locator("svg")
      .first()
      .boundingBox();
    const footerIcon = await page
      .getByRole("button", { name: "Manage portfolios" })
      .locator("svg")
      .first()
      .boundingBox();
    expect(optionIcon).not.toBeNull();
    expect(footerIcon).not.toBeNull();
    expect(footerIcon!.x).toBeCloseTo(optionIcon!.x, 0);
    await page.screenshot({ path: testInfo.outputPath("desktop-portfolio-filter.png") });
    await page.getByPlaceholder("Search portfolios…").fill("unmatched xyz");
    await expect(page.getByText("No results.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Manage portfolios" })).toBeVisible();
    await page.getByPlaceholder("Search portfolios…").fill("Dashboard savings");
    await expect(page.getByRole("option", { name: "Dashboard savings" })).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Manage portfolios" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${BASE_URL}/settings/portfolios`);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const editor = page.getByRole("dialog", { name: "Edit portfolio" });
    await editor
      .locator("label")
      .filter({ hasText: "Portfolio filter checking" })
      .getByRole("checkbox")
      .click();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).not.toBeVisible();
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
    await expect(filter).toHaveAccessibleName("Choose portfolio: Dashboard savings");
    await expect(balanceValue).toContainText("1,000,200.00");
    await expect(page.locator(`a[href="/accounts/${accountIds[1]}"]`)).toBeVisible();
    await filter.click();
    await page.getByRole("button", { name: "Manage portfolios" }).click();
    await expect(page).toHaveURL(`${BASE_URL}/settings/portfolios`);
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await editor
      .locator("label")
      .filter({ hasText: "Portfolio filter checking" })
      .getByRole("checkbox")
      .click();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).not.toBeVisible();
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
    await expect(balanceValue).toContainText("1,000,000.00");
    await page.reload();
    await expect(filter).toHaveAccessibleName("Choose portfolio: Dashboard savings");
    await filter.click();
    await page.getByRole("option", { name: "All Accounts" }).click();
    await expectAllAccountsTotal();
    await filter.click();
    await page.getByRole("option", { name: "Dashboard savings" }).click();

    await page.setViewportSize({ width: 320, height: 740 });
    await expect(filter).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("mobile-dashboard.png") });
    await filter.click();
    const sheet = page.getByRole("dialog", { name: "Choose portfolio" });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole("heading", { name: "Choose portfolio" })).toBeFocused();
    await expect(async () => {
      const sheetBounds = await sheet.boundingBox();
      expect(sheetBounds).not.toBeNull();
      expect(sheetBounds?.width).toBeLessThanOrEqual(320);
      expect(sheetBounds?.y).toBeGreaterThanOrEqual(0);
      expect((sheetBounds?.y ?? 0) + (sheetBounds?.height ?? 0)).toBeLessThanOrEqual(741);
    }).toPass();
    await page.screenshot({ path: testInfo.outputPath("mobile-portfolio-sheet.png") });
    await sheet.getByPlaceholder("Search portfolios…").fill("unmatched xyz");
    await expect(sheet.getByText("No results.", { exact: true })).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Manage portfolios" })).toBeVisible();
    await sheet.getByRole("button", { name: "Manage portfolios" }).click();
    await expect(sheet).not.toBeVisible();
    await expect(page).toHaveURL(`${BASE_URL}/settings/portfolios`);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
    await expect(filter).toHaveAccessibleName("Choose portfolio: Dashboard savings");
    await filter.click();
    await sheet.getByRole("option", { name: "All Accounts" }).click();
    await expect(sheet).not.toBeVisible();
    await expect(
      headlineContainer.locator("..").getByText("All Accounts", { exact: true }),
    ).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.getByRole("button", { name: "Hide Balance", exact: true }).click();
    await expect(headlineContainer.getByTestId("portfolio-balance")).toContainText("•••");
    await page.getByRole("button", { name: "Show Balance", exact: true }).click();
    await filter.click();
    await page.getByRole("option", { name: "Dashboard savings" }).click();

    const portfolios = await page.request.get(`${BASE_URL}/api/v1/portfolios`);
    const saved = ((await portfolios.json()) as { id: string; name: string }[]).find(
      (item) => item.name === "Dashboard savings",
    );
    expect(saved).toBeDefined();
    const card = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
      data: {
        name: "Portfolio filter credit card",
        accountType: "CREDIT_CARD",
        currency: "CAD",
        isDefault: false,
        isActive: true,
        trackingMode: "TRANSACTIONS",
      },
    });
    expect(card.ok()).toBe(true);
    const { id: cardId } = (await card.json()) as { id: string };
    const changed = await page.request.put(`${BASE_URL}/api/v1/portfolios/${saved?.id}`, {
      data: { ...saved, accountIds: [cardId] },
    });
    expect(changed.ok()).toBe(true);
    await page.reload();
    await expect(filter).toHaveAccessibleName("Choose portfolio: Dashboard savings");
    // The headline total uses the region's symbol for the CAD reporting currency.
    await expect(balanceValue).toHaveText("CA$0.00", { timeout: 30000 });
    await expect(page.getByText("No accounts to display in this portfolio.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Manage portfolios" })).toHaveAttribute(
      "href",
      "/settings/portfolios",
    );
    await expect(page.getByRole("link", { name: "Add your first account" })).toHaveCount(0);
    const deleted = await page.request.delete(`${BASE_URL}/api/v1/portfolios/${saved?.id}`);
    expect(deleted.ok()).toBe(true);
    await page.reload();
    await expect(filter).toHaveAccessibleName("Choose portfolio: All Accounts");
    await expectAllAccountsTotal();
    const longName = "Long-term savings and fixed income — retirement investment portfolio";
    const longPortfolio = await page.request.post(`${BASE_URL}/api/v1/portfolios`, {
      data: { name: longName, accountIds: [accountIds[0]] },
    });
    expect(longPortfolio.ok()).toBe(true);
    await page.reload();
    await filter.click();
    await page.getByRole("option", { name: longName }).click();
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 320, height: 740 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(filter).toHaveAccessibleName(`Choose portfolio: ${longName}`);
      await expect(balanceValue).toContainText("1,000,000.00");
      await expect(async () => {
        const layout = await page
          .getByRole("button", { name: "Hide Balance", exact: true })
          .evaluate((element) => {
            const eye = element.getBoundingClientRect();
            const balance = element
              .parentElement!.querySelector('[data-testid="portfolio-balance"]')!
              .getBoundingClientRect();
            return {
              centerDifference: Math.abs(eye.y + eye.height / 2 - balance.y - balance.height / 2),
              gap: eye.x - balance.right,
              overflow: document.documentElement.scrollWidth > innerWidth,
              nestedInAnchor: Boolean(element.closest("a")),
            };
          });
        expect(layout.centerDifference).toBeLessThan(2);
        expect(layout.gap).toBeCloseTo(8, 0);
        expect(layout.overflow).toBe(false);
        expect(layout.nestedInAnchor).toBe(false);
      }).toPass();
      await page.screenshot({ path: testInfo.outputPath(`long-name-${viewport.width}.png`) });
    }
  } finally {
    const restored = await page.request.put(`${BASE_URL}/api/v1/settings`, {
      data: {
        ...(originalCurrency !== "CAD" && { baseCurrency: originalCurrency }),
        formattingRegion: original.formattingRegion,
        currencyFormattingRegions: original.currencyFormattingRegions ?? {},
      },
    });
    expect(restored.ok()).toBe(true);
    const settings = await page.request.get(`${BASE_URL}/api/v1/settings`);
    expect(settings.ok()).toBe(true);
    expect(((await settings.json()) as { baseCurrency: string }).baseCurrency).toBe(
      originalCurrency,
    );
  }
});
