import { expect, test } from "@playwright/test";
import type { PerformanceResult } from "../apps/frontend/src/lib/types";
import { BASE_URL } from "./helpers";

const SERIES_WARNING =
  "Return series unavailable for mixed scopes because transaction and holdings components use different baselines.";

test("complete mixed-scope P&L stays unmarked on desktop/mobile in LTR/RTL", async ({ page }) => {
  test.setTimeout(180_000);
  const state = await (
    await page.request.post(`${BASE_URL}/api/v1/profiles/get_profile_state`, { data: {} })
  ).json();
  const session =
    state.session ??
    (await (
      await page.request.post(`${BASE_URL}/api/v1/profiles/unlock_profile`, {
        data: { profileId: state.profiles[0].id },
      })
    ).json());
  const headers = { "x-wf-profile-scope": session.scopeId };
  const settings = await page.request.put(`${BASE_URL}/api/v1/settings`, {
    headers,
    data: { onboardingCompleted: true, language: "en", timezone: "UTC", baseCurrency: "USD" },
  });
  expect(settings.ok()).toBeTruthy();
  const accountIds: string[] = [];
  for (const trackingMode of ["TRANSACTIONS", "HOLDINGS"]) {
    const response = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
      headers,
      data: {
        name: trackingMode === "HOLDINGS" ? "Snapshot account" : "Transaction account",
        accountType: "SECURITIES",
        currency: "USD",
        isDefault: false,
        isActive: true,
        isArchived: false,
        trackingMode,
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    accountIds.push((await response.json()).id);
  }
  const deposit = await page.request.post(`${BASE_URL}/api/v1/activities`, {
    headers,
    data: {
      accountId: accountIds[0],
      activityType: "DEPOSIT",
      amount: "1000",
      activityDate: "2026-05-01T12:00:00Z",
      currency: "USD",
    },
  });
  expect(deposit.ok(), await deposit.text()).toBeTruthy();
  for (const snapshotDate of ["2026-05-01", "2026-05-12"]) {
    const snapshot = await page.request.post(`${BASE_URL}/api/v1/snapshots`, {
      headers,
      data: { accountId: accountIds[1], holdings: [], cashBalances: { USD: "1000" }, snapshotDate },
    });
    expect(snapshot.ok(), await snapshot.text()).toBeTruthy();
  }
  expect(
    (await page.request.post(`${BASE_URL}/api/v1/portfolio/recalculate`, { headers })).status(),
  ).toBe(202);
  const filter = { type: "accounts", accountIds };
  const body = { itemType: "account", itemId: "mixed-test", filter };
  let history: PerformanceResult | undefined;
  await expect
    .poll(
      async () => {
        const response = await page.request.post(`${BASE_URL}/api/v1/performance/history`, {
          headers,
          data: body,
        });
        if (!response.ok()) return null;
        const result: PerformanceResult = await response.json();
        history = result;
        return result.summary?.amount;
      },
      { timeout: 90_000 },
    )
    .toBe(0);
  if (!history) throw new Error("Performance history was not returned");
  expect(history.mode).toBe("valueReturn");
  expect(history.isMixedTrackingMode).toBe(true);
  expect(history.summary?.amountStatus).toBe("complete");
  expect(["complete", "notApplicable"]).toContain(history.summary?.basisStatus);
  expect(history.attribution.residual).toBe(0);
  expect(history.dataQuality.warnings).toHaveLength(2);
  expect(history.dataQuality.warnings[1]).toBe(SERIES_WARNING);
  const boundedResponse = await page.request.post(`${BASE_URL}/api/v1/performance/history`, {
    headers,
    data: { ...body, startDate: "2021-05-12", endDate: "2026-05-12" },
  });
  expect(boundedResponse.ok(), await boundedResponse.text()).toBeTruthy();
  const bounded: PerformanceResult = await boundedResponse.json();
  expect(bounded.summary?.amount).toBe(0);
  expect(bounded.series).toHaveLength(0);
  expect(bounded.dataQuality.warnings).toContain(SERIES_WARNING);
  const summaryResponse = await page.request.post(`${BASE_URL}/api/v1/performance/summary`, {
    headers,
    data: { ...body, profile: "summary" },
  });
  expect(summaryResponse.ok(), await summaryResponse.text()).toBeTruthy();
  const summary = await summaryResponse.json();
  expect(summary.summary.amount).toBe(history.summary?.amount);
  expect(summary.dataQuality.warnings).toHaveLength(1);
  expect(summary.dataQuality.warnings[0]).toMatch(/TWR and IRR are unavailable/);
  await page.goto(BASE_URL);
  await expect(page.locator(".app-shell").first()).toBeVisible({ timeout: 30_000 });
  await page.evaluate(
    ({ profileId, accountIds }) => {
      const key = (name: string) => `profile:${profileId}:${name}`;
      const id = `accounts:${[...accountIds].sort().join(",")}`;
      localStorage.setItem(
        key("performance:selectedItems"),
        JSON.stringify([
          {
            id,
            type: "account",
            name: "Complete mixed portfolio",
            accountScope: { type: "accounts", accountIds },
          },
        ]),
      );
      localStorage.setItem(key("performance:selectedItemId"), JSON.stringify(id));
      localStorage.setItem(
        key("performance:dateRange"),
        JSON.stringify({ from: new Date(2021, 4, 12), to: new Date(2026, 4, 12) }),
      );
    },
    { profileId: session.profileId, accountIds },
  );
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const dir of ["ltr", "rtl"]) {
      await page.goto(`${BASE_URL}/performance?dir=${dir}`);
      await expect(page.locator("html")).toHaveAttribute("dir", dir);
      const trigger = page.getByRole("button", { name: /gain\s*\/\s*loss/i });
      await expect(trigger).toBeVisible({ timeout: 30_000 });
      await expect(trigger).toContainText("0.00");
      await expect(trigger).not.toContainText("Partial data");
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Partial data", { exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("note")).toHaveCount(0);
      await page.screenshot({
        path: `test-results/complete-mixed-pnl-${width}-${dir}.png`,
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
      await page
        .getByRole("button", { name: /calculation notes? for value(?: return)?$/i })
        .click();
      await expect(page.getByText(SERIES_WARNING, { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
    }
  }
});
