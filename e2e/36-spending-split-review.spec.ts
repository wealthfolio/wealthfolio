import { expect, test, type Page } from "@playwright/test";
import { BASE_URL } from "./helpers";

async function spendingSession(page: Page) {
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
  const settings = await api(
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
  expect(settings).toMatchObject({ baseCurrency: "USD", timezone: "UTC" });
  return api;
}

for (const direction of ["ltr", "rtl"]) {
  for (const editor of ["spending", "activity"]) {
    test(`financial edit reviews split removal before saving (${editor}, ${direction})`, async ({
      page,
    }) => {
      if (direction === "rtl") await page.setViewportSize({ width: 390, height: 844 });
      const api = await spendingSession(page);
      const account = await api("accounts", {
        name: `Split review ${editor} ${direction}`,
        accountType: "CASH",
        currency: "USD",
        isDefault: false,
        isActive: true,
        trackingMode: "TRANSACTIONS",
      });
      await api("spending/settings", { enabled: true, accountIds: [account.id] }, "PUT");
      const category = await api("taxonomies/categories", {
        taxonomyId: "spending_categories",
        name: `Review category ${editor} ${direction}`,
        key: `review_e2e_${editor}_${direction}`,
        color: "#123456",
        sortOrder: 0,
      });
      const note = `Split review transaction ${editor} ${direction}`;
      const activity = await api("activities", {
        accountId: account.id,
        activityType: "WITHDRAWAL",
        activityDate: new Date().toISOString(),
        currency: "USD",
        amount: "25",
        notes: note,
        needsReview: editor === "activity",
      });
      const splitPath = `spending/activities/${activity.id}/splits`;
      await api(
        splitPath,
        [
          { taxonomyId: "spending_categories", categoryId: category.id, amount: "10" },
          { taxonomyId: "spending_categories", categoryId: category.id, amount: "15" },
        ],
        "PUT",
      );
      const tab =
        editor === "activity" ? `investments&needsReview=true&activity=${activity.id}` : "spending";
      await page.goto(`${BASE_URL}/activities?tab=${tab}&dir=${direction}`);
      if (editor === "activity") {
        await page.getByRole("button", { name: "Open", exact: true }).click();
        await page
          .getByRole(direction === "rtl" ? "button" : "menuitem", { name: "Edit", exact: true })
          .click();
      } else if (direction === "rtl") {
        await page.getByRole("button", { name: "Row actions", exact: true }).click();
        await page.getByRole("button", { name: "Edit", exact: true }).click();
      } else {
        await page.getByText(note, { exact: true }).click();
      }
      const form = page.getByRole("dialog", {
        name: editor === "activity" ? "Update Activity" : "Edit Transaction",
        exact: true,
      });
      await expect(form).toBeVisible();
      await form.getByLabel("Amount", { exact: true }).fill("30");
      await form.getByRole("button", { name: /^Update(?: Transaction| Activity)?$/ }).click();
      const review = page.getByRole("alertdialog");
      await expect(review).toContainText("This edit will remove 2 split allocations.");
      await review.getByRole("button", { name: "Cancel", exact: true }).click();
      expect((await api(splitPath, undefined, "GET")).length).toBe(2);
      await expect(form.getByRole("alert")).toHaveCount(0);
      await expect(
        page.getByText(/ActivityEditCancelled|Failed to save activity|Save failed/, {
          exact: false,
        }),
      ).toHaveCount(0);
      await form.getByRole("button", { name: /^Update(?: Transaction| Activity)?$/ }).click();
      await expect(review).toBeVisible();
      await review.getByRole("button", { name: "Save and remove splits", exact: true }).click();
      await expect(form).not.toBeVisible();
      expect(await api(splitPath, undefined, "GET")).toEqual([]);
    });
  }
}

for (const direction of ["ltr", "rtl"]) {
  test(`old-taxonomy splits remain visible and can be cleared (${direction})`, async ({ page }) => {
    if (direction === "rtl") await page.setViewportSize({ width: 390, height: 844 });
    const api = await spendingSession(page);
    const account = await api("accounts", {
      name: `Previous splits ${direction}`,
      accountType: "CASH",
      currency: "USD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    });
    await api("spending/settings", { enabled: true, accountIds: [account.id] }, "PUT");
    const category = await api("taxonomies/categories", {
      taxonomyId: "income_sources",
      name: `Old income ${direction}`,
      key: `old_income_${direction}`,
      color: "#123456",
      sortOrder: 0,
    });
    const activity = await api("activities", {
      accountId: account.id,
      activityType: "INTEREST",
      activityDate: new Date().toISOString(),
      currency: "USD",
      amount: "25",
      notes: `Old allocations ${direction}`,
    });
    const path = `spending/activities/${activity.id}/splits`;
    await api(
      path,
      [{ taxonomyId: "income_sources", categoryId: category.id, amount: "25" }],
      "PUT",
    );
    await api(
      `accounts/${account.id}`,
      {
        name: account.name,
        accountType: "CREDIT_CARD",
        isDefault: false,
        isActive: true,
        trackingMode: "TRANSACTIONS",
      },
      "PUT",
    );
    await page.goto(`${BASE_URL}/activities?tab=spending&dir=${direction}`);
    await page.getByRole("button", { name: "Split · 1 line", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Split Transaction", exact: true });
    await expect(sheet).toContainText("These splits use a previous category type.");
    await expect(sheet).toContainText(`Old income ${direction}`);
    await expect(
      sheet.getByRole("button", { name: "Replace splits with one category" }),
    ).toBeVisible();
    await sheet.getByRole("button", { name: "Clear split", exact: true }).click();
    await expect(sheet).not.toBeVisible();
    expect(await api(path, undefined, "GET")).toEqual([]);
    await expect(page.getByRole("button", { name: "Assign category", exact: true })).toBeVisible();
  });
}

for (const direction of ["ltr", "rtl"]) {
  test(`reimbursement reviews income splits before reclassification (${direction})`, async ({
    page,
  }) => {
    if (direction === "rtl") await page.setViewportSize({ width: 390, height: 844 });
    const api = await spendingSession(page);
    const account = await api("accounts", {
      name: `Reimbursement review ${direction}`,
      accountType: "CASH",
      currency: "USD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    });
    await api("spending/settings", { enabled: true, accountIds: [account.id] }, "PUT");
    const category = await api("taxonomies/categories", {
      taxonomyId: "income_sources",
      name: `Reimbursement income ${direction}`,
      key: `reimbursement_income_${direction}`,
      color: "#123456",
      sortOrder: 0,
    });
    const activity = await api("activities", {
      accountId: account.id,
      activityType: "DEPOSIT",
      activityDate: new Date().toISOString(),
      currency: "USD",
      amount: "25",
      notes: `Reimbursement transaction ${direction}`,
    });
    const splitPath = `spending/activities/${activity.id}/splits`;
    await api(
      splitPath,
      [
        { taxonomyId: "income_sources", categoryId: category.id, amount: "10" },
        { taxonomyId: "income_sources", categoryId: category.id, amount: "15" },
      ],
      "PUT",
    );
    const originalSplits = await api(splitPath, undefined, "GET");
    await page.goto(`${BASE_URL}/activities?tab=spending&dir=${direction}`);
    const markReimbursement = async () => {
      await page.getByRole("button", { name: "Row actions", exact: true }).click();
      await page
        .getByRole(direction === "rtl" ? "button" : "menuitem", {
          name: "Mark as reimbursement",
          exact: true,
        })
        .click();
    };
    await markReimbursement();
    const review = page.getByRole("alertdialog");
    await expect(review).toContainText("This edit will remove 2 split allocations.");
    expect(await api(splitPath, undefined, "GET")).toEqual(originalSplits);
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(review).not.toBeVisible();
    expect(await api(splitPath, undefined, "GET")).toEqual(originalSplits);
    await expect(
      page.getByRole("dialog", { name: "Edit Transaction", exact: true }),
    ).not.toBeVisible();
    await expect(page.getByText("Failed to mark reimbursement.", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Marked as reimbursement.", { exact: true })).toHaveCount(0);
    await markReimbursement();
    await expect(review).toBeVisible();
    await review.getByRole("button", { name: "Save and remove splits", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Edit Transaction", exact: true })).toBeVisible();
    expect(await api(splitPath, undefined, "GET")).toEqual([]);
  });
}
