import { expect, test } from "@playwright/test";
import { BASE_URL } from "./helpers";

for (const direction of ["ltr", "rtl"]) {
  test(`imported withdrawal explains incompatible Savings rules (${direction})`, async ({
    page,
  }) => {
    const state = await (
      await page.request.post(`${BASE_URL}/api/v1/profiles/get_profile_state`, { data: {} })
    ).json();
    const unlocked = await page.request.post(`${BASE_URL}/api/v1/profiles/unlock_profile`, {
      data: { profileId: state.profiles[0].id },
    });
    expect(unlocked.ok()).toBeTruthy();
    const session = await unlocked.json();
    const headers = { "x-wf-profile-scope": session.scopeId };
    const api = async (path: string, data: unknown, method = "POST") => {
      const response = await page.request.fetch(`${BASE_URL}/api/v1/${path}`, {
        method,
        headers,
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
      name: `Savings rule ${direction}`,
      accountType: "CASH",
      currency: "USD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    });
    await api("spending/settings", { enabled: true, accountIds: [account.id] }, "PUT");
    const note = `BROKER CONTRIBUTION ${direction}`;
    await api("spending/rules", {
      name: `Investment contribution ${direction}`,
      pattern: note,
      taxonomyId: "savings_categories",
      categoryId: "cat_savings_investments",
      priority: 10,
      isGlobal: false,
      accountId: account.id,
    });

    await page.goto(`${BASE_URL}/import?dir=${direction}`);
    await page.getByRole("combobox", { name: /Select an account/i }).click();
    await page.getByPlaceholder("Search accounts...").fill(account.name);
    await page.getByRole("option", { name: new RegExp(account.name) }).click();
    await page.locator('input[type="file"]').setInputFiles({
      name: `savings-withdrawal-${direction}.csv`,
      mimeType: "text/csv",
      buffer: Buffer.from(
        `date,activityType,amount,currency,comment\n${new Date().toISOString().slice(0, 10)},WITHDRAWAL,100,USD,${note}\n`,
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

    await page.goto(`${BASE_URL}/settings/spending/rules?dir=${direction}`);
    await page.getByRole("button", { name: "Re-run rules", exact: true }).click();
    const rerun = page.waitForResponse((response) =>
      response.url().endsWith("/spending/rules/rerun/detailed"),
    );
    await page.getByRole("menuitem", { name: /^Categorize uncategorized/ }).click();
    expect(await (await rerun).json()).toMatchObject({ matched: 1, changed: 0, incompatible: 1 });
    await expect(page.getByText("Categorized 0 activities.", { exact: true })).toBeVisible();
    await expect(page.getByText(/Incompatible categories: 1/)).toBeVisible();

    await page.getByRole("button", { name: "Add rule", exact: true }).click();
    await expect(
      page.getByRole("dialog").getByText(/Categories follow the transaction's cash flow/),
    ).toBeVisible();

    // The incompatible high-priority rule must also leave a compatible rule usable
    // by the background rerun triggered when the new rule is saved.
    const category = await api("taxonomies/categories", {
      taxonomyId: "spending_categories",
      name: `Compatible expense ${direction}`,
      key: `compatible_expense_${direction}`,
      sortOrder: 0,
    });
    await api("spending/rules", {
      name: `Compatible rule ${direction}`,
      pattern: note,
      taxonomyId: "spending_categories",
      categoryId: category.id,
      priority: 1,
      isGlobal: false,
      accountId: account.id,
    });
    await expect
      .poll(async () => {
        const result = await api("spending/cash-activities/search", {
          accountIds: [account.id],
          limit: 10,
        });
        expect(result.totalCount).toBe(1);
        expect(result.items[0].cashFlowBucket).toBe("spending");
        return result.items[0].assignments.map(
          (assignment: { categoryId: string }) => assignment.categoryId,
        );
      })
      .toEqual([category.id]);
  });
}
