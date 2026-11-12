import { expect, test, type Page } from "@playwright/test";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

// The desktop currency pickers wrap their options in a ScrollArea inside cmdk's list, which
// scrolls too. If the wrapper is taller than the list, the picker scrolls in two nested areas,
// and a wheel gesture can leave the last currencies below the list's edge (#2450).
async function expectOneScrollingList(page: Page) {
  const list = page.locator("[cmdk-list]").filter({ visible: true });
  const last = list.getByRole("option").last();
  await expect(list.getByRole("option").first()).toBeVisible();
  const scrollers = await list.evaluate((element) =>
    [element, ...element.querySelectorAll("*")]
      .filter(
        (node) =>
          node.scrollHeight > node.clientHeight + 1 &&
          /auto|scroll/.test(getComputedStyle(node).overflowY),
      )
      .map((node) => node.getAttribute("data-slot") ?? node.tagName),
  );
  expect(scrollers).toHaveLength(1);

  const box = await list.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 100_000);
  await expect(last).toBeInViewport({ ratio: 1 });
  await page.keyboard.press("Escape");
}

for (const direction of ["ltr", "rtl"] as const) {
  test(`desktop currency pickers scroll in one area (${direction})`, async ({ page }) => {
    test.setTimeout(120_000);
    await completeOnboardingIfNeeded(page);
    await gotoAppPath(page, `/settings/general?dir=${direction}`);

    await page.getByRole("combobox", { name: "Base currency", exact: true }).click();
    await expectOneScrollingList(page);

    await page.getByRole("button", { name: "Add rate", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add exchange rate" });
    for (const name of ["From currency", "To currency"]) {
      await dialog.getByRole("combobox", { name, exact: true }).click();
      await expectOneScrollingList(page);
    }
  });
}
