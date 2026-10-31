import { expect, test } from "@playwright/test";
import ar from "../../apps/frontend/src/i18n/locales/ar/common.json" with { type: "json" };
import en from "../../apps/frontend/src/i18n/locales/en/common.json" with { type: "json" };

for (const direction of ["ltr", "rtl"]) {
  test(`profile settings scrolls with the mouse wheel in ${direction}`, async ({
    page,
    context,
  }) => {
    const copy = direction === "rtl" ? ar.profiles : en.profiles;
    const created = await context.request.post("/api/v1/profiles/create_profile", {
      data: { name: `Scroll ${direction}`, avatarId: "clay-bot-animated" },
    });
    expect(created.ok(), await created.text()).toBeTruthy();
    const profile = await created.json();
    const unlocked = await context.request.post("/api/v1/profiles/unlock_profile", {
      data: { profileId: profile.id },
    });
    expect(unlocked.ok()).toBeTruthy();
    const session = await unlocked.json();
    const saved = await context.request.put("/api/v1/settings", {
      headers: { "x-wf-profile-scope": session.scopeId },
      data: {
        onboardingCompleted: true,
        syncEnabled: false,
        autoUpdateCheckEnabled: false,
        language: direction === "rtl" ? "ar" : "en",
      },
    });
    expect(saved.ok()).toBeTruthy();

    await page.setViewportSize({ width: 1280, height: 600 });
    await page.goto(`/?dir=${direction}`);
    await expect(page.locator("html")).toHaveAttribute("dir", direction);
    await page
      .getByRole("button", { name: new RegExp(`^${copy.menuLabel.split("{{name}}")[0]}`) })
      .click();
    await page.getByRole("menuitem", { name: copy.settings, exact: true }).click();
    await expect(page.getByRole("heading", { name: copy.yourProfile, exact: true })).toBeVisible();
    const gallery = page.getByRole("group", {
      name: copy.avatarGroup.replace("{{style}}", copy.avatarAll),
      exact: true,
    });
    const before = (await gallery.boundingBox())!;
    await page.mouse.move(before.x + before.width / 2, Math.min(before.y + 20, 500));
    await page.mouse.wheel(0, 450);
    await expect.poll(async () => (await gallery.boundingBox())!.y).toBeLessThan(before.y - 100);

    const after = (await gallery.boundingBox())!;
    await page.mouse.wheel(0, -450);
    await expect.poll(async () => (await gallery.boundingBox())!.y).toBeGreaterThan(after.y + 100);

    await page.setViewportSize({ width: 1280, height: 960 });
    await expect
      .poll(() =>
        page
          .locator(".profile-settings-screen")
          .evaluate((element) => element.scrollHeight <= element.clientHeight),
      )
      .toBe(true);
  });
}
