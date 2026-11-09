import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

for (const dir of ["ltr", "rtl"]) {
  test(`hidden accounts can be selected and removed from contribution limits (${dir})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await completeOnboardingIfNeeded(page);
    await page.setViewportSize({ width: dir === "rtl" ? 390 : 1440, height: 1000 });
    const api = `${BASE_URL}/api/v1`;
    const settings = await page.request.put(`${api}/settings`, { data: { baseCurrency: "USD" } });
    expect(settings.ok(), await settings.text()).toBe(true);
    const year = new Date().getFullYear();
    const sourceName = `Old plan ${dir}`;
    const groupName = `Rollover ${dir}`;
    const ids: string[] = [];
    for (const [name, isActive] of [
      [sourceName, false],
      [`Current plan ${dir}`, true],
    ] as const) {
      const response = await page.request.post(`${api}/accounts`, {
        data: { name, accountType: "SECURITIES", currency: "USD", isActive, isDefault: false },
      });
      expect(response.ok(), await response.text()).toBe(true);
      ids.push((await response.json()).id);
    }
    const [sourceId, destinationId] = ids;
    const transfer = await page.request.post(`${api}/activities/transfer-pair`, {
      data: {
        fromAccountId: sourceId,
        toAccountId: destinationId,
        activityDate: `${year}-06-15T12:00:00Z`,
        sourceAmount: "50000",
        destinationAmount: "50000",
        sourceCurrency: "USD",
        destinationCurrency: "USD",
        transferMode: "cash",
      },
    });
    expect(transfer.ok(), await transfer.text()).toBe(true);
    const response = await page.request.post(`${api}/limits`, {
      data: { groupName, contributionYear: year, limitAmount: 24_000, accountIds: destinationId },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const { id: limitId } = await response.json();

    await gotoAppPath(page, `/settings/contribution-limits?dir=${dir}`);
    const card = page.locator('[data-slot="card"]').filter({
      has: page.getByText(groupName, { exact: true }),
    });
    await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    // Accounts are picked in the edit dialog, opened from the card's actions menu.
    const editAccounts = async () => {
      await card
        .getByRole("button", { name: "Open", exact: true })
        .filter({ visible: true })
        .click();
      await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
      return page.getByRole("group", { name: "Accounts that count" });
    };
    const picker = await editAccounts();
    const source = picker.getByRole("checkbox", { name: new RegExp(`${sourceName}\\s*Hidden`) });
    await expect(source).toBeVisible();
    await expect(source).not.toBeChecked();
    await source.click();
    const recalculation = page.waitForResponse(
      (response) => response.url().endsWith(`/limits/${limitId}/deposits`) && response.ok(),
    );
    await page.getByRole("button", { name: "Update", exact: true }).click();
    expect(Number((await (await recalculation).json()).total)).toBe(0);
    await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");

    // Reload proves the hidden selection persists and remains editable.
    await page.reload();
    await editAccounts();
    await expect(source).toBeChecked();
    await source.click();
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    const saved = await page.request.get(`${api}/limits`);
    expect(saved.ok()).toBe(true);
    expect(
      (await saved.json()).find((limit: { id: string }) => limit.id === limitId).accountIds,
    ).toBe(destinationId);
  });
}
