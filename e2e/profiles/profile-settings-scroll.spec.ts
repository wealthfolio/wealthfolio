import { expect, test } from "@playwright/test";
import ar from "../../apps/frontend/src/i18n/locales/ar/common.json" with { type: "json" };
import en from "../../apps/frontend/src/i18n/locales/en/common.json" with { type: "json" };

for (const direction of ["ltr", "rtl"]) {
  test(`profile settings scrolls, keeps its drag strip, and centers fitting content in ${direction}`, async ({
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
        baseCurrency: "USD",
        timezone: "UTC",
        onboardingCompleted: true,
        syncEnabled: false,
        autoUpdateCheckEnabled: false,
        language: direction === "rtl" ? "ar" : "en",
      },
    });
    expect(saved.ok()).toBeTruthy();
    expect(await saved.json()).toMatchObject({ baseCurrency: "USD", timezone: "UTC" });

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
    const dragStrip = page.locator(".profile-settings-screen [data-tauri-drag-region]");
    await expect.poll(async () => (await dragStrip.boundingBox())!.y).toBe(0);
    const before = (await gallery.boundingBox())!;
    await page.mouse.move(before.x + before.width / 2, Math.min(before.y + 20, 500));
    await page.mouse.wheel(0, 450);
    await expect.poll(async () => (await gallery.boundingBox())!.y).toBeLessThan(before.y - 100);
    expect((await dragStrip.boundingBox())!.y).toBe(0);
    expect(
      await page.evaluate(() =>
        document.elementFromPoint(50, 16)?.hasAttribute("data-tauri-drag-region"),
      ),
    ).toBe(true);

    const after = (await gallery.boundingBox())!;
    await page.mouse.wheel(0, -450);
    await expect.poll(async () => (await gallery.boundingBox())!.y).toBeGreaterThan(after.y + 100);

    const content = page.locator(".profile-settings-content");
    // A little room around the current form: adding avatar rows must not
    // invalidate the test's assumption that the form fits in this viewport.
    const fittedHeight = Math.ceil((await content.boundingBox())!.height + 100);
    await page.setViewportSize({ width: 1280, height: fittedHeight });
    await expect
      .poll(() =>
        page
          .locator(".profile-settings-screen")
          .evaluate((element) => element.scrollHeight <= element.clientHeight),
      )
      .toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollHeight <= document.documentElement.clientHeight,
      ),
    ).toBe(true);
    const centered = (await content.boundingBox())!;
    expect(Math.abs(centered.y + centered.height / 2 - fittedHeight / 2)).toBeLessThan(1);
  });
}
