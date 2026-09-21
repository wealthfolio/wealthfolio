import { expect, test, type BrowserContext, type Request } from "@playwright/test";

async function command(context: BrowserContext, name: string, data = {}, scope?: string) {
  const response = await context.request.post(`/api/v1/profiles/${name}`, {
    data,
    headers: scope ? { "x-wf-profile-scope": scope } : {},
  });
  expect(response.ok(), `${name}: ${response.status()}`).toBeTruthy();
  return response.json();
}

test("idle offline state refresh hides private content and Retry revokes the backend session", async ({
  page,
  context,
}, info) => {
  const profile = await command(context, "create_profile", {
    name: "Offline protected profile",
    avatarId: "clay-bot-animated",
  });
  let grant = await command(context, "unlock_profile", { profileId: profile.id });
  await command(
    context,
    "set_profile_password",
    { proof: null, password: "offline passphrase" },
    grant.scopeId,
  );
  grant = await command(context, "unlock_profile", {
    profileId: profile.id,
    proof: "offline passphrase",
  });
  const headers = { "x-wf-profile-scope": grant.scopeId };
  const settings = await context.request.put("/api/v1/settings", {
    headers,
    data: {
      onboardingCompleted: true,
      baseCurrency: "USD",
      timezone: "UTC",
      language: "en",
      syncEnabled: false,
    },
  });
  expect(settings.ok()).toBeTruthy();
  const account = await context.request.post("/api/v1/accounts", {
    headers,
    data: {
      name: "Synthetic private account",
      accountType: "SECURITIES",
      trackingMode: "TRANSACTIONS",
      currency: "USD",
      isActive: true,
      isDefault: false,
    },
  });
  expect(account.ok()).toBeTruthy();
  await page.goto("/settings/accounts");
  await expect(
    page.getByRole("link", { name: "Synthetic private account", exact: true }),
  ).toBeVisible();
  // The former poll would have made five reads in this window.
  await expect(page.locator("body")).toBeVisible();
  expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
  let stateReads = 0;
  const countStateReads = (request: Request) => {
    if (request.url().endsWith("/profiles/get_profile_state")) stateReads += 1;
  };
  page.on("request", countStateReads);
  await page.waitForTimeout(10_000);
  page.off("request", countStateReads);
  expect(stateReads).toBe(0);
  const failedRead = page.waitForEvent("requestfailed", {
    predicate: (request) => request.url().endsWith("/profiles/get_profile_state"),
  });
  try {
    // No clicks, keys, navigation, focus changes, or synthetic activity events:
    // the state re-check triggered by going offline must close the cached financial screen.
    await context.setOffline(true);
    await failedRead;
    await expect(page.locator(".app-shell")).not.toBeVisible({ timeout: 15000 });
    await expect(
      page.getByRole("link", { name: "Synthetic private account", exact: true }),
    ).not.toBeVisible();
    const retry = page.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    await page.screenshot({ path: info.outputPath("offline-covered.png"), fullPage: true });
    await context.setOffline(false);
    await retry.click();
    await expect(page.getByRole("heading", { name: "Who's using Wealthfolio?" })).toBeVisible();
    const state = await command(context, "get_profile_state");
    expect(state.session).toBeNull();
    const stale = await context.request.get("/api/v1/accounts", { headers });
    expect(stale.status()).toBe(423);
    await page.getByRole("button", { name: profile.name, exact: true }).click();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Synthetic private account", exact: true }),
    ).not.toBeVisible();
    await page.screenshot({
      path: info.outputPath("online-password-required.png"),
      fullPage: true,
    });
  } catch (error) {
    await page.screenshot({ path: info.outputPath("failure.png"), fullPage: true });
    throw error;
  } finally {
    await context.setOffline(false);
  }
});

test("a server-side lock without a tab broadcast covers the idle screen", async ({
  page,
  context,
}) => {
  const profile = await command(context, "create_profile", {
    name: "Stream lock profile",
    avatarId: "clay-bot-animated",
  });
  const grant = await command(context, "unlock_profile", { profileId: profile.id });
  const settings = await context.request.put("/api/v1/settings", {
    headers: { "x-wf-profile-scope": grant.scopeId },
    data: {
      onboardingCompleted: true,
      baseCurrency: "USD",
      timezone: "UTC",
      language: "en",
      syncEnabled: false,
    },
  });
  expect(settings.ok()).toBeTruthy();
  await page.goto("/settings/accounts");
  await expect(page.locator(".app-shell").first()).toBeVisible();

  // Same browser session, but outside the page, so no BroadcastChannel message.
  // Only the server ending the event stream can tell the page.
  await command(context, "lock_profile");
  await expect(page.locator(".app-shell")).toHaveCount(0, { timeout: 5000 });
  await expect(page.getByRole("heading", { name: "Who's using Wealthfolio?" })).toBeVisible();
});
