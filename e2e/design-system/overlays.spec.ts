import { expect, test, type Page } from "@playwright/test";
import { containsFocus, navigate, nextFrames, openGallery, overlays } from "./gallery";

// Behaviour every overlay must keep when its primitive changes: how it opens from the
// keyboard, where focus goes and comes back to, and what closes it.

const overlay = (name: string) => overlays.find((item) => item.name === name)!;

async function scrolledGallery(page: Page) {
  // A short viewport so the page scrolls behind modal overlays.
  await openGallery(page, { height: 600 });
  await page.evaluate(() => window.scrollTo(0, 200));
}

const modals = [
  { name: "dialog", trigger: "Open dialog", closesOnOutsideClick: true },
  { name: "alert-dialog", trigger: "Delete account", closesOnOutsideClick: false },
  { name: "sheet", trigger: "Open sheet", closesOnOutsideClick: true },
  { name: "bottom-sheet", trigger: "Open bottom sheet", closesOnOutsideClick: true },
];

for (const modal of modals) {
  test.describe(modal.name, () => {
    test("opens from the keyboard, traps focus, locks scroll and returns focus", async ({
      page,
    }) => {
      await scrolledGallery(page);
      const trigger = page.getByRole("button", { name: modal.trigger, exact: true });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const content = overlay(modal.name).content(page);
      await expect(content).toBeVisible();
      await expect.poll(() => containsFocus(content)).toBe(true);

      // Base UI wraps focus through guard elements on the next frame, so each step
      // waits for focus to settle back inside.
      for (let step = 0; step < 6; step++) {
        await page.keyboard.press("Tab");
        await expect.poll(() => containsFocus(content)).toBe(true);
      }

      const scrollBefore = await page.evaluate(() => window.scrollY);
      await page.mouse.move(5, 5);
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);

      await page.keyboard.press("Escape");
      await expect(content).toBeHidden();
      await expect(trigger).toBeFocused();
    });

    test(
      modal.closesOnOutsideClick ? "closes on an outside click" : "stays open on an outside click",
      async ({ page }) => {
        await openGallery(page);
        await page.getByRole("button", { name: modal.trigger, exact: true }).click();
        const content = overlay(modal.name).content(page);
        await expect(content).toBeVisible();
        // Radix listens for outside clicks from the tick after it opens.
        await nextFrames(page);
        await page.mouse.click(3, 3);
        if (modal.closesOnOutsideClick) await expect(content).toBeHidden();
        else await expect(content).toBeVisible();
      },
    );
  });
}

test("alert dialog actions: Cancel keeps, Delete confirms", async ({ page }) => {
  await openGallery(page);
  const trigger = page.getByRole("button", { name: "Delete account", exact: true });
  const content = overlay("alert-dialog").content(page);
  await trigger.click();
  await content.getByRole("button", { name: "Cancel" }).click();
  await expect(content).toBeHidden();
  await expect(page.getByRole("status")).toHaveText("");
  await trigger.click();
  await content.getByRole("button", { name: "Delete" }).click();
  await expect(content).toBeHidden();
  await expect(page.getByRole("status")).toHaveText("Deleted");
});

test("popover moves focus in, closes on Escape and on an outside click", async ({ page }) => {
  await openGallery(page);
  const trigger = page.getByRole("button", { name: "Open popover", exact: true });
  const content = overlay("popover").content(page);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(content).toBeVisible();
  await expect.poll(() => containsFocus(content)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(content).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(content).toBeVisible();
  await nextFrames(page);
  await page.mouse.click(3, 3);
  await expect(content).toBeHidden();
});

test("menu: arrow keys, submenu, checkbox item and focus return", async ({ page }) => {
  await openGallery(page);
  const trigger = page.getByRole("button", { name: "Open menu", exact: true });
  await trigger.focus();
  // ArrowDown opens the menu with its first item focused.
  await navigate(page, "ArrowDown");
  const menu = page.getByRole("menu").first();
  await expect(menu).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Rename" })).toBeFocused();
  await navigate(page, "ArrowDown");
  await expect(page.getByRole("menuitem", { name: "Duplicate" })).toBeFocused();
  await navigate(page, "ArrowDown");
  const moveTo = page.getByRole("menuitem", { name: "Move to" });
  await expect(moveTo).toBeFocused();
  await navigate(page, "ArrowRight");
  await expect(page.getByRole("menuitem", { name: "Investments" })).toBeFocused();
  await navigate(page, "ArrowLeft");
  await expect(moveTo).toBeFocused();
  await expect(page.getByRole("menuitem", { name: "Investments" })).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  // A checkbox item changes the same state as the switch in the form.
  const showFees = page.getByRole("switch", { name: "Show fees" });
  await expect(showFees).toBeChecked();
  await trigger.click();
  await page.getByRole("menuitemcheckbox", { name: "Show fees" }).click();
  await expect(menu).toBeHidden();
  await expect(showFees).not.toBeChecked();
});

test("select: keyboard choice, disabled option not chosen, Escape keeps the value", async ({
  page,
}) => {
  await openGallery(page);
  const trigger = page.getByRole("combobox", { name: "Account type", exact: true });
  await expect(trigger).toHaveText("Brokerage");
  await trigger.focus();
  await page.keyboard.press("Enter");
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  // The open list starts on the current value.
  await expect(page.getByRole("option", { name: "Brokerage" })).toBeFocused();
  await navigate(page, "ArrowDown");
  await page.keyboard.press("Enter");
  await expect(listbox).toBeHidden();
  await expect(trigger).toHaveText("Retirement");
  await expect(trigger).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(listbox).toBeVisible();
  await expect(page.getByRole("option", { name: "Retirement" })).toBeFocused();
  // Base UI keeps a disabled option reachable, as the ARIA practices recommend,
  // but Enter on it chooses nothing.
  for (let step = 0; step < 4; step++) await navigate(page, "ArrowDown");
  await expect(page.getByRole("option", { name: "Savings" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(listbox).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(listbox).toBeHidden();
  await expect(trigger).toHaveText("Retirement");
});

test("tooltip shows on focus and hides on Escape", async ({ page }) => {
  await openGallery(page);
  await overlay("tooltip").open(page);
  const tooltip = overlay("tooltip").content(page);
  await expect(tooltip).toHaveText("Fees are deducted from cash.");
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
});

test("tooltip opened by focus survives the scroll that focus causes", async ({ page }) => {
  // Radix closed a tooltip on any scroll, so focusing a trigger below the fold
  // opened its tooltip and the browser's scroll-into-view closed it again.
  await openGallery(page, { height: 600 });
  await page.getByRole("button", { name: "Fee info", exact: true }).focus();
  await page.waitForTimeout(500);
  expect(await overlay("tooltip").content(page).count()).toBe(1);
});

test("combobox inside a dialog: Escape closes the inner layer first", async ({ page }) => {
  await openGallery(page);
  const openDialog = page.getByRole("button", { name: "Open dialog", exact: true });
  await openDialog.click();
  const dialog = overlay("dialog").content(page);
  const currency = dialog.getByRole("combobox", { name: "Currency" });
  await currency.click();
  await page.getByPlaceholder("Search currency").fill("EU");
  await page.keyboard.press("Enter");
  await expect(currency).toHaveText("EUR");
  await expect(dialog).toBeVisible();

  await currency.click();
  await expect(page.getByPlaceholder("Search currency")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByPlaceholder("Search currency")).toBeHidden();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(openDialog).toBeFocused();
});

test("select inside a sheet: choosing keeps the sheet open", async ({ page }) => {
  await openGallery(page);
  await page.getByRole("button", { name: "Open sheet", exact: true }).click();
  const sheet = overlay("sheet").content(page);
  const select = sheet.getByRole("combobox", { name: "Sheet account" });
  await select.click();
  await page.getByRole("option", { name: "Checking" }).click();
  await expect(select).toHaveText("Checking");
  await expect(sheet).toBeVisible();
  // Base UI opens the list a moment after the click, so Escape waits for it;
  // pressed sooner, it reaches the sheet instead.
  await expect(page.getByRole("listbox")).toBeHidden();
  await select.click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toBeHidden();
  await expect(sheet).toBeVisible();
});
