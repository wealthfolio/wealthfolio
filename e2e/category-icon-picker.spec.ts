import { expect, test } from "./fixtures";
import { BASE_URL } from "./helpers";

for (const direction of ["ltr", "rtl"]) {
  test(`selects and saves a Lucide category icon (${direction})`, async ({ page }) => {
    const name = `Icon picker ${direction} ${Date.now()}`;
    await page.goto(`${BASE_URL}/settings/spending/categories?dir=${direction}`);
    await page.getByRole("button", { name: "Add category", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add category" });
    await dialog.getByLabel("Name").fill(name);
    await dialog.getByRole("button", { name: "Choose an icon" }).click();
    const search = page.getByPlaceholder("Search icons...");
    await expect(search).toBeVisible();
    const picker = search.locator("..");
    await expect(picker.locator("[data-icon-index]")).not.toHaveCount(0);
    const scrollport = picker.locator('[class*="scrollbar-gutter"]');
    const checkOverflow = async () => {
      expect(
        await scrollport.evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBeLessThanOrEqual(1);
      const bounds = await scrollport.boundingBox();
      const icons = picker.locator("[data-icon-index]");
      for (const icon of [icons.first(), icons.nth(7)]) {
        const box = await icon.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(bounds!.x - 1);
        expect(box!.x + box!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width + 1);
      }
    };
    await checkOverflow();
    expect(await picker.locator("[data-icon-index]").count()).toBeLessThan(120);
    await search.focus();
    await page.keyboard.press("Tab");
    const firstIcon = picker.locator('[data-icon-index="0"]');
    await expect(firstIcon).toBeFocused();
    await expect(firstIcon).toHaveCSS("outline-style", "solid");
    await expect(firstIcon).toHaveCSS("outline-width", "2px");
    await expect(firstIcon).toHaveCSS("outline-offset", "-2px");
    await page.emulateMedia({ forcedColors: "active" });
    await expect(firstIcon).toHaveCSS("outline-style", "solid");
    await expect(firstIcon).toHaveCSS("outline-width", "2px");
    await page.emulateMedia({ forcedColors: "none" });
    for (let row = 0; row < 12; row++) await page.keyboard.press("ArrowDown");
    await expect(picker.locator('[data-icon-index="96"]')).toBeFocused();
    await expect(picker.locator('[data-icon-index="96"]')).toHaveCSS("outline-offset", "-2px");
    await checkOverflow();
    expect(await picker.locator("[data-icon-index]").count()).toBeLessThan(120);
    await search.focus();
    const initialWidth = (await picker.boundingBox())!.width;
    await search.fill("no-such-icon-xyz");
    await expect(picker.getByText(/No icons match/)).toBeVisible();
    expect(Math.abs((await picker.boundingBox())!.width - initialWidth)).toBeLessThanOrEqual(1);
    await search.fill("shopping cart");
    await page.getByRole("button", { name: "shopping cart", exact: true }).click();
    await dialog.getByRole("button", { name: "Create category" }).click();
    await expect(dialog).not.toBeVisible();
    const row = page.getByText(name, { exact: true }).locator("..").locator("..");
    await expect(row.locator(".lucide-shopping-cart")).toBeVisible();
    await page.reload();
    await expect(
      page
        .getByText(name, { exact: true })
        .locator("..")
        .locator("..")
        .locator(".lucide-shopping-cart"),
    ).toBeVisible();
  });

  test(`fits the picker on a narrow viewport (${direction})`, async ({ page }) => {
    await page.setViewportSize({ width: 260, height: 800 });
    await page.goto(`${BASE_URL}/settings/spending/categories?dir=${direction}`);
    await page.addStyleTag({ content: "::-webkit-scrollbar { width: 18px; height: 18px; }" });
    await page.getByRole("button", { name: "Add category", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Add category" })
      .getByRole("button", { name: "Choose an icon" })
      .click();
    const picker = page.getByPlaceholder("Search icons...").locator("..");
    const scrollport = picker.locator('[class*="scrollbar-gutter"]');
    await expect(picker.locator("[data-icon-index]").first()).toBeVisible();
    await expect
      .poll(() => scrollport.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
    const bounds = await picker.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(260);
    const columns = await picker.locator("[data-icon-index]").evaluateAll((buttons) => {
      const firstTop = buttons[0].getBoundingClientRect().top;
      return buttons.filter((button) => button.getBoundingClientRect().top === firstTop).length;
    });
    expect(columns).toBeLessThan(8);
    const scrollBounds = (await scrollport.boundingBox())!;
    for (const icon of [
      picker.locator('[data-icon-index="0"]'),
      picker.locator(`[data-icon-index="${columns - 1}"]`),
    ]) {
      const box = (await icon.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(scrollBounds.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(scrollBounds.x + scrollBounds.width + 1);
    }
    await picker.locator('[data-icon-index="0"]').focus();
    await page.keyboard.press("ArrowDown");
    await expect(picker.locator(`[data-icon-index="${columns}"]`)).toBeFocused();
  });
}
