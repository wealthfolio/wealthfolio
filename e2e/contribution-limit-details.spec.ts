import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

for (const dir of ["ltr", "rtl"]) {
  test(`limit detail exclusions persist and stay local to the limit (${dir})`, async ({ page }) => {
    test.setTimeout(120_000);
    await completeOnboardingIfNeeded(page);
    await page.setViewportSize({ width: dir === "rtl" ? 390 : 1440, height: 1100 });
    const api = `${BASE_URL}/api/v1`;
    const settings = await page.request.put(`${api}/settings`, { data: { baseCurrency: "USD" } });
    expect(settings.ok(), await settings.text()).toBe(true);
    const year = new Date().getFullYear();
    const account = await page.request.post(`${api}/accounts`, {
      data: {
        name: `Rollover detail ${dir}`,
        accountType: "SECURITIES",
        currency: "USD",
        isActive: true,
        isDefault: false,
      },
    });
    expect(account.ok(), await account.text()).toBe(true);
    const { id: accountId } = await account.json();
    let rolloverId = "";
    for (const [activityType, amount] of [
      ["DEPOSIT", 5000],
      ["TRANSFER_IN", 50000],
    ] as const) {
      const response = await page.request.post(`${api}/activities`, {
        data: {
          accountId,
          activityType,
          amount,
          currency: "USD",
          activityDate: `${year}-06-15T12:00:00Z`,
          fee: 0,
          needsReview: false,
          ...(activityType === "TRANSFER_IN" && {
            metadata: JSON.stringify({ flow: { is_external: true } }),
          }),
        },
      });
      expect(response.ok(), await response.text()).toBe(true);
      if (activityType === "TRANSFER_IN") rolloverId = (await response.json()).id;
    }
    const limits: string[] = [];
    for (const groupName of [`Rollover detail ${dir}`, `Other detail limit ${dir}`]) {
      const response = await page.request.post(`${api}/limits`, {
        data: { groupName, contributionYear: year, limitAmount: 24000, accountIds: accountId },
      });
      expect(response.ok(), await response.text()).toBe(true);
      limits.push((await response.json()).id);
    }
    const [limitId, otherId] = limits;
    await gotoAppPath(page, `/settings/contribution-limits?dir=${dir}`);
    const card = page
      .locator('[data-slot="card"]')
      .filter({ has: page.getByText(`Rollover detail ${dir}`, { exact: true }) });
    await card
      .getByRole("link", { name: `Rollover detail ${dir}`, exact: true })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/settings/contribution-limits/${limitId}`));
    if (dir === "rtl") await gotoAppPath(page, `/settings/contribution-limits/${limitId}?dir=rtl`);
    const summary = page
      .locator('[data-slot="card"]')
      .filter({ has: page.getByText("Counted contributions", { exact: true }) });
    await expect(summary).toContainText("$55,000.00");
    const rolloverSwitch = page
      .getByRole("listitem")
      .filter({ hasText: "$50,000.00" })
      .getByRole("switch");
    await expect(rolloverSwitch).toBeChecked();
    await rolloverSwitch.click();
    await expect(summary).toContainText("$5,000.00");
    await expect(rolloverSwitch).not.toBeChecked();
    await expect(page.getByText("Excluded by you", { exact: true })).toBeVisible();
    const other = await page.request.get(`${api}/limits/${otherId}/details`);
    expect(other.ok()).toBe(true);
    expect(Number((await other.json()).calculation.total)).toBe(55000);
    const progress = await page.request.get(`${api}/limits/${limitId}/deposits`);
    expect(Number((await progress.json()).total)).toBe(5000);

    await page.reload();
    await expect(summary).toContainText("$5,000.00");
    await expect(rolloverSwitch).not.toBeChecked();
    await rolloverSwitch.click();
    await expect(summary).toContainText("$55,000.00");
    await expect(rolloverSwitch).toBeChecked();
    const search = await page.request.post(`${api}/activities/search`, {
      data: { accountIdFilter: [accountId], page: 0, pageSize: 100 },
    });
    expect(search.ok()).toBe(true);
    const rollover = (await search.json()).data.find(
      (activity: { id: string }) => activity.id === rolloverId,
    );
    expect(Number(rollover.amount)).toBe(50000);
    expect(rollover.metadata.flow.is_external).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
    ).toBe(true);
  });
}
