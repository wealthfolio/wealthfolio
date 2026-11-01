import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";

test("market-data metadata translates while provider brands stay unchanged", async ({ page }) => {
  test.setTimeout(120000);
  await completeOnboardingIfNeeded(page);
  const api = `${BASE_URL}/api/v1`;
  try {
    const saved = await page.request.put(`${api}/settings`, { data: { language: "zh" } });
    expect(saved.ok()).toBe(true);
    await page.goto(`${BASE_URL}/settings/market-data?dir=rtl`);
    await expect(page.getByText("Yahoo Finance", { exact: true })).toBeVisible();
    // The description and features sit in the provider's settings.
    await page.getByRole("button", { name: "Yahoo Finance 设置", exact: true }).click();
    await expect(
      page.getByText("Yahoo Finance 提供多个市场的历史及实时股票数据。", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("股息", { exact: true }).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  } finally {
    const restored = await page.request.put(`${api}/settings`, { data: { language: "en" } });
    expect(restored.ok()).toBe(true);
  }
});
