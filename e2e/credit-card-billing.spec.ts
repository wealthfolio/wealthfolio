import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test.use({ timezoneId: "America/New_York" });

for (const direction of ["ltr", "rtl"] as const) {
  test(`credit card statements preserve closing balances and open their transactions (${direction})`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    if (direction === "rtl") await page.setViewportSize({ width: 390, height: 844 });
    await completeOnboardingIfNeeded(page);
    const api = `${BASE_URL}/api/v1`;
    const timezone = await page.request.put(`${api}/settings`, { data: { timezone: "UTC" } });
    expect(timezone.ok(), await timezone.text()).toBeTruthy();
    const create = await page.request.post(`${api}/accounts`, {
      data: {
        name: `Billing ${direction} ${Date.now().toString(36)}`,
        accountType: "CREDIT_CARD",
        currency: "USD",
        isDefault: false,
        isActive: true,
        trackingMode: "TRANSACTIONS",
        meta: '{"unrelated":{"kept":true}}',
      },
    });
    expect(create.ok(), await create.text()).toBeTruthy();
    const account = await create.json();
    const rejected = await page.request.put(`${api}/accounts/${account.id}`, {
      data: {
        ...account,
        meta: '{"creditCardBilling":{"closingDay":32,"dueDay":20}}',
      },
    });
    expect(rejected.status()).toBe(400);
    // Billing settings are inactive for other account types. Switching back
    // to a card must validate them again, before they can affect statements.
    const nonCard = {
      ...account,
      accountType: "CASH",
      meta: '{"creditCardBilling":{"closingDay":32,"dueDay":20}}',
    };
    const changedType = await page.request.put(`${api}/accounts/${account.id}`, { data: nonCard });
    expect(changedType.ok(), await changedType.text()).toBeTruthy();
    const invalidCard = await page.request.put(`${api}/accounts/${account.id}`, {
      data: { ...nonCard, accountType: "CREDIT_CARD" },
    });
    expect(invalidCard.status()).toBe(400);
    const restoredCard = await page.request.put(`${api}/accounts/${account.id}`, { data: account });
    expect(restoredCard.ok(), await restoredCard.text()).toBeTruthy();
    const statements = () => page.request.get(`${api}/accounts/${account.id}/statements`);
    expect(await (await statements()).json()).toEqual([]);

    await gotoAppPath(page, `/settings/accounts?dir=${direction}`);
    const row = page
      .getByTestId("settings-accounts-page")
      .filter({ visible: true })
      .getByRole("listitem")
      .filter({ has: page.getByRole("link", { name: account.name, exact: true }) })
      .last();
    await row.getByRole("button", { name: "Open" }).click();
    await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    const modal = page.getByTestId("account-modal").filter({ visible: true }).first();
    await modal.getByRole("switch", { name: "Billing statements" }).click();
    await modal.getByLabel("Closing day (1–31)", { exact: true }).fill("10");
    await modal.getByLabel("Payment due day (1–31)", { exact: true }).fill("20");
    await modal.getByTestId("account-submit-button").click();
    await expect(modal).not.toBeVisible();
    const accounts = await (await page.request.get(`${api}/accounts`)).json();
    expect(
      JSON.parse(accounts.find((a: { id: string }) => a.id === account.id).meta),
    ).toMatchObject({
      unrelated: { kept: true },
      creditCardBilling: { closingDay: 10, dueDay: 20 },
    });
    const current = (await (await statements()).json())[0];
    // The previous close is one calendar day before the current cycle starts.
    const previousClose = new Date(`${current.startDate}T12:00:00Z`);
    previousClose.setUTCDate(previousClose.getUTCDate() - 1);
    const closingDay = previousClose.toISOString().slice(0, 10);
    const closingActivityIds: string[] = [];
    for (const [kind, date, amount] of [
      ["WITHDRAWAL", closingDay, "120.50"],
      ["CREDIT", closingDay, "20.10"],
      ["TRANSFER_IN", current.startDate, 80],
      ["WITHDRAWAL", current.startDate, 25],
    ] as const) {
      const response = await page.request.post(`${api}/activities`, {
        data: {
          accountId: account.id,
          activityType: kind,
          activityDate: date,
          amount,
          currency: "USD",
          fee: 0,
          needsReview: false,
        },
      });
      expect(response.ok(), await response.text()).toBeTruthy();
      const activity = await response.json();
      if (date === closingDay) closingActivityIds.push(activity.id);
    }
    const result = await (await statements()).json();
    expect(result[0]).toMatchObject({
      isClosed: false,
      balances: [{ currency: "USD", balance: expect.any(String) }],
    });
    expect(result[1]).toMatchObject({
      isClosed: true,
      closingDate: closingDay,
      balances: [{ currency: "USD", balance: expect.any(String) }],
    });
    expect(Number(result[0].balances[0].balance)).toBe(45.4);
    expect(Number(result[1].balances[0].balance)).toBe(100.4);

    const spending = await page.request.put(`${api}/spending/settings`, {
      data: { enabled: true, accountIds: [account.id] },
    });
    expect(spending.ok(), await spending.text()).toBeTruthy();
    await gotoAppPath(page, `/accounts/${account.id}?dir=${direction}`);
    const panel = page
      .locator('[data-slot="card"]')
      .filter({ has: page.getByText("Billing statements", { exact: true }) })
      .filter({ visible: true })
      .first();
    // RTL formatters surround amounts with Unicode direction isolates.
    await expect(panel.getByText(/\$45\.40/)).toBeVisible();
    await expect(panel.getByText(/\$100\.40/)).toBeVisible();
    await expect(panel.getByText("Statement balance", { exact: true }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("billing.png"), fullPage: true });
    const href = `/activities?account=${account.id}&from=${result[1].startDate}&to=${closingDay}`;
    const periodSearch = page.waitForResponse((response) => {
      if (!response.url().includes("/spending/cash-activities/search")) return false;
      const request = response.request().postDataJSON();
      return Boolean(
        request?.accountIds?.includes(account.id) && request.startDate && request.endDate,
      );
    });
    await panel.locator(`a[href="${href}"]`).click();
    await expect(page).toHaveURL(new RegExp(`accounts?=${account.id}`));
    await expect(page).toHaveURL(new RegExp(`to=${closingDay}`));
    const search = await periodSearch;
    expect(search.ok(), await search.text()).toBeTruthy();
    expect(search.request().postDataJSON()).toMatchObject({
      startDate: result[1].startDate,
      endDate: closingDay,
    });
    const matches = await search.json();
    expect(matches.items.map((item: { id: string }) => item.id).sort()).toEqual(
      closingActivityIds.sort(),
    );
  });
}
