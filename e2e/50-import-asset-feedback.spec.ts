import { expect, test } from "@playwright/test";
import { api, createAccount, deposit, uniqueName } from "./api";
import { BASE_URL, loginIfNeeded } from "./helpers";

for (const { mode, dir, width } of [
  { mode: "activities", dir: "ltr", width: 1280 },
  { mode: "activities", dir: "rtl", width: 390 },
  { mode: "holdings", dir: "ltr", width: 390 },
  { mode: "holdings", dir: "rtl", width: 1280 },
] as const) {
  test(`${mode}: batch progress survives a connection failure (${dir}, ${width}px)`, async ({
    page,
    context,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await loginIfNeeded(page);
    const account = await createAccount(page, { name: uniqueName(`Preview ${mode} ${dir}`) });
    if (mode === "holdings") {
      await api(page, "PUT", `/accounts/${account.id}`, { ...account, trackingMode: "HOLDINGS" });
    } else {
      await deposit(page, account.id, 1000, "USD", "2024-01-14T00:00:00Z");
    }

    const suffix = Date.now().toString(36).toUpperCase();
    const symbols = Array.from({ length: 6 }, (_, index) => `PREVIEW${index}${suffix}`);
    for (const symbol of symbols) {
      await api(page, "POST", "/assets", {
        kind: "INVESTMENT",
        name: symbol,
        displayCode: symbol,
        instrumentSymbol: symbol,
        instrumentType: "EQUITY",
        quoteCcy: "USD",
        quoteMode: "MANUAL",
        isActive: true,
      });
    }
    const csv =
      mode === "holdings"
        ? [
            "date,symbol,quantity,avgCost,currency",
            ...symbols.map((symbol) => `2024-01-15,${symbol},1,10,USD`),
          ].join("\n")
        : [
            "date,symbol,instrumentType,quantity,activityType,unitPrice,currency",
            ...symbols.map((symbol) => `2024-01-15,${symbol},EQUITY,1,BUY,10,USD`),
          ].join("\n");

    const requests: string[][] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    await page.route("**/api/v1/activities/import/assets/preview", async (route) => {
      const body = route.request().postDataJSON() as { candidates: { symbol: string }[] };
      requests.push(body.candidates.map((candidate) => candidate.symbol));
      // Hold the second real request so completed progress can be inspected.
      // No API responses or persistence are mocked: offline mode supplies the failure.
      if (requests.length === 2) await gate;
      if (requests.length === 3 && width === 390) await retryGate;
      await route.continue();
    });

    try {
      await page.goto(`${BASE_URL}/import?account=${account.id}&dir=${dir}`);
      await expect(page.locator("html")).toHaveAttribute("dir", dir);
      await page.locator('input[type="file"]').setInputFiles({
        name: "asset-feedback.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(csv),
      });
      await page.getByRole("button", { name: /Configure Mapping/i }).click();
      await page.getByRole("button", { name: /Review Assets/i }).click();

      const feedback = page.getByTestId("asset-preview-feedback");
      await expect(feedback.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "5");
      await expect(
        page.getByRole("button", {
          name: mode === "holdings" ? /Review Holdings/i : /Review Activities/i,
        }),
      ).toBeDisabled();
      await expect(page.getByTestId("asset-review-row")).toHaveCount(5);
      await expect(
        page.getByTestId("asset-review-row").first().getByRole("button").last(),
      ).toBeDisabled();

      await context.setOffline(true);
      release();
      await expect(feedback.getByRole("alert")).toContainText("Couldn’t connect to the server");
      await expect(feedback.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "5");
      await expect(page.getByTestId("asset-review-row")).toHaveCount(5);
      await expect(
        page.getByTestId("asset-review-row").first().getByRole("button").last(),
      ).toBeEnabled();

      await feedback.getByText("Technical details", { exact: true }).click();
      const diagnostics = await feedback.locator("pre").textContent();
      expect(diagnostics).toContain("result=network");
      expect(diagnostics).not.toContain(account.id);
      for (const symbol of symbols) expect(diagnostics).not.toContain(symbol);
      const overflow = await feedback.evaluate(
        (element) => element.scrollWidth > element.clientWidth + 1,
      );
      expect(overflow).toBe(false);

      await context.setOffline(false);
      await feedback.getByRole("button", { name: /Check remaining assets/ }).click();
      if (width === 390) {
        await expect.poll(() => requests.length).toBe(3);
        // Exercise the real kept-screen Activity lifecycle used by phone web
        // and iOS/Android Tauri, while the real retry response is pending.
        const navigation = page.getByRole("navigation", { name: "Primary navigation" });
        await navigation.getByRole("link", { name: "Holdings", exact: true }).click();
        await expect(page).toHaveURL(/\/holdings/);
        const response = page.waitForResponse("**/api/v1/activities/import/assets/preview");
        releaseRetry();
        await (await response).finished();
        await navigation.getByRole("link", { name: "Dashboard", exact: true }).click();
        await expect(page).toHaveURL(/\/import/);
      }
      const review = page.getByRole("button", {
        name: mode === "holdings" ? /Review Holdings/i : /Review Activities/i,
      });
      await expect(review).toBeEnabled();
      expect(requests).toEqual([symbols.slice(0, 5), symbols.slice(5), symbols.slice(5)]);
      await review.click();
      const confirm = page.getByRole("button", {
        name: mode === "holdings" ? /Revalidate & Continue/i : /Continue to Import/i,
      });
      await expect(confirm).toBeEnabled();
      await confirm.click();
      await page
        .getByRole("button", {
          name: mode === "holdings" ? /Import.*1.*Snapshot/i : /Import.*6.*Activities/i,
        })
        .click();
      await expect(page.getByText("Import Complete", { exact: true })).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      release();
      releaseRetry();
      if (!page.isClosed()) {
        await context.setOffline(false);
        await page.unroute("**/api/v1/activities/import/assets/preview");
      }
    }
  });
}

for (const { accountType, activityType, dir } of [
  { accountType: "CASH", activityType: "DEPOSIT", dir: "ltr" },
  { accountType: "CREDIT_CARD", activityType: "WITHDRAWAL", dir: "rtl" },
] as const) {
  test(`${accountType}: transaction validation finishes on a hidden phone screen (${dir})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 900 });
    await loginIfNeeded(page);
    const account = await createAccount(page, {
      name: uniqueName(`Kept ${accountType}`),
      accountType,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let checks = 0;
    let previews = 0;
    await page.route("**/api/v1/activities/import/assets/preview", async (route) => {
      previews++;
      await route.continue();
    });
    await page.route("**/api/v1/activities/import/check", async (route) => {
      if (++checks === 1) await gate;
      await route.continue();
    });
    try {
      await page.goto(`${BASE_URL}/import?account=${account.id}&dir=${dir}`);
      await page.locator('input[type="file"]').setInputFiles({
        name: "transactions.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(`date,activityType,amount,currency\n2024-01-15,${activityType},10,USD`),
      });
      await page.getByRole("button", { name: /Configure Mapping/i }).click();
      await page.getByRole("button", { name: /Review Transactions/i }).click();
      await expect.poll(() => checks).toBe(1);
      const confirm = page.getByRole("button", { name: /Continue to Import/i });
      await expect(page.getByRole("button", { name: /Revalidate & Continue/i })).toBeDisabled();
      const navigation = page.getByRole("navigation", { name: "Primary navigation" });
      await navigation.getByRole("link", { name: "Holdings", exact: true }).click();
      await expect(page).toHaveURL(/\/holdings/);
      const response = page.waitForResponse("**/api/v1/activities/import/check");
      release();
      await (await response).finished();
      await navigation.getByRole("link", { name: "Dashboard", exact: true }).click();
      await expect(page).toHaveURL(/\/import/);
      await expect(confirm).toBeEnabled();
      expect(checks).toBe(1);
      expect(previews).toBe(0);
      await confirm.click();
      await page.getByRole("button", { name: /Import.*1.*Activit/i }).click();
      await expect(page.getByText("Import Complete", { exact: true })).toBeVisible();
    } finally {
      release();
      if (!page.isClosed()) {
        await page.unroute("**/api/v1/activities/import/check");
        await page.unroute("**/api/v1/activities/import/assets/preview");
      }
    }
  });
}
