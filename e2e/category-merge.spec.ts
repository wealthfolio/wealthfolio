import { expect, test } from "@playwright/test";
import { BASE_URL } from "./helpers";

for (const direction of ["ltr", "rtl"]) {
  test(`reviewed category merge preserves historical splits and budgets (${direction})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    if (direction === "rtl") await page.setViewportSize({ width: 390, height: 844 });
    const state = await (
      await page.request.post(`${BASE_URL}/api/v1/profiles/get_profile_state`, { data: {} })
    ).json();
    const unlock = await page.request.post(`${BASE_URL}/api/v1/profiles/unlock_profile`, {
      data: { profileId: state.profiles[0].id },
    });
    expect(unlock.ok()).toBeTruthy();
    const session = await unlock.json();
    const api = async (path: string, data?: unknown, method = "GET") => {
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
        baseCurrency: "USD",
        timezone: "UTC",
        onboardingCompleted: true,
        language: "en",
        theme: "light",
        syncEnabled: false,
        autoUpdateCheckEnabled: false,
      },
      "PUT",
    );
    const account = await api(
      "accounts",
      {
        name: `Merge ${direction}`,
        accountType: "CASH",
        currency: "USD",
        isDefault: false,
        isActive: true,
        trackingMode: "TRANSACTIONS",
      },
      "POST",
    );
    await api("spending/settings", { enabled: true, accountIds: [account.id] }, "PUT");
    const createCategory = (name: string, parentId?: string, taxonomyId = "spending_categories") =>
      api(
        "taxonomies/categories",
        { taxonomyId, name, key: `${name}_${direction}`, color: "#123456", sortOrder: 0, parentId },
        "POST",
      );
    const source = await createCategory(`Merge source ${direction}`);
    const destination = await createCategory(`Merge destination ${direction}`);
    const child = await createCategory(`Child destination ${direction}`, destination.id);
    const excluded = await createCategory(`Excluded destination ${direction}`);
    const income = await createCategory(
      `Income destination ${direction}`,
      undefined,
      "income_sources",
    );
    await api("spending/settings", { excludedCategoryIds: [excluded.id] }, "PUT");
    for (const [categoryId, periodKey, amount] of [
      [source.id, "default", "100"],
      [source.id, "2026-03", "50"],
      [destination.id, "default", "200"],
    ]) {
      await api(
        "spending/budget/targets",
        {
          taxonomyId: "spending_categories",
          categoryId,
          periodKey,
          targetType: "category",
          amount,
        },
        "POST",
      );
    }
    const activity = await api(
      "activities",
      {
        accountId: account.id,
        activityType: "WITHDRAWAL",
        activityDate: "2026-03-12T12:00:00Z",
        currency: "USD",
        amount: "25",
        notes: `Historical merge ${direction}`,
      },
      "POST",
    );
    const splitPath = `spending/activities/${activity.id}/splits`;
    await api(
      splitPath,
      [
        {
          taxonomyId: "spending_categories",
          categoryId: source.id,
          amount: "10",
          note: "Source note",
          sortOrder: 3,
        },
        {
          taxonomyId: "spending_categories",
          categoryId: destination.id,
          amount: "15",
          note: "Destination note",
          sortOrder: 7,
        },
      ],
      "PUT",
    );
    const originalSplits = await api(splitPath);
    // A saved category rollover blocks merging even when disabled. Resolve it
    // through the same setup UI that a peer uses after a sync conflict.
    await api(
      "spending/budget/rollovers",
      {
        targetType: "category",
        taxonomyId: "spending_categories",
        categoryId: source.id,
        enabled: direction === "ltr",
        startMonth: "2026-03",
        startingBalance: "23",
      },
      "POST",
    );
    await page.goto(`${BASE_URL}/settings/spending/setup?dir=${direction}`);
    await expect(page.getByRole("button", { name: "Expand group" }).first()).toBeVisible();
    while (await page.getByRole("button", { name: "Expand group" }).count()) {
      await page.getByRole("button", { name: "Expand group" }).first().click();
    }
    const budgetRow = page.getByText(source.name, { exact: true }).locator("..").locator("..");
    await budgetRow.getByRole("button", { name: "Row options" }).click();
    await page.getByRole("menuitem", { name: "Remove rollover setting", exact: true }).click();
    const removal = page.getByRole("alertdialog");
    await expect(removal).toContainText(`Remove rollover setting for ${source.name}?`);
    await removal.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(removal).not.toBeVisible();
    expect(
      (await api("spending/budget")).state.rolloverSettings.some(
        (setting: { categoryId: string }) => setting.categoryId === source.id,
      ),
    ).toBe(false);
    const before = await api("spending/budget?periodKey=2026-03");
    expect(before.computed.totals.spendingActual).toBe(25);
    await page.goto(`${BASE_URL}/settings/spending/categories?dir=${direction}`);
    const expensePanel = page.getByRole("tabpanel", { name: /^Expense/ });
    const openDelete = async () => {
      const row = expensePanel.getByText(source.name, { exact: true }).locator("..").locator("..");
      if (direction === "rtl") {
        await row.getByRole("button", { name: "Category actions" }).click();
        await page.getByRole("button", { name: "Delete", exact: true }).click();
      } else {
        await row.getByRole("button", { name: "Delete category" }).click();
      }
      await expect(
        page.getByRole("alertdialog").getByRole("combobox", { name: "Move into…" }),
      ).toBeVisible();
    };
    const dialog = page.getByRole("alertdialog");
    await openDelete();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await api(splitPath)).toEqual(originalSplits);
    expect((await api("spending/budget?periodKey=2026-03")).state.targets).toEqual(
      before.state.targets,
    );
    await openDelete();
    await expect(dialog).toContainText("Past reports");
    await dialog.getByRole("combobox", { name: "Move into…" }).click();
    for (const name of [source.name, child.name, excluded.name, income.name]) {
      await expect(page.getByRole("option", { name, exact: true })).toHaveCount(0);
    }
    await page.getByRole("option", { name: destination.name, exact: true }).click();
    await expect(dialog.getByText(/250/)).toBeVisible();
    const budgetTable = dialog.getByRole("table", { name: `Budgets · ${destination.name}` });
    await expect(budgetTable.getByRole("row", { name: /Monthly default/ })).toContainText("+100");
    await expect(budgetTable.getByRole("row", { name: /Mar.*2026/ })).toContainText("+50");
    await expect(dialog.getByText(/Exclude from spending/)).toHaveCount(0);
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    // A real intervening write invalidates the review without partial merging.
    await api(
      "spending/budget/targets",
      {
        taxonomyId: "spending_categories",
        categoryId: source.id,
        periodKey: "2026-03",
        targetType: "category",
        amount: "60",
      },
      "POST",
    );
    const staleResponse = page.waitForResponse((response) =>
      response.url().endsWith("/spending/categories/merge"),
    );
    await dialog.getByRole("button", { name: "Move and delete" }).click();
    expect((await staleResponse).status()).toBe(400);
    await expect(dialog.getByRole("alert")).toContainText("data changed");
    expect(await api(splitPath)).toEqual(originalSplits);
    await expect(dialog.getByRole("button", { name: "Move and delete" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Refresh preview" }).click();
    await expect(dialog.getByText(/260/)).toBeVisible();
    await dialog.getByRole("button", { name: "Move and delete" }).click();
    await expect(dialog).not.toBeVisible();
    await expect(expensePanel.getByText(source.name, { exact: true })).toHaveCount(0);
    expect(
      (await api("taxonomies/spending_categories")).categories.some(
        (c: { id: string }) => c.id === source.id,
      ),
    ).toBe(false);
    const after = await api("spending/budget?periodKey=2026-03");
    expect(after.computed.totals.spendingActual).toBe(before.computed.totals.spendingActual);
    expect(after.computed.totals.spendingPlanned).toBe(before.computed.totals.spendingPlanned + 10);
    expect(
      after.state.targets.filter((t: { categoryId: string }) => t.categoryId === source.id),
    ).toEqual([]);
    expect(
      after.state.targets.find(
        (t: { categoryId: string; periodKey: string }) =>
          t.categoryId === destination.id && t.periodKey === "2026-03",
      ).amount,
    ).toBe("260");
    const future = await api("spending/budget?periodKey=2030-01");
    expect(
      future.state.targets.find(
        (t: { categoryId: string; periodKey: string }) =>
          t.categoryId === destination.id && t.periodKey === "default",
      ).amount,
    ).toBe("300");
    expect(
      future.computed.groupRows
        .flatMap(
          (group: { categories: { categoryId: string; target: number }[] }) => group.categories,
        )
        .find((category: { categoryId: string }) => category.categoryId === destination.id).target,
    ).toBe(300);
    const mergedSplits = await api(splitPath);
    expect(mergedSplits).toEqual(
      originalSplits.map((split: { categoryId: string; updatedAt: string }) => ({
        ...split,
        categoryId: destination.id,
        updatedAt: expect.any(String),
      })),
    );
    await page.reload();
    await expect(expensePanel.getByText(destination.name, { exact: true })).toBeVisible();
    await expect(expensePanel.getByText(source.name, { exact: true })).toHaveCount(0);
  });
}
