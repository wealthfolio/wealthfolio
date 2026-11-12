import { expect, test } from "@playwright/test";
import frHealth from "../apps/frontend/src/i18n/locales/fr/health.json" with { type: "json" };
import arHealth from "../apps/frontend/src/i18n/locales/ar/health.json" with { type: "json" };
import type { HealthIssue } from "../apps/frontend/src/lib/types";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test("engine activity reasons reach the Health Center in French and Arabic", async ({ page }) => {
  test.setTimeout(180_000);
  await completeOnboardingIfNeeded(page);
  const api = `${BASE_URL}/api/v1`;
  const account = await page.request.post(`${api}/accounts`, {
    data: {
      name: `Activity reasons ${Date.now()}`,
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      isArchived: false,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(account.ok(), await account.text()).toBeTruthy();
  const { id: accountId } = await account.json();
  const created = await page.request.post(`${api}/activities`, {
    data: {
      accountId,
      activityType: "BUY",
      subtype: "POSITION_CLOSE",
      activityDate: "2026-05-11T10:00:00Z",
      currency: "USD",
      quantity: 1,
      unitPrice: 10,
      fee: 0,
      needsReview: false,
      asset: { symbol: "AAPL", exchangeMic: "XNAS", kind: "INVESTMENT", quoteCcy: "USD" },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const { id: activityId } = await created.json();
  let issue: HealthIssue | undefined;
  try {
    await expect
      .poll(
        async () => {
          const response = await page.request.post(`${api}/health/check`);
          expect(response.ok()).toBeTruthy();
          const status = await response.json();
          issue = (status.issues as HealthIssue[]).find(
            (candidate) => candidate.code === "data_rejected_activity",
          );
          return issue?.diagnostics
            ?.flatMap((diagnostic) => diagnostic.evidence)
            .find((row) => row.activityIssue?.activityId === activityId)?.activityIssue?.reason
            ?.code;
        },
        { timeout: 60_000 },
      )
      .toBe("CLOSE_BUY_WITHOUT_SHORT_POSITION");
    const evidence = issue?.diagnostics
      ?.flatMap((diagnostic) => diagnostic.evidence)
      .find((row) => row.activityIssue?.activityId === activityId);
    const asset = evidence?.activityIssue?.reason?.params?.asset;
    if (!asset || !evidence?.activityIssue || !issue)
      throw new Error("Missing structured activity evidence");
    for (const [language, catalog, direction, width] of [
      ["fr", frHealth, "ltr", 1440],
      ["ar", arHealth, "rtl", 390],
    ] as const) {
      expect((await page.request.put(`${api}/settings`, { data: { language } })).ok()).toBeTruthy();
      await page.setViewportSize({ width, height: 900 });
      await gotoAppPath(page, `/health?dir=${direction}`);
      await expect(page.locator("html")).toHaveAttribute("dir", direction);
      await page
        .getByText(catalog.issues.data_rejected_activity.title_one, { exact: true })
        .first()
        .click();
      const sheet = page.getByRole("dialog");
      await expect
        .poll(async () => (await sheet.innerText()).replace(/\p{Bidi_Control}/gu, ""))
        .toContain(
          catalog.activityReasons.close_buy_without_short_position.replace("{{asset}}", asset),
        );
      await expect(sheet.getByText(activityId, { exact: false }).first()).toBeVisible();
      await expect(sheet.getByText(issue.title, { exact: true })).toHaveCount(0);
      await expect(sheet.getByText(issue.message, { exact: true })).toHaveCount(0);
      await expect(sheet.getByText(evidence.activityIssue.message, { exact: true })).toHaveCount(0);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBeTruthy();
      await page.screenshot({ path: test.info().outputPath(`activity-reason-${language}.png`) });
    }
  } finally {
    await page.request.delete(`${api}/activities/${activityId}`);
    await page.request.delete(`${api}/accounts/${accountId}`);
    await page.request.put(`${api}/settings`, { data: { language: "en" } });
  }
});
