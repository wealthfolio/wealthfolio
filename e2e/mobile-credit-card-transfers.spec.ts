import { expect, test } from "@playwright/test";
import { BASE_URL, gotoAppPath } from "./helpers";

for (const direction of ["ltr", "rtl"]) {
  test(`mobile cash transfers include credit cards, securities exclude them (${direction})`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    page.setDefaultTimeout(15_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const stateResponse = await page.request.post(`${BASE_URL}/api/v1/profiles/get_profile_state`, {
      data: {},
    });
    expect(stateResponse.ok(), await stateResponse.text()).toBeTruthy();
    const state = await stateResponse.json();
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
        baseCurrency: "USD",
        timezone: "UTC",
        onboardingCompleted: true,
        language: "en",
        autoUpdateCheckEnabled: false,
      },
      "PUT",
    );
    const checking = await api("accounts", {
      name: `Transfer checking ${direction}`,
      accountType: "CASH",
      currency: "USD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    });
    const card = await api("accounts", {
      name: `Transfer card ${direction}`,
      accountType: "CREDIT_CARD",
      currency: "USD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    });

    await gotoAppPath(page, `/activities?tab=investments&dir=${direction}`);
    await expect(page.locator("html")).toHaveAttribute("dir", direction);
    await page.getByTitle("Add", { exact: true }).click();
    await page.locator('label[for$="-TRANSFER_OUT"]').click();
    await page.getByRole("button", { name: "Next", exact: true }).click();

    // Both selectors must update when changing mode, even before selecting accounts.
    for (const mode of ["Securities", "Cash"]) {
      await page.getByRole("button", { name: mode, exact: true }).click();
      for (const label of ["From Account", "To Account"]) {
        await page.getByRole("combobox", { name: label, exact: true }).click();
        const picker = page.getByRole("dialog", { name: label, exact: true });
        await expect(picker).toBeVisible();
        const cardOption = picker.getByRole("option", { name: new RegExp(card.name) });
        if (mode === "Cash") await expect(cardOption).toBeVisible();
        else await expect(cardOption).toHaveCount(0);
        await picker.getByRole("button", { name: "Back", exact: true }).click();
      }
    }

    for (const [label, account] of [
      ["From Account", checking],
      ["To Account", card],
    ]) {
      await page.getByRole("combobox", { name: label, exact: true }).click();
      await page.getByRole("option", { name: new RegExp(account.name) }).click();
    }
    await page.getByLabel("Amount", { exact: true }).fill("100");
    const save = async (name: string) => {
      const pending = page.waitForResponse(
        (response) =>
          response.url().endsWith("/activities/transfer-pair") &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name, exact: true }).click();
      const response = await pending;
      expect(response.ok(), await response.text()).toBeTruthy();
      const pair = await response.json();
      expect(pair.transferOut.accountId).toBe(checking.id);
      expect(pair.transferIn.accountId).toBe(card.id);
      return pair;
    };
    const created = await save("Add Activity");
    await gotoAppPath(
      page,
      `/activities?tab=investments&activity=${encodeURIComponent(created.transferIn.id)}&dir=${direction}`,
    );
    await page.getByRole("button", { name: "Open", exact: true }).first().click();
    await page.getByText("Edit", { exact: true }).click();
    await expect(page.getByRole("combobox", { name: "To Account", exact: true })).toContainText(
      card.name,
    );
    await page.getByLabel("Amount", { exact: true }).fill("125");
    const updated = await save("Update Activity");
    expect(updated.transferIn.id).toBe(created.transferIn.id);
    expect(Number(updated.transferIn.amount)).toBe(125);
  });
}
