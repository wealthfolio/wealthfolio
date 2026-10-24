import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";
import type { TaxonomyCategory, TaxonomyWithCategories } from "../apps/frontend/src/lib/types";

test("classification translations preserve stored names and user renames, including RTL", async ({
  page,
}) => {
  test.setTimeout(120000);
  await completeOnboardingIfNeeded(page);
  const api = `${BASE_URL}/api/v1`;
  const response = await page.request.get(`${api}/taxonomies/asset_classes`);
  expect(response.ok()).toBe(true);
  const taxonomy: TaxonomyWithCategories = await response.json();
  const original = taxonomy.categories.find((category) => category.id === "EQUITY")!;
  const setLanguage = async (language: string) => {
    const saved = await page.request.put(`${api}/settings`, { data: { language } });
    expect(saved.ok()).toBe(true);
  };
  try {
    await setLanguage("zh");
    for (const query of ["", "?dir=rtl"]) {
      await page.goto(`${BASE_URL}/settings/taxonomies${query}`);
      await page.getByRole("tab", { name: "资产类别", exact: true }).click();
      await expect(page.getByRole("tree").getByText("股票", { exact: true }).first()).toBeVisible();
      if (query) await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    }
    const renamed: TaxonomyCategory = { ...original, name: "My equity allocation" };
    const saved = await page.request.put(`${api}/taxonomies/categories`, { data: renamed });
    expect(saved.ok()).toBe(true);
    await page.reload();
    await page.getByRole("tab", { name: "资产类别", exact: true }).click();
    await page.getByText(renamed.name, { exact: true }).click();
    await expect(page.getByRole("textbox", { name: "名称", exact: true })).toHaveValue(
      renamed.name,
    );
    await page.getByRole("textbox", { name: "描述", exact: true }).fill("Updated without renaming");
    await page.getByRole("button", { name: "保存更改", exact: true }).click();
    await expect
      .poll(async () => {
        const latest: TaxonomyWithCategories = await (
          await page.request.get(`${api}/taxonomies/asset_classes`)
        ).json();
        return latest.categories.find((category) => category.id === original.id);
      })
      .toMatchObject({
        id: original.id,
        key: original.key,
        name: renamed.name,
        description: "Updated without renaming",
      });
    await setLanguage("en");
    await page.reload();
    await page.getByRole("tab", { name: "Asset Classes", exact: true }).click();
    await expect(page.getByText(renamed.name, { exact: true }).first()).toBeVisible();
  } finally {
    const restored = await page.request.put(`${api}/taxonomies/categories`, { data: original });
    expect(restored.ok()).toBe(true);
    await setLanguage("en");
  }
});

test("market-data metadata translates while provider brands stay unchanged", async ({ page }) => {
  test.setTimeout(120000);
  await completeOnboardingIfNeeded(page);
  const api = `${BASE_URL}/api/v1`;
  try {
    const saved = await page.request.put(`${api}/settings`, { data: { language: "zh" } });
    expect(saved.ok()).toBe(true);
    await page.goto(`${BASE_URL}/settings/market-data?dir=rtl`);
    await expect(page.getByText("Yahoo Finance", { exact: true })).toBeVisible();
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
