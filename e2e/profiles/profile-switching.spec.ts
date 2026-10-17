import { test, expect, type BrowserContext, type Page } from "@playwright/test";

async function command(context: BrowserContext, name: string, data = {}, scope?: string) {
  const result = await context.request.post(`/api/v1/profiles/${name}`, {
    data,
    headers: scope ? { "x-wf-profile-scope": scope } : {},
  });
  expect(result.ok(), `Profile command ${name}: ${result.status()}`).toBeTruthy();
  return result.json();
}
async function settings(context: BrowserContext, scope: string, theme: string, font: string) {
  const result = await context.request.put("/api/v1/settings", {
    headers: { "x-wf-profile-scope": scope },
    data: {
      onboardingCompleted: true,
      theme,
      font,
      language: "en",
      syncEnabled: false,
      autoUpdateCheckEnabled: false,
    },
  });
  expect(result.ok()).toBeTruthy();
}
async function ready(page: Page, name: string) {
  await expect(page.locator(".app-shell").first()).toBeVisible();
  await expect(page.getByRole("button", { name: `Profile menu for ${name}` })).toBeVisible();
}
async function switchProfile(page: Page, current: string, next: string) {
  await page.getByRole("button", { name: `Profile menu for ${current}` }).click();
  await page.getByRole("menuitem", { name: "Switch profile", exact: true }).click();
  await expect(page.locator(".app-shell").first()).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Who's using Wealthfolio?" })).toBeVisible();
  await page.screenshot({
    path: `/tmp/wealthfolio-profile-chooser-${current === "Profile B" ? "dark" : "light"}.png`,
  });
  await page.getByRole("button", { name: next, exact: true }).click();
  await ready(page, next);
}

test("real A → B → A reloads, different appearance, cross-tab route reset, and mobile lock", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const initial = await command(context, "get_profile_state");
  const a = initial.profiles[0];
  let grant = initial.session ?? (await command(context, "unlock_profile", { profileId: a.id }));
  await command(
    context,
    "update_profile",
    { name: "Profile A", avatarId: "clay-pebble-animated" },
    grant.scopeId,
  );
  await settings(context, grant.scopeId, "light", "font-sans");
  const b = await command(context, "create_profile", {
    name: "Profile B",
    avatarId: "clay-fluff-animated",
  });
  grant = await command(context, "unlock_profile", { profileId: b.id });
  await settings(context, grant.scopeId, "dark", "font-serif");
  await command(context, "unlock_profile", { profileId: a.id });
  await page.goto("/connect");
  await ready(page, "Profile A");
  const observer = await context.newPage();
  await observer.goto("/settings/accounts");
  await ready(observer, "Profile A");
  await switchProfile(page, "Profile A", "Profile B");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator("html")).toHaveClass(/dark/);
  await expect(page.locator("body")).toHaveClass(/font-serif/);
  await ready(observer, "Profile B");
  await expect(observer).toHaveURL(/\/$/);
  await observer.close();
  await switchProfile(page, "Profile B", "Profile A");
  await expect(page.locator("html")).toHaveClass(/light/);
  await expect(page.locator("body")).toHaveClass(/font-sans/);

  const active = await command(context, "get_profile_state");
  await command(
    context,
    "set_profile_password",
    { proof: null, password: "mobile passphrase" },
    active.session.scopeId,
  );
  await command(context, "unlock_profile", { profileId: a.id, proof: "mobile passphrase" });
  await page.reload();
  await ready(page, "Profile A");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("button", { name: "Profile menu for Profile A" }).click();
  await expect(page.getByRole("menu")).not.toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Profile A", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByRole("button", { name: "Profile B", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add profile", exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/wealthfolio-mobile-profile-menu.png" });
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("button", { name: "Profile menu for Profile A" })).toBeFocused();
  await page.getByRole("button", { name: "Profile menu for Profile A" }).click();
  await page.getByRole("button", { name: "Close more menu" }).click();
  await page.getByRole("button", { name: "More options" }).click();
  await expect(page.getByRole("heading", { name: "More", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Profile menu for Profile A" }).click();
  await page.getByRole("button", { name: "Lock Wealthfolio" }).click();
  await expect(page.locator(".app-shell").first()).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Who's using Wealthfolio?" })).toBeVisible();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.screenshot({ path: "/tmp/wealthfolio-profile-lock-mobile.png" });
  await page.getByRole("button", { name: "Profile A", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).fill("mobile passphrase");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.locator(".app-shell").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "More options" })).toBeVisible();
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("button", { name: "Profile menu for Profile A" }).click();
  await page.getByRole("button", { name: "Profile B", exact: true }).click();
  await expect(page.locator("body")).toHaveClass(/font-serif/);
  await page.getByRole("button", { name: "More options" }).click();
  await page.getByRole("button", { name: "Profile menu for Profile B" }).click();
  await page.getByRole("button", { name: "Profile A", exact: true }).click();
  await page.getByLabel("Password", { exact: true }).fill("mobile passphrase");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(page.locator("body")).toHaveClass(/font-sans/);
  expect(errors).toEqual([]);
  const unlocked = await command(context, "get_profile_state");
  await command(
    context,
    "set_profile_password",
    { proof: "mobile passphrase", password: null },
    unlocked.session.scopeId,
  );
});

test("incorrect password stays on the chooser and can be retried", async ({ page, context }) => {
  const state = await command(context, "get_profile_state");
  const profile =
    state.profiles.find((item: { id: string }) => item.id === state.session?.profileId) ??
    state.profiles[0];
  const grant =
    state.session ?? (await command(context, "unlock_profile", { profileId: profile.id }));
  await settings(context, grant.scopeId, "light", "font-sans");
  await command(
    context,
    "set_profile_password",
    { proof: null, password: "correct passphrase" },
    grant.scopeId,
  );
  await command(context, "lock_profile", { preserveAuth: false });
  await page.goto("/");
  await expect(page.getByLabel("Password", { exact: true })).not.toBeVisible();
  await page.getByRole("button", { name: profile.name, exact: true }).click();
  const password = page.getByLabel("Password", { exact: true });
  await password.fill("111111");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await expect(password).toHaveAttribute("aria-invalid", "true");
  await expect(password).toBeFocused();
  await expect(page.getByText(/PROFILE_PASSWORD_INVALID/)).not.toBeVisible();
  await page.screenshot({ path: "/tmp/wealthfolio-invalid-password.png" });
  await password.fill("correct passphrase");
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await ready(page, profile.name);
});

test("profile settings keeps the avatar gallery usable on desktop and mobile", async ({
  page,
  context,
}) => {
  const state = await command(context, "get_profile_state");
  const profile = state.profiles.find((item: { lockEnabled: boolean }) => !item.lockEnabled);
  const grant = await command(context, "unlock_profile", { profileId: profile.id });
  await settings(context, grant.scopeId, "light", "font-sans");
  await page.goto("/");
  await ready(page, profile.name);
  await page.getByRole("button", { name: `Profile menu for ${profile.name}` }).click();
  await page.getByRole("menuitem", { name: "Profile settings" }).click();
  const gallery = page.getByRole("group", { name: "All avatars" });
  await expect(gallery.getByRole("button")).toHaveCount(40);
  await expect
    .poll(() => gallery.evaluate((element) => element.scrollHeight <= element.clientHeight))
    .toBe(true);
  await page.getByRole("button", { name: "Enable password" }).click();
  const nameBounds = await page.getByLabel("Name", { exact: true }).boundingBox();
  const passwordBounds = await page.getByLabel("New password", { exact: true }).boundingBox();
  expect(passwordBounds?.x).toBe(nameBounds?.x);
  expect(passwordBounds?.width).toBe(nameBounds?.width);
  const confirmation = page.getByLabel("Re-enter password", { exact: true });
  const confirmationBounds = await confirmation.boundingBox();
  expect(confirmationBounds?.x).toBe(passwordBounds?.x);
  expect(confirmationBounds?.width).toBe(passwordBounds?.width);
  const save = page.getByRole("button", { name: "Save changes", exact: true });
  await expect(save).toHaveCount(1);
  const saveBounds = await save.boundingBox();
  const galleryBounds = await gallery.boundingBox();
  expect(saveBounds!.x).toBeGreaterThanOrEqual(galleryBounds!.x);
  expect(saveBounds!.x + saveBounds!.width).toBeLessThanOrEqual(
    galleryBounds!.x + galleryBounds!.width,
  );
  expect(saveBounds!.y).toBeGreaterThan(confirmationBounds!.y + confirmationBounds!.height);
  expect(saveBounds!.y).toBeGreaterThanOrEqual(galleryBounds!.y + galleryBounds!.height);
  await page.getByLabel("New password", { exact: true }).fill("a new passphrase 🔒");
  await confirmation.fill("does not match");
  await page.getByRole("button", { name: /^Save(?: changes)?$/, exact: true }).click();
  await expect(page.getByText("Passwords do not match.")).toBeVisible();
  await expect(confirmation).toBeFocused();
  await confirmation.fill("a new passphrase 🔒");
  await expect(page.getByText("Passwords do not match.")).not.toBeVisible();
  await page.screenshot({ path: "/tmp/wealthfolio-profile-settings-desktop.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("Name", { exact: true })).toBeVisible();
  await page
    .getByRole("button", { name: /^Save(?: changes)?$/, exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({ path: "/tmp/wealthfolio-profile-settings-mobile.png", fullPage: true });
  await settings(context, grant.scopeId, "dark", "font-sans");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload();
  await ready(page, profile.name);
  await page.getByRole("button", { name: `Profile menu for ${profile.name}` }).click();
  await page.getByRole("menuitem", { name: "Profile settings" }).click();
  await page.screenshot({ path: "/tmp/wealthfolio-profile-settings-dark.png", fullPage: true });
});

test("sets, changes, and recovers a password with confirmation", async ({ page, context }) => {
  const profile = await command(context, "create_profile", {
    name: "Password profile",
    avatarId: "clay-bot-animated",
  });
  const grant = await command(context, "unlock_profile", { profileId: profile.id });
  await settings(context, grant.scopeId, "light", "font-sans");
  await page.goto("/");
  await ready(page, profile.name);
  let previousPassword = "";
  let recoveryCode = "";
  for (const flow of ["setup", "change", "recovery"]) {
    await page.getByRole("button", { name: `Profile menu for ${profile.name}` }).click();
    if (flow === "recovery") {
      await page.getByRole("menuitem", { name: "Lock Wealthfolio" }).click();
      await page.getByRole("button", { name: profile.name, exact: true }).click();
      await page.getByRole("button", { name: "Forgot password?" }).click();
      await page.getByLabel("Recovery code", { exact: true }).fill(recoveryCode);
    } else {
      await page.getByRole("menuitem", { name: "Profile settings" }).click();
      if (flow === "setup") await page.getByRole("button", { name: "Enable password" }).click();
      else
        await page
          .getByLabel("Current password or recovery code", { exact: true })
          .fill(previousPassword);
    }
    const password = ` ${flow} passphrase é🔒 `;
    await page.getByLabel("New password", { exact: true }).fill(password);
    await page.getByLabel("Re-enter password", { exact: true }).fill("mismatched password");
    await page
      .getByRole("button", {
        name: flow === "recovery" ? "Reset password" : /^Save(?: changes)?$/,
        exact: true,
      })
      .click();
    await expect(page.getByText("Passwords do not match.")).toBeVisible();
    await page.getByLabel("Re-enter password", { exact: true }).fill(password);
    await page
      .getByRole("button", {
        name: flow === "recovery" ? "Reset password" : /^Save(?: changes)?$/,
        exact: true,
      })
      .click();
    await expect(page.getByRole("heading", { name: "Save your recovery code" })).toBeVisible();
    const nextRecoveryCode = (await page.locator("code").textContent())!;
    expect(nextRecoveryCode).not.toBe(recoveryCode);
    recoveryCode = nextRecoveryCode;
    await page.getByRole("button", { name: "I've saved my recovery code" }).click();
    await page.getByRole("button", { name: profile.name, exact: true }).click();
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await ready(page, profile.name);
    previousPassword = password;
  }
});
