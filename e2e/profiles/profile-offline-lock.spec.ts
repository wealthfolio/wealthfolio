import { expect, test, type BrowserContext, type Request } from "@playwright/test";

async function command(context: BrowserContext, name: string, data = {}, scope?: string) {
  const response = await context.request.post(`/api/v1/profiles/${name}`, {
    data,
    headers: scope ? { "x-wf-profile-scope": scope } : {},
  });
  expect(response.ok(), `${name}: ${response.status()}`).toBeTruthy();
  return response.json();
}

for (const protectedProfile of [false, true]) {
  test(`offline state verification preserves the same ${protectedProfile ? "protected" : "unprotected"} session on reconnect`, async ({
    page,
    context,
  }, info) => {
    const profile = await command(context, "create_profile", {
      name: "Offline protected profile",
      avatarId: "clay-bot-animated",
    });
    let grant = await command(context, "unlock_profile", { profileId: profile.id });
    if (protectedProfile) {
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
    }
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
    expect(stateReads).toBe(0);
    try {
      // No clicks, keys, navigation, focus changes, or synthetic activity events:
      // going offline must leave the already-open portfolio visible without a state request.
      await context.setOffline(true);
      await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
      await expect(page.locator(".app-shell").first()).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Synthetic private account", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0);
      await page.screenshot({ path: info.outputPath("offline-visible.png"), fullPage: true });
      expect(stateReads).toBe(0);
      await context.setOffline(false);
      await expect(
        page.getByRole("link", { name: "Synthetic private account", exact: true }),
      ).toBeVisible();
      const state = await command(context, "get_profile_state");
      expect(state.session.scopeId).toBe(grant.scopeId);
      const admitted = await context.request.get("/api/v1/accounts", { headers });
      expect(admitted.status()).toBe(200);
      await page.screenshot({ path: info.outputPath("online-resumed.png"), fullPage: true });
    } catch (error) {
      await page.screenshot({ path: info.outputPath("failure.png"), fullPage: true });
      throw error;
    } finally {
      page.off("request", countStateReads);
      await context.setOffline(false);
    }
  });
}

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
