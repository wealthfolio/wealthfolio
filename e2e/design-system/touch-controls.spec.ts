import { expect, test, type Locator } from "@playwright/test";

test.use({ hasTouch: true });

async function inside(child: Locator, parent: Locator) {
  const c = (await child.boundingBox())!;
  const p = (await parent.boundingBox())!;
  expect(c.x).toBeGreaterThanOrEqual(p.x - 1);
  expect(c.x + c.width).toBeLessThanOrEqual(p.x + p.width + 1);
  expect(c.y).toBeGreaterThanOrEqual(p.y - 1);
  expect(c.y + c.height).toBeLessThanOrEqual(p.y + p.height + 1);
}

for (const width of [320, 1024]) {
  for (const direction of ["ltr", "rtl"]) {
    for (const theme of ["classic", "ember"]) {
      test(`touch controls fit dense phone/tablet layouts (${width}, ${direction}, ${theme})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 1100 });
        await page.goto(`/e2e/design-system/?touchControls&dir=${direction}&theme=${theme}`);
        await expect(page.getByRole("heading", { name: "Touch controls" })).toBeVisible();
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
        const password = page.getByLabel("Password", { exact: true });
        const visibility = page.getByRole("button", { name: "Show password", exact: true });
        await inside(visibility, password);
        await visibility.click();
        await expect(password).toHaveAttribute("type", "text");
        const searchFrame = page.getByTestId("search-frame");
        const search = page.getByRole("search");
        await inside(search, searchFrame);
        const field = search.getByRole("textbox");
        expect((await field.boundingBox())!.width).toBeGreaterThan(40);
        await field.fill("Example");
        await expect(field).toHaveValue("Example");
        const calendar = page.getByTestId("calendar-frame");
        const cells = calendar.locator("button[data-day]");
        await expect(cells.first()).toBeVisible();
        await inside(cells.first(), calendar);
        await inside(cells.last(), calendar);
        const action = page.getByRole("button", { name: "Example action", exact: true });
        expect((await action.boundingBox())!.width).toBeGreaterThanOrEqual(44);
        const tab = page.getByRole("tab", { name: "Market data", exact: true });
        expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await expect(
          page.getByRole("tabpanel").filter({ hasText: "Market settings" }),
        ).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      });
    }
  }
}

test.describe("compact layouts with a reported mouse pointer", () => {
  test.use({ hasTouch: false });
  for (const width of [320, 915]) {
    test(`retains usable targets and bounded controls at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 1100 });
      await page.goto("/e2e/design-system/?touchControls&theme=ember");
      await expect(page.getByRole("heading", { name: "Touch controls" })).toBeVisible();
      expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(false);
      expect(
        (await page.getByLabel("Username", { exact: true }).boundingBox())!.height,
      ).toBeGreaterThanOrEqual(44);
      const action = page.getByRole("button", { name: "Example action", exact: true });
      const target = (await action.boundingBox())!;
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
      expect(
        (await page.getByRole("tab", { name: "General", exact: true }).boundingBox())!.height,
      ).toBeGreaterThanOrEqual(44);
      await inside(
        page.getByRole("button", { name: "Show password", exact: true }),
        page.getByLabel("Password", { exact: true }),
      );
      await inside(page.getByRole("search"), page.getByTestId("search-frame"));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
  }
});
