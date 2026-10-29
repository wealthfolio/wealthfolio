import { expect, test } from "@playwright/test";
import { BASE_URL } from "./helpers";

for (const direction of ["ltr", "rtl"]) {
  test(`an imported untyped credit can be edited and deleted in Spending (${direction})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    if (direction === "rtl") await page.setViewportSize({ width: 390, height: 844 });

    const state = await (
      await page.request.post(`${BASE_URL}/api/v1/profiles/get_profile_state`, { data: {} })
    ).json();
    const unlocked = await page.request.post(`${BASE_URL}/api/v1/profiles/unlock_profile`, {
      data: { profileId: state.profiles[0].id },
    });
    expect(unlocked.ok()).toBeTruthy();
    const session = await unlocked.json();
    const api = async (path: string, data: unknown, method = "POST") => {
      const response = await page.request.fetch(`${BASE_URL}/api/v1/${path}`, {
        method,
        headers: { "x-wf-profile-scope": session.scopeId },
        data,
      });
      expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
      return response.json();
    };
    await api(
      "settings",
      {
        onboardingCompleted: true,
        language: "en",
        theme: "light",
        syncEnabled: false,
        autoUpdateCheckEnabled: false,
      },
      "PUT",
    );
    const account = await api("accounts", {
      name: `Untyped credit ${direction}`,
      accountType: "CASH",
      currency: "USD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    });
    await api("spending/settings", { enabled: true, accountIds: [account.id] }, "PUT");

    const note = `Imported credit without subtype ${direction}`;
    await page.goto(`${BASE_URL}/import?dir=${direction}`);
    await page.getByRole("combobox", { name: /Select an account/i }).click();
    await page.getByPlaceholder("Search accounts...").fill(account.name);
    await page.getByRole("option", { name: new RegExp(account.name) }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: `untyped-credit-${direction}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(
        `date,activityType,amount,currency,comment\n${new Date().toISOString().slice(0, 10)},CREDIT,100,USD,${note}\n`,
      ),
    });
    await expect(page.getByText("CSV Preview")).toBeVisible();
    for (const name of [
      /Configure Mapping/i,
      /Review Transactions/i,
      /Continue to Import/i,
      /Import \d+ Activit/i,
    ]) {
      const button = page.getByRole("button", { name });
      await expect(button).toBeEnabled({ timeout: 30_000 });
      await button.click();
    }
    await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 30_000 });

    const search = () =>
      api("spending/cash-activities/search", {
        accountIds: [account.id],
        includeCashBalances: true,
        limit: 50,
      });
    const imported = await search();
    expect(imported.totalCount).toBe(1);
    expect(imported.items[0]).toMatchObject({
      activityType: "CREDIT",
      subtype: null,
      cashFlowBucket: "neutral",
      netAmount: 100,
      visibleSpendingAmount: 0,
    });
    expect(Number(imported.items[0].cashBalance)).toBe(100);

    await page.goto(`${BASE_URL}/activities?tab=spending&dir=${direction}`);
    await expect(page.getByText(note, { exact: true })).toBeVisible();
    if (direction === "rtl") {
      await page.getByRole("button", { name: "Row actions", exact: true }).click();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
    } else {
      await page.getByText(note, { exact: true }).click();
    }
    const form = page.getByRole("dialog", { name: "Edit Transaction", exact: true });
    await expect(form.getByRole("combobox", { name: "Type" })).toHaveText("Credit");
    await expect(form.getByText("Neutral", { exact: true })).toBeVisible();
    await expect(form.getByText("Neutral transfer", { exact: true })).toHaveCount(0);
    await form.getByRole("button", { name: /^Update(?: Transaction)?$/ }).click();
    await expect(form).not.toBeVisible();
    const saved = await search();
    expect(saved.items[0]).toMatchObject({ subtype: null, cashFlowBucket: "neutral" });

    await page.getByRole("button", { name: "Row actions", exact: true }).click();
    await page
      .getByRole(direction === "rtl" ? "button" : "menuitem", { name: "Delete", exact: true })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect(page.getByText(note, { exact: true })).toHaveCount(0);
    expect((await search()).totalCount).toBe(0);
  });
}
