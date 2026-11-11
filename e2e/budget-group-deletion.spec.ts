import { expect, test } from "@playwright/test";
import { restoreSpendingSettings, updateSettings, useSpendingAccounts } from "./api";
import { BASE_URL } from "./helpers";

// Puts back the app-wide settings a test changed, so the next spec on this worker
// starts from defaults.
let restore: (() => Promise<unknown>) | undefined;
test.afterEach(async () => {
  await restore?.();
  restore = undefined;
});

interface GroupRow {
  group: { id: string };
  buffer: number;
}

for (const direction of ["ltr", "rtl"]) {
  test(`removing rollover then deleting a default group preserves monthly budgets (${direction})`, async ({
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
    const api = async (path: string, data?: unknown, method = "GET") => {
      const response = await page.request.fetch(`${BASE_URL}/api/v1/${path}`, {
        method,
        headers: { "x-wf-profile-scope": session.scopeId },
        data,
      });
      expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
      return response.json();
    };
    const previousSettings = await updateSettings(page, {
      baseCurrency: "USD",
      timezone: "UTC",
      onboardingCompleted: true,
      language: "en",
      theme: "light",
      syncEnabled: false,
      autoUpdateCheckEnabled: false,
    });
    restore = () => updateSettings(page, previousSettings);
    const account = await api(
      "accounts",
      {
        name: `Budget ${direction}`,
        accountType: "CASH",
        currency: "USD",
        isDefault: false,
        isActive: true,
        trackingMode: "TRANSACTIONS",
      },
      "POST",
    );
    const previousSpending = await useSpendingAccounts(page, [account.id]);
    restore = async () => {
      await restoreSpendingSettings(page, previousSpending);
      await updateSettings(page, previousSettings);
    };
    await api("spending/budget/groups/reset", {}, "POST");
    const source = "8cbd26c8-e3b2-4176-8c61-e5c11e10b808";
    const destination = "a409e0d6-9152-49c8-a5b4-a147a8ac636e";
    const previous = await api("spending/budget");
    for (const target of previous.state.targets) {
      if (target.groupId === source || target.groupId === destination) {
        await api(`spending/budget/targets/${target.id}`, undefined, "DELETE");
      }
    }
    for (const [groupId, periodKey, amount] of [
      [source, "default", "100"],
      [source, "2026-03", "50"],
      [destination, "default", "200"],
    ]) {
      await api(
        "spending/budget/targets",
        { groupId, periodKey, targetType: "group_buffer", amount },
        "POST",
      );
    }

    const enabled = direction === "ltr";
    await api(
      "spending/budget/rollovers",
      {
        targetType: "group",
        groupId: source,
        enabled,
        startMonth: "2026-03",
        startingBalance: "25",
      },
      "POST",
    );
    const beforeRemoval = await api("spending/budget?periodKey=2026-03");
    expect(
      beforeRemoval.computed.groupRows.find(
        (row: { group: { id: string } }) => row.group.id === source,
      ).rolloverIn,
    ).toBe(enabled ? 25 : 0);

    await page.goto(`${BASE_URL}/settings/spending/setup?dir=${direction}`);
    const sourceSection = page
      .locator("section")
      .filter({ has: page.getByText("Giving", { exact: true }) })
      .filter({ has: page.getByRole("button", { name: "Group actions" }) });
    await sourceSection.getByRole("button", { name: "Group actions" }).click();
    await page.getByRole("menuitem", { name: "Delete group", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
    await expect(
      dialog.getByText("Remove this group's rollover setting before deleting it."),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

    const openRemoval = async () => {
      await sourceSection.getByRole("button", { name: "Group actions" }).click();
      await page.getByRole("menuitem", { name: "Remove rollover setting", exact: true }).click();
      await expect(
        dialog.getByRole("heading", { name: "Remove rollover setting for Giving?" }),
      ).toBeVisible();
      await expect(dialog).toContainText("saved starting balance");
      await expect(dialog).toContainText("all months");
      const bounds = await dialog.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    };
    await openRemoval();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await api("spending/budget")).state.rolloverSettings).toEqual(
      beforeRemoval.state.rolloverSettings,
    );
    await openRemoval();
    await dialog.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    const afterRemoval = await api("spending/budget?periodKey=2026-03");
    expect(
      afterRemoval.state.rolloverSettings.some(
        (setting: { groupId: string }) => setting.groupId === source,
      ),
    ).toBe(false);
    expect(afterRemoval.state.groups).toEqual(beforeRemoval.state.groups);
    expect(afterRemoval.state.groupAssignments).toEqual(beforeRemoval.state.groupAssignments);
    expect(afterRemoval.state.targets).toEqual(beforeRemoval.state.targets);
    expect(
      afterRemoval.computed.groupRows.find(
        (row: { group: { id: string } }) => row.group.id === source,
      ).rolloverIn,
    ).toBe(0);
    // Other specs' budget targets count in the totals, so compare against these and
    // check this test's two groups by their own rows.
    const marchBefore = afterRemoval;
    const aprilBefore = await api("spending/budget?periodKey=2026-04");
    const ownBuffer = (snapshot: { computed: { groupRows: GroupRow[] } }) =>
      snapshot.computed.groupRows
        .filter((row) => row.group.id === source || row.group.id === destination)
        .reduce((sum, row) => sum + row.buffer, 0);
    expect(ownBuffer(marchBefore)).toBe(250);
    expect(ownBuffer(aprilBefore)).toBe(300);
    await page.reload();
    await sourceSection.getByRole("button", { name: "Group actions" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Remove rollover setting", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Delete group", exact: true }).click();
    await expect(
      dialog.getByText("Remove this group's rollover setting before deleting it."),
    ).toHaveCount(0);
    await dialog.getByRole("combobox", { name: "Move to group" }).click();
    await page.getByRole("option", { name: "Wants", exact: true }).click();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(sourceSection).toHaveCount(0);
    const march = await api("spending/budget?periodKey=2026-03");
    const april = await api("spending/budget?periodKey=2026-04");
    expect(ownBuffer(march)).toBe(250);
    expect(ownBuffer(april)).toBe(300);
    expect(march.computed.totals.groupBuffer).toBe(marchBefore.computed.totals.groupBuffer);
    expect(march.computed.totals.spendingRemaining).toBe(
      marchBefore.computed.totals.spendingRemaining,
    );
    expect(april.computed.totals.groupBuffer).toBe(aprilBefore.computed.totals.groupBuffer);
    await page.reload();
    await expect(page.getByRole("button", { name: "Reset to defaults" })).toBeVisible();
    await expect(sourceSection).toHaveCount(0);

    const other = page.locator("section").filter({ has: page.getByText("Other", { exact: true }) });
    await other.getByRole("button", { name: "Group actions" }).click();
    await expect(page.getByRole("menuitem", { name: "Delete group", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Reset to defaults" }).click();
    await expect(sourceSection).toBeVisible();
  });
}
