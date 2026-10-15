import { expect, type Locator, type Page } from "@playwright/test";

export const modes = ["light", "dark"] as const;
export const widths = [390, 1440] as const;

/** Opens the synthetic primitives gallery and returns the page errors it collects. */
export async function openGallery(
  page: Page,
  {
    mode = "light",
    width = 1440,
    height = 900,
  }: { mode?: string; width?: number; height?: number } = {},
) {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width, height });
  await page.goto(`/e2e/design-system/?mode=${mode}`);
  await expect(page.getByRole("heading", { name: "UI primitives" })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  return errors;
}

export interface Overlay {
  name: string;
  open: (page: Page) => Promise<void>;
  content: (page: Page) => Locator;
}

const click =
  (name: string, role: "button" | "combobox" = "button") =>
  (page: Page) =>
    page.getByRole(role, { name, exact: true }).click();

/** Every overlay in the gallery, how to open it, and the element it shows. */
export const overlays: Overlay[] = [
  {
    name: "dialog",
    open: click("Open dialog"),
    content: (page) => page.getByRole("dialog", { name: "Review activity" }),
  },
  {
    name: "alert-dialog",
    open: click("Delete account"),
    content: (page) => page.getByRole("alertdialog", { name: "Delete this account?" }),
  },
  {
    name: "sheet",
    open: click("Open sheet"),
    content: (page) => page.getByRole("dialog", { name: "Edit account" }),
  },
  {
    name: "bottom-sheet",
    open: click("Open bottom sheet"),
    content: (page) => page.getByRole("dialog", { name: "Quick add" }),
  },
  {
    name: "popover",
    open: click("Open popover"),
    content: (page) => page.getByRole("dialog").filter({ hasText: "Target allocation" }),
  },
  {
    name: "menu",
    open: click("Open menu"),
    content: (page) => page.getByRole("menu"),
  },
  {
    name: "select",
    open: click("Account type", "combobox"),
    content: (page) => page.getByRole("listbox"),
  },
  {
    name: "tooltip",
    // The trigger is scrolled into view before it is focused so the screenshot
    // matches the Radix baseline, which closed a tooltip on that scroll.
    open: async (page) => {
      const trigger = page.getByRole("button", { name: "Fee info", exact: true });
      await trigger.scrollIntoViewIfNeeded();
      await nextFrames(page);
      await trigger.focus();
    },
    // Base UI tooltips are visual labels without a `tooltip` role.
    content: (page) => page.locator('[data-slot="tooltip-content"]'),
  },
  {
    name: "hover-card",
    open: (page) => page.getByRole("link", { name: "ACME", exact: true }).hover(),
    content: (page) => page.getByText("Acme Global Equity — synthetic security."),
  },
];

/** Whether keyboard focus currently sits inside the locator's element. */
export function containsFocus(locator: Locator) {
  return locator.evaluate((element) => element.contains(document.activeElement));
}

/**
 * Presses a navigation key the way a person does, held for 50 ms. Radix moves
 * focus on the next tick and radios check only while the arrow is still down,
 * so an instant press can be released before the move lands.
 */
export function navigate(page: Page, key: string) {
  return page.keyboard.press(key, { delay: 50 });
}

/** Waits for every finite animation, such as an overlay fading in, to finish. */
export function settle(page: Page) {
  return page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    ),
  );
}

/** Lets the browser deliver pending events, such as a scroll, over two frames. */
export function nextFrames(page: Page) {
  return page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}
