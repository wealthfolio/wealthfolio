import { expect, test } from "@playwright/test";
import { BASE_URL } from "./helpers";

for (const direction of ["ltr", "rtl"]) {
  test(`financial edit reviews split removal before saving (${direction})`, async ({ page }) => {
    if (direction === "rtl") await page.setViewportSize({ width: 390, height: 844 });
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
      name: `Split review ${direction}`,
      accountType: "CASH",
      currency: "USD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    });
    await api("spending/settings", { enabled: true, accountIds: [account.id] }, "PUT");
    const category = await api("taxonomies/categories", {
      taxonomyId: "spending_categories",
      name: `Review category ${direction}`,
      key: `review_e2e_${direction}`,
      color: "#123456",
      sortOrder: 0,
    });
    const note = `Split review transaction ${direction}`;
    const activity = await api("activities", {
      accountId: account.id,
      activityType: "WITHDRAWAL",
      activityDate: new Date().toISOString(),
      currency: "USD",
      amount: "25",
      notes: note,
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
    await page.goto(`${BASE_URL}/activities?tab=spending&dir=${direction}`);
    if (direction === "rtl") {
      await page.getByRole("button", { name: "Row actions", exact: true }).click();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
    } else {
      await page.getByText(note, { exact: true }).click();
    }
    const form = page.getByRole("dialog", { name: "Edit Transaction", exact: true });
    await expect(form).toBeVisible();
    await form.getByLabel("Amount", { exact: true }).fill("30");
    await form.getByRole("button", { name: /^Update(?: Transaction)?$/ }).click();
    const review = page.getByRole("alertdialog");
    await expect(review).toContainText("This edit will remove 2 split allocations.");
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await api(splitPath, undefined, "GET")).length).toBe(2);
    await form.getByRole("button", { name: /^Update(?: Transaction)?$/ }).click();
    await expect(review).toBeVisible();
    await review.getByRole("button", { name: "Save and remove splits", exact: true }).click();
    await expect(form).not.toBeVisible();
    expect(await api(splitPath, undefined, "GET")).toEqual([]);
  });
}
