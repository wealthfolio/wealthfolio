import { expect, test, type Page } from "./fixtures";
import { api, createAccount, deposit, uniqueName } from "./api";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

interface Valued {
  valueStatus: string;
  missingFx: { itemId: string; fromCurrency: string; toCurrency: string }[];
}

async function selectRateCurrency(page: Page, label: string, code: string) {
  const form = page.getByRole("dialog", { name: "Add exchange rate", exact: true });
  await form.getByRole("combobox", { name: label, exact: true }).click();
  const picker = page.locator('[data-slot="popover-content"][data-open]');
  await picker.getByPlaceholder("Search currency...").fill(code);
  await picker
    .getByRole("option")
    .filter({ hasText: `(${code})` })
    .click();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
}

let profileToDelete: { id: string; name: string } | undefined;

// While a second profile exists, the server refuses requests that name no profile,
// so the specs after this one need it gone, even when this test times out.
test.afterEach(async ({ page }) => {
  if (!profileToDelete) return;
  const { id, name } = profileToDelete;
  profileToDelete = undefined;
  // A crashed page can't navigate, and the profile must still be deleted.
  await page.goto("about:blank").catch(() => undefined);
  const session = await api<{ scopeId: string }>(page, "POST", "/profiles/unlock_profile", {
    profileId: id,
  });
  const deleted = await page.request.post(`${BASE_URL}/api/v1/profiles/delete_profile`, {
    headers: { "x-wf-profile-scope": session.scopeId },
    data: { profileId: id, confirmation: name },
  });
  expect(deleted.ok(), await deleted.text()).toBe(true);
});

for (const [direction, width, currency] of [
  ["ltr", 1440, "COP"],
  ["rtl", 1440, "CLP"],
  ["ltr", 390, "KRW"],
  ["rtl", 390, "IDR"],
] as const) {
  test(`missing FX stays unavailable and recovers across both dashboards (${direction}, ${width}px)`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width, height: 1000 });
    await completeOnboardingIfNeeded(page);
    // Recovery is checked on whole-portfolio totals, and Health names the currency only
    // when it is the one missing, so other specs' accounts can't share this database.
    const profileName = `Missing FX ${currency}`;
    const profile = await api<{ id: string }>(page, "POST", "/profiles/create_profile", {
      name: profileName,
      avatarId: "clay-bot-animated",
    });
    profileToDelete = { id: profile.id, name: profileName };
    const session = await api<{ scopeId: string }>(page, "POST", "/profiles/unlock_profile", {
      profileId: profile.id,
    });
    await page.context().setExtraHTTPHeaders({ "x-wf-profile-scope": session.scopeId });
    const providers = await api<{ id: string; priority: number; enabled: boolean }[]>(
      page,
      "GET",
      "/providers/settings",
    );
    let goalPage: Page | undefined;
    const date = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    try {
      for (const provider of providers.filter((provider) => provider.enabled)) {
        await api(page, "PUT", "/providers/settings", {
          providerId: provider.id,
          priority: provider.priority,
          enabled: false,
        });
      }
      await api(page, "PUT", "/settings", {
        onboardingCompleted: true,
        language: "en",
        timezone: "UTC",
        baseCurrency: "AED",
        autoUpdateCheckEnabled: false,
      });
      const account = await createAccount(page, {
        name: uniqueName(`Missing FX ${currency}`),
        currency,
        accountType: "CASH",
      });
      await deposit(page, account.id, 5_000_000, currency, `${date}T12:00:00Z`);
      const knownAccount = await createAccount(page, {
        name: uniqueName("AED savings"),
        currency: "AED",
        accountType: "CASH",
      });
      await deposit(page, knownAccount.id, 10_000, "AED", `${date}T12:00:00Z`);
      await api(page, "POST", "/alternative-assets", {
        kind: "property",
        name: uniqueName(`${currency} property`),
        currency,
        currentValue: "330000000",
        valueDate: date,
      });
      const current = () =>
        api<{ summary: Valued & { totalValueBase: number }; accounts: { totalValue: number }[] }>(
          page,
          "POST",
          "/valuations/current/query",
          { filter: { type: "accounts", accountIds: [account.id] }, includeAccounts: true },
        );
      const netWorth = () => api<Valued & { netWorth: number }>(page, "GET", "/net-worth");
      const history = () =>
        api<(Valued & { netWorth: number })[]>(
          page,
          "GET",
          `/net-worth/history?startDate=${date}&endDate=${today}`,
        );
      await expect.poll(async () => (await current()).summary.valueStatus).toBe("unavailable");
      // The existing sync job registers bridges even with all providers disabled.
      // They have no quotes yet, so merely registering them cannot fabricate values.
      await expect
        .poll(async () => {
          const assets = await api<{ instrumentKey: string | null }[]>(page, "GET", "/assets");
          const keys = assets.map((asset) => asset.instrumentKey);
          return keys.includes(`FX:${currency}/USD`) && keys.includes("FX:USD/AED");
        })
        .toBe(true);
      const missing = await current();
      expect(missing.summary.totalValueBase).toBe(0);
      expect(missing.accounts[0].totalValue).toBe(5_000_000);
      expect(missing.summary.missingFx).toContainEqual(
        expect.objectContaining({ fromCurrency: currency, toCurrency: "AED" }),
      );
      await expect.poll(async () => (await netWorth()).valueStatus).toBe("unavailable");
      const incompleteHistory = await history();
      expect(incompleteHistory.length).toBeGreaterThan(0);
      expect(incompleteHistory.every((point) => point.valueStatus === "unavailable")).toBe(true);
      const goalTitle = uniqueName(`${currency} savings goal`);
      const goal = await api<{ id: string }>(page, "POST", "/goals", {
        goalType: "home",
        title: goalTitle,
        targetAmount: 20000,
      });
      await api(page, "PUT", `/goals/${goal.id}/funding`, [
        { accountId: knownAccount.id, sharePercent: 100 },
      ]);
      await expect
        .poll(
          async () =>
            (await api<{ summaryCurrentValue: number }>(page, "GET", `/goals/${goal.id}`))
              .summaryCurrentValue,
        )
        .toBe(10000);
      await api(page, "PUT", `/goals/${goal.id}/funding`, [
        { accountId: account.id, sharePercent: 100 },
      ]);
      const unknownGoal = await api<{
        summaryCurrentValue: number | null;
        summaryProgress: number | null;
      }>(page, "GET", `/goals/${goal.id}`);
      expect(unknownGoal.summaryCurrentValue).toBeNull();
      expect(unknownGoal.summaryProgress).toBeNull();
      await api(page, "POST", "/health/check");
      await gotoAppPath(page, `/dashboard?dir=${direction}`);
      await expect(page.getByTestId("portfolio-balance").first()).toHaveText("N/A");
      await expect(page.getByRole("link").filter({ hasText: goalTitle })).toContainText("N/A");
      await expect(
        page.getByRole("status").filter({ hasText: "Total unavailable" }).first(),
      ).toHaveCount(0);
      await expect(page.getByText(/Some historical values are unavailable/)).toHaveCount(0);
      await expect(page.getByRole("link", { name: `${currency} → AED`, exact: true })).toHaveCount(
        0,
      );
      for (const close of await page
        .getByRole("button", { name: "Close toast", exact: true })
        .all()) {
        await close.click();
      }
      await page.screenshot({ path: test.info().outputPath("investments.png"), fullPage: true });
      await page.getByRole("button", { name: "Net Worth", exact: true }).click();
      await expect(
        page.getByTestId("portfolio-balance").filter({ hasText: "N/A" }).last(),
      ).toBeVisible();
      const attention = page.getByRole("region", { name: "Needs attention" });
      await expect(page.getByText("Known subtotal")).toBeVisible();
      await expect(page.getByText("0.0%", { exact: true })).toHaveCount(0);
      await expect(page.getByText("—", { exact: true }).last()).toBeVisible();
      const review = attention.getByRole("link", {
        name: `Missing exchange rate: ${currency} → AED`,
      });
      await expect(review).toHaveCount(1);
      await expect(review).toHaveAttribute("href", "/health");
      await expect(
        page.getByText(/Total unavailable|Some historical values are unavailable/),
      ).toHaveCount(0);
      await expect(page.getByRole("link", { name: `${currency} → AED`, exact: true })).toHaveCount(
        0,
      );
      await review.scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({ path: test.info().outputPath("net-worth.png"), fullPage: true });
      await attention.screenshot({
        path: test.info().outputPath("attention.png"),
        animations: "disabled",
      });
      // A known AED balance must not turn into 100% when a foreign account is unknown.
      await gotoAppPath(page, `/insights?dir=${direction}`);
      const accountAllocation = page.locator('[data-widget-id="accounts"]');
      await expect(accountAllocation.getByText("N/A", { exact: true })).toBeVisible();
      await expect(accountAllocation.locator(".recharts-surface")).toHaveCount(0);
      await accountAllocation.screenshot({
        path: test.info().outputPath("account-allocation-missing.png"),
        animations: "disabled",
      });
      await page.screenshot({
        path: test.info().outputPath("account-allocation-missing-page.png"),
        fullPage: true,
        animations: "disabled",
      });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const allocationHelp = accountAllocation.getByRole("link", {
        name: "Open Health Center for Account Allocation issue",
      });
      await expect(allocationHelp).toHaveAttribute("href", "/health");
      if (width === 1440) {
        await allocationHelp.hover();
        const hint = page.getByRole("tooltip");
        await expect(hint).toContainText("some prices or exchange rates are missing");
        await allocationHelp.focus();
        await expect(hint).toContainText("Review the details in the Health Center");
        const cardBounds = await accountAllocation.boundingBox();
        const hintBounds = await hint.boundingBox();
        expect(cardBounds).not.toBeNull();
        expect(hintBounds).not.toBeNull();
        if (cardBounds && hintBounds) {
          const x = Math.min(cardBounds.x, hintBounds.x);
          const y = Math.min(cardBounds.y, hintBounds.y);
          await page.screenshot({
            path: test.info().outputPath("account-allocation-hint.png"),
            animations: "disabled",
            clip: {
              x,
              y,
              width: Math.max(cardBounds.x + cardBounds.width, hintBounds.x + hintBounds.width) - x,
              height:
                Math.max(cardBounds.y + cardBounds.height, hintBounds.y + hintBounds.height) - y,
            },
          });
        }
      }
      await allocationHelp.click();
      await expect(page).toHaveURL(/\/health/);
      await gotoAppPath(page, `/goals?dir=${direction}`);
      const goalCard = page.getByRole("link").filter({ hasText: goalTitle });
      await expect(goalCard.getByText("N/A", { exact: true })).toHaveCount(3);
      await page.screenshot({
        path: test.info().outputPath("goals-missing.png"),
        fullPage: true,
        animations: "disabled",
      });
      await goalCard.click();
      if (width < 768) {
        await expect(page.locator("[data-stack-screen]:visible")).toHaveCount(1);
      }
      await expect(page.getByRole("paragraph").filter({ hasText: /^N\/A$/ })).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Review the details in the Health Center." }),
      ).toHaveAttribute("href", "/health");
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath("goal-detail-missing.png"),
        fullPage: true,
        animations: "disabled",
      });
      await gotoAppPath(page, `/dashboard?dir=${direction}`);
      await page.getByRole("button", { name: "Net Worth", exact: true }).click();
      await review.click();
      await expect(page).toHaveURL(/\/health/);
      await page.getByText(`Missing exchange rate for ${currency}`, { exact: true }).click();
      const details = page.getByRole("dialog");
      const openRates = details.getByRole("link", { name: "Open General Settings", exact: true });
      await expect(openRates).toHaveAttribute("href", "/settings/general");
      await details.screenshot({
        path: test.info().outputPath("health-rate-details.png"),
        animations: "disabled",
      });
      await openRates.click();
      await expect(page).toHaveURL(/\/settings\/general/);
      await page.getByRole("button", { name: "Add rate", exact: true }).first().click();
      const form = page.getByRole("dialog", { name: "Add exchange rate", exact: true });
      await selectRateCurrency(page, "From currency", currency);
      await selectRateCurrency(page, "To currency", "AED");
      const rateInput = form.getByRole("textbox", { name: "Exchange rate", exact: true });
      await rateInput.fill("0.001");
      const save = form.getByRole("button", { name: "Add exchange rate", exact: true });

      if (width === 1440 && direction === "ltr") {
        // Simulate a persistence failure at the HTTP boundary; a retry still uses the real API.
        let failSave: () => void = () => {};
        const pending = new Promise<void>((resolve) => {
          failSave = resolve;
        });
        await page.route(
          "**/api/v1/exchange-rates",
          async (route) => {
            await pending;
            await route.fulfill({
              status: 500,
              contentType: "application/json",
              body: JSON.stringify({ message: "Test save failure" }),
            });
          },
          { times: 1 },
        );
        const failed = page.waitForResponse(
          (response) =>
            response.status() === 500 &&
            new URL(response.url()).pathname === "/api/v1/exchange-rates",
        );
        await save.click();
        try {
          await expect(save).toBeDisabled();
          await expect(rateInput).toBeDisabled();
          await expect(form.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
          await form.screenshot({
            path: test.info().outputPath("rate-save-pending.png"),
            animations: "disabled",
          });
        } finally {
          failSave();
        }
        await failed;
        await expect(save).toBeEnabled();
        await expect(form).toBeVisible();
        await expect(rateInput).toHaveValue("0.001");
        await expect(
          form.getByRole("combobox", { name: "From currency", exact: true }),
        ).toContainText(currency);
        await expect(
          form.getByRole("combobox", { name: "To currency", exact: true }),
        ).toContainText("AED");
        await page.screenshot({
          path: test.info().outputPath("rate-save-failed.png"),
          fullPage: true,
          animations: "disabled",
        });
      }
      // Keep an unavailable goal open to verify the post-write event refreshes
      // its cached summary, without reloads or an explicit summary-refresh call.
      goalPage = await page.context().newPage();
      await goalPage.setViewportSize({ width, height: 1000 });
      await gotoAppPath(goalPage, `/goals/${goal.id}?dir=${direction}`);
      await expect(goalPage.getByRole("paragraph").filter({ hasText: /^N\/A$/ })).toBeVisible();
      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/api/v1/exchange-rates",
      );
      await save.click();
      const response = await saved;
      expect(response.ok()).toBe(true);
      await expect(form).not.toBeVisible();
      await expect.poll(async () => (await current()).summary.totalValueBase).toBe(5000);
      await expect.poll(async () => (await netWorth()).valueStatus).toBe("complete");
      expect((await netWorth()).netWorth).toBe(345000);
      await expect
        .poll(async () =>
          (await history()).every(
            (point) => point.valueStatus === "complete" && point.netWorth === 345000,
          ),
        )
        .toBe(true);
      await expect
        .poll(
          async () =>
            (await api<{ summaryCurrentValue: number | null }>(page, "GET", `/goals/${goal.id}`))
              .summaryCurrentValue,
        )
        .toBe(5000);
      await expect(goalPage.getByText("N/A", { exact: true })).toHaveCount(0);
      await expect(goalPage.getByText(/5,000/).first()).toBeVisible();
      await expect(
        goalPage.getByRole("link", { name: "Review the details in the Health Center." }),
      ).toHaveCount(0);
      await goalPage.screenshot({
        path: test.info().outputPath("goal-detail-recovered.png"),
        fullPage: true,
        animations: "disabled",
      });
      await gotoAppPath(page, `/goals?dir=${direction}`);
      await expect(
        page.getByRole("link").filter({ hasText: goalTitle }).getByText("N/A", { exact: true }),
      ).toHaveCount(0);
      // Reload to check the actual adapter responses render after recovery.
      await gotoAppPath(page, `/dashboard?dir=${direction}`);
      await page.getByRole("button", { name: "Investments", exact: true }).click();
      await expect(page.getByTestId("portfolio-balance-value").first()).toContainText("15,000");
      await page.getByRole("button", { name: "Net Worth", exact: true }).click();
      await expect(
        page
          .getByTestId("portfolio-balance-value")
          .filter({ hasText: width < 768 ? "345K" : "345,000" })
          .last(),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: /Missing exchange rate:|Review valuation issues/ }),
      ).toHaveCount(0);
      await expect(page.getByText("Known subtotal")).toHaveCount(0);
      await page.screenshot({
        path: test.info().outputPath("net-worth-recovered.png"),
        fullPage: true,
        animations: "disabled",
      });
      await gotoAppPath(page, `/insights?dir=${direction}`);
      await expect(accountAllocation.locator(".recharts-surface")).toBeVisible();
      await expect(accountAllocation.getByText("N/A", { exact: true })).toHaveCount(0);
      await expect(allocationHelp).toHaveCount(0);
      await accountAllocation.screenshot({
        path: test.info().outputPath("account-allocation-recovered.png"),
        animations: "disabled",
      });
    } finally {
      await goalPage?.close();
    }
  });
}
