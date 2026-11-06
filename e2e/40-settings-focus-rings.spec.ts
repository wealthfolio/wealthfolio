import { expect, test, type Locator, type Page } from "@playwright/test";
import { BASE_URL } from "./helpers";

// Below 1024px globals.css clips every .flex and .grid (overflow-x: hidden, which also makes
// them clip vertically). A settings list row or the feature banner must still show a focused
// switch's whole focus ring and its enlarged touch area.

async function openSettings(page: Page, path: string, direction: string) {
  const state = await (
    await page.request.post(`${BASE_URL}/api/v1/profiles/get_profile_state`, { data: {} })
  ).json();
  const session = await (
    await page.request.post(`${BASE_URL}/api/v1/profiles/unlock_profile`, {
      data: { profileId: state.profiles[0].id },
    })
  ).json();
  const settings = await page.request.put(`${BASE_URL}/api/v1/settings`, {
    headers: { "x-wf-profile-scope": session.scopeId },
    data: {
      baseCurrency: "USD",
      timezone: "UTC",
      onboardingCompleted: true,
      language: "en",
      theme: "light",
      syncEnabled: false,
    },
  });
  expect(settings.ok()).toBeTruthy();
  expect(await settings.json()).toMatchObject({ baseCurrency: "USD", timezone: "UTC" });
  await page.goto(`${BASE_URL}${path}?dir=${direction}`);
}

// Tabs to the switch, waits for its outline colour to settle, and names the first ancestor that
// clips the ring (outline offset + width) or the touch area (the switch's ::after inset).
async function clippingAncestor(page: Page, target: Locator) {
  await expect(target).toBeVisible({ timeout: 30_000 });
  for (let tabs = 0; tabs < 80; tabs++) {
    if (await target.evaluate((element) => document.activeElement === element)) break;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
  await page.waitForTimeout(400);
  return target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const after = getComputedStyle(element, "::after");
    const ring = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
    const touchX = Math.max(ring, -parseFloat(after.left) || 0);
    const touchY = Math.max(ring, -parseFloat(after.top) || 0);
    const box = {
      left: rect.left - touchX,
      right: rect.right + touchX,
      top: rect.top - touchY,
      bottom: rect.bottom + touchY,
    };
    for (
      let node = element.parentElement;
      node && node !== document.body;
      node = node.parentElement
    ) {
      const nodeStyle = getComputedStyle(node);
      if (nodeStyle.overflowX === "visible" && nodeStyle.overflowY === "visible") continue;
      const edge = node.getBoundingClientRect();
      if (
        box.left < edge.left - 0.5 ||
        box.right > edge.right + 0.5 ||
        box.top < edge.top - 0.5 ||
        box.bottom > edge.bottom + 0.5
      ) {
        return `${node.tagName.toLowerCase()}.${String(node.className).split(" ").slice(0, 4).join(".")}`;
      }
    }
    return null;
  });
}

for (const direction of ["ltr", "rtl"]) {
  test.describe(`settings focus rings on a phone (${direction})`, () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("a list row's switch is not clipped", async ({ page }) => {
      await openSettings(page, "/settings/market-data", direction);
      const list = page.getByRole("list", { name: "Built-in providers", exact: true });
      const firstSwitch = list.getByRole("switch").first();
      expect(await clippingAncestor(page, firstSwitch)).toBeNull();
    });

    test("the feature banner's switch is not clipped", async ({ page }) => {
      await openSettings(page, "/settings/spending", direction);
      const banner = page.getByRole("region", { name: "Tracker status", exact: true });
      expect(await clippingAncestor(page, banner.getByRole("switch"))).toBeNull();
    });
  });
}
