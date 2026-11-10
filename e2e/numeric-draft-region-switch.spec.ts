import { expect, test } from "@playwright/test";
import { BASE_URL, gotoAppPath } from "./helpers";

for (const dir of ["ltr", "rtl"] as const) {
  test(`goal funding retains draft precision when the region changes in ${dir}`, async ({
    page,
  }) => {
    test.setTimeout(90000);
    const api = `${BASE_URL}/api/v1`;
    const state = await (
      await page.request.post(`${api}/profiles/get_profile_state`, { data: {} })
    ).json();
    const session =
      state.session ??
      (await (
        await page.request.post(`${api}/profiles/unlock_profile`, {
          data: { profileId: state.profiles[0].id },
        })
      ).json());
    const headers = { "x-wf-profile-scope": session.scopeId };
    const previous = await (await page.request.get(`${api}/settings`, { headers })).json();
    let accountId: string | undefined;
    let goalId: string | undefined;
    try {
      const settings = await page.request.put(`${api}/settings`, {
        headers,
        data: {
          baseCurrency: "USD",
          language: "en",
          formattingRegion: "ES",
          onboardingCompleted: true,
          autoUpdateCheckEnabled: false,
        },
      });
      expect(settings.ok()).toBe(true);
      const accountResponse = await page.request.post(`${api}/accounts`, {
        headers,
        data: {
          name: `Draft precision ${dir}`,
          accountType: "CASH",
          currency: "USD",
          isDefault: false,
          isActive: true,
          isArchived: false,
          trackingMode: "TRANSACTIONS",
        },
      });
      expect(accountResponse.ok()).toBe(true);
      const account = await accountResponse.json();
      accountId = account.id;
      const goalResponse = await page.request.post(`${api}/goals`, {
        headers,
        data: { goalType: "home", title: `Draft precision ${dir}`, targetAmount: 10000 },
      });
      expect(goalResponse.ok()).toBe(true);
      const goal = await goalResponse.json();
      goalId = goal.id;
      const funding = await page.request.put(`${api}/goals/${goal.id}/funding`, {
        headers,
        data: [{ accountId: account.id, sharePercent: 20 }],
      });
      expect(funding.ok()).toBe(true);
      await gotoAppPath(page, `/goals/${goal.id}?dir=${dir}`);
      await expect(page.locator("html")).toHaveAttribute("dir", dir);
      await page.getByRole("button", { name: "Edit Account Shares", exact: true }).click();
      const input = page.getByRole("textbox", { name: account.name, exact: true });
      await input.fill("12.34");
      await expect(input).toBeFocused();

      // Changing pages would blur and commit the draft first. Refresh real saved
      // settings through the existing host API so this remains an active draft.
      const changed = await page.request.put(`${api}/settings`, {
        headers,
        data: { formattingRegion: "US" },
      });
      expect(changed.ok()).toBe(true);
      const refreshed = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname.endsWith("/settings"),
      );
      await page.evaluate(async () => {
        // Vite serves the app's own host bridge; no API responses or parsers are mocked.
        const modulePath = "/src/addons/addons-runtime-context.ts";
        const { createAddonHostAPI } = await import(/* @vite-ignore */ modulePath);
        createAddonHostAPI("numeric-draft-browser-regression").query.refetchQueries("settings");
      });
      const response = await refreshed;
      expect(response.ok()).toBe(true);
      expect(await response.json()).toMatchObject({ formattingRegion: "US" });
      // Wait for React to apply the settings response, even though the exact draft
      // text correctly stays identical for this invariant-decimal fallback case.
      // The label previews the typed 12.34% share.
      await expect(page.getByText(/87\.7%\u2069? left/)).toBeVisible();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("12.34");
      await input.press("End");
      await input.pressSequentially("5");
      await expect(input).toHaveValue("12.345");
      await input.press("Tab");
      const saving = page.waitForResponse(
        (saved) =>
          saved.request().method() === "PUT" &&
          new URL(saved.url()).pathname.endsWith(`/goals/${goal.id}/funding`),
      );
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const saved = await saving;
      expect(saved.ok()).toBe(true);
      expect(saved.request().postDataJSON()).toEqual([
        expect.objectContaining({ accountId: account.id, sharePercent: 12.345 }),
      ]);
      const persisted = await page.request.get(`${api}/goals/${goal.id}/funding`, { headers });
      expect(persisted.ok()).toBe(true);
      expect(await persisted.json()).toEqual([
        expect.objectContaining({ accountId: account.id, sharePercent: 12.345 }),
      ]);
      await page.screenshot({ path: test.info().outputPath(`saved-share-${dir}.png`) });
    } finally {
      if (goalId) await page.request.delete(`${api}/goals/${goalId}`, { headers });
      if (accountId) await page.request.delete(`${api}/accounts/${accountId}`, { headers });
      await page.request.put(`${api}/settings`, { headers, data: previous });
    }
  });
}
