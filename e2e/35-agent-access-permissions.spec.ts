import { expect, test } from "@playwright/test";
import { BASE_URL } from "./helpers";

for (const direction of ["ltr", "rtl"]) {
  test(`edit token permissions without replacing the credential (${direction})`, async ({
    page,
  }) => {
    if (direction === "rtl") await page.setViewportSize({ width: 390, height: 844 });
    // Select the fresh test installation's profile before entering settings.
    const stateResponse = await page.request.post(`${BASE_URL}/api/v1/profiles/get_profile_state`, {
      data: {},
    });
    expect(stateResponse.ok()).toBeTruthy();
    const state = await stateResponse.json();
    const unlockedResponse = await page.request.post(`${BASE_URL}/api/v1/profiles/unlock_profile`, {
      data: { profileId: state.profiles[0].id },
    });
    expect(unlockedResponse.ok()).toBeTruthy();
    const session = await unlockedResponse.json();
    const settings = await page.request.put(`${BASE_URL}/api/v1/settings`, {
      headers: { "x-wf-profile-scope": session.scopeId },
      data: {
        baseCurrency: "USD",
        timezone: "UTC",
        onboardingCompleted: true,
        language: "en",
        theme: "light",
        syncEnabled: false,
        autoUpdateCheckEnabled: false,
      },
    });
    expect(settings.ok()).toBeTruthy();
    expect(await settings.json()).toMatchObject({ baseCurrency: "USD", timezone: "UTC" });
    await page.goto(`${BASE_URL}/settings/agent-access?dir=${direction}`);
    const name = `Permission test ${direction}`;
    await page.getByRole("button", { name: "Create token", exact: true }).click();
    const create = page.getByRole("dialog");
    await create.getByLabel("Name", { exact: true }).fill(name);
    const createdResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().endsWith("/agent-access/tokens"),
    );
    await create.getByRole("button", { name: "Create token", exact: true }).click();
    const createdMetadata = await (await createdResponse).json();
    await expect(create.getByRole("heading", { name: "Token created", exact: true })).toBeVisible();
    await create.getByRole("button", { name: "Done", exact: true }).click();
    const row = page
      .getByRole("list", { name: "Personal access tokens", exact: true })
      .getByRole("listitem")
      .filter({ has: page.getByText(name, { exact: true }) })
      .last();
    await row.getByRole("button", { name: "Edit permissions", exact: true }).click();
    const edit = page.getByRole("dialog");
    const scope = edit.getByRole("checkbox", { name: /^Organize spending/ });
    await expect(scope).toHaveAttribute("aria-checked", "false");
    await scope.focus();
    await page.keyboard.press("Space");
    await expect(scope).toHaveAttribute("aria-checked", "true");
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" && response.url().includes("/agent-access/tokens/"),
    );
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    const response = await saved;
    expect(response.ok()).toBeTruthy();
    const metadata = await response.json();
    expect(metadata.scopes).toContain("spending:write");
    expect(metadata.scopes).toContain("spending:read");
    expect(metadata.scopes).not.toContain("budget:write");
    for (const field of ["id", "name", "tokenPrefix", "createdAt", "expiresAt"]) {
      expect(metadata[field]).toEqual(createdMetadata[field]);
    }
    expect(metadata.token).toBeUndefined();
    expect(metadata.tokenHash).toBeUndefined();
    await expect(edit).not.toBeVisible();
    await row.getByRole("button", { name: "Edit permissions", exact: true }).click();
    await expect(
      page.getByRole("dialog").getByRole("checkbox", { name: /^Organize spending/ }),
    ).toHaveAttribute("aria-checked", "true");
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  });
}
