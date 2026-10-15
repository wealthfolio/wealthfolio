import { expect, test } from "@playwright/test";
import { navigate, openGallery } from "./gallery";

// Keyboard behaviour of the inline primitives. RTL is not covered: no shipped
// locale is right-to-left and the app provides no reading direction to primitives.

test("tabs move and activate with arrow keys, Home and End", async ({ page }) => {
  await openGallery(page);
  const overview = page.getByRole("tab", { name: "Overview" });
  await overview.focus();
  await navigate(page, "ArrowRight");
  const holdings = page.getByRole("tab", { name: "Holdings" });
  await expect(holdings).toBeFocused();
  await expect(holdings).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveText("Holdings panel");
  await navigate(page, "End");
  await expect(page.getByRole("tab", { name: "Activity" })).toBeFocused();
  await navigate(page, "Home");
  await expect(overview).toBeFocused();
  await expect(page.getByRole("tabpanel")).toHaveText("Overview panel");
});

test("single toggle group moves focus with arrows and selects with Space", async ({ page }) => {
  // Items are toggle buttons (aria-pressed), like AnimatedToggleGroup's segments.
  await openGallery(page);
  const group = page.getByRole("group", { name: "Range" });
  const month = group.getByRole("button", { name: "1m" });
  await expect(month).toHaveAttribute("aria-pressed", "true");
  await month.focus();
  await navigate(page, "ArrowRight");
  const year = group.getByRole("button", { name: "1y" });
  await expect(year).toBeFocused();
  await expect(month).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Space");
  await expect(year).toHaveAttribute("aria-pressed", "true");
  await expect(month).toHaveAttribute("aria-pressed", "false");
});

test("multiple toggle group toggles each item independently", async ({ page }) => {
  await openGallery(page);
  const group = page.getByRole("group", { name: "Asset types" });
  const stocks = group.getByRole("button", { name: "stocks" });
  const bonds = group.getByRole("button", { name: "bonds" });
  await expect(stocks).toHaveAttribute("aria-pressed", "true");
  await stocks.focus();
  await navigate(page, "ArrowRight");
  await expect(bonds).toBeFocused();
  await page.keyboard.press("Space");
  await expect(bonds).toHaveAttribute("aria-pressed", "true");
  await expect(stocks).toHaveAttribute("aria-pressed", "true");
});

test("radio group checks with arrows and skips the disabled option", async ({ page }) => {
  await openGallery(page);
  const group = page.getByRole("radiogroup", { name: "Density" });
  const comfortable = group.getByRole("radio", { name: "comfortable" });
  await expect(comfortable).toBeChecked();
  await comfortable.focus();
  await navigate(page, "ArrowDown");
  const compact = group.getByRole("radio", { name: "compact" });
  await expect(compact).toBeFocused();
  await expect(compact).toBeChecked();
  await expect(group.getByRole("radio", { name: "spacious" })).toBeDisabled();
});

test("checkbox, switch and toggle change with Space", async ({ page }) => {
  await openGallery(page);
  const archived = page.getByRole("checkbox", { name: "Include archived" });
  await archived.focus();
  await page.keyboard.press("Space");
  await expect(archived).toBeChecked();
  const fees = page.getByRole("switch", { name: "Show fees" });
  await fees.focus();
  await page.keyboard.press("Space");
  await expect(fees).not.toBeChecked();
  const italic = page.getByRole("button", { name: "Italic" });
  await italic.focus();
  await page.keyboard.press("Space");
  await expect(italic).toHaveAttribute("aria-pressed", "true");
});

test("wrapping and sibling labels name and toggle their controls", async ({ page }) => {
  await openGallery(page);
  const archived = page.getByRole("checkbox", { name: "Include archived" });
  await page.getByText("Include archived").click();
  await expect(archived).toBeChecked();
  const sync = page.getByRole("switch", { name: "Sync automatically" });
  await page.getByText("Sync automatically").click();
  await expect(sync).toBeChecked();
  const terms = page.getByRole("checkbox", { name: "Accept terms" });
  await page.getByText("Accept terms").click();
  await expect(terms).toBeChecked();
  const compact = page.getByRole("radio", { name: "compact" });
  await page.getByText("compact", { exact: true }).click();
  await expect(compact).toBeChecked();
});

test("indeterminate checkbox reports mixed; a loaded avatar shows its image", async ({ page }) => {
  await openGallery(page);
  await expect(page.getByRole("checkbox", { name: "Select all" })).toHaveAttribute(
    "aria-checked",
    "mixed",
  );
  await expect(page.getByRole("img", { name: "Synthetic avatar" })).toBeVisible();
  await expect(page.getByText("SA", { exact: true })).toBeHidden();
});

test("accordion and collapsible open and close from the keyboard", async ({ page }) => {
  await openGallery(page);
  const taxes = page.getByRole("button", { name: "Taxes" });
  await taxes.focus();
  await page.keyboard.press("Enter");
  await expect(taxes).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Synthetic tax explanation.")).toBeVisible();
  await expect(page.getByText("Synthetic fee explanation.")).toBeHidden();
  const details = page.getByRole("button", { name: "Toggle details" });
  await details.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Collapsible details")).toBeHidden();
});

test("keyboard focus stays visible in forced colors", async ({ page, browserName }) => {
  // Known gap: the focus ring is a box-shadow, which forced colors removes.
  test.fail(true, "focus ring disappears in forced colors");
  // macOS WebKit only tabs to buttons with Option held.
  const tabKey = browserName === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab";
  await page.emulateMedia({ forcedColors: "active" });
  await openGallery(page);
  const primary = page.getByRole("button", { name: "Primary action", exact: true });
  await primary.focus();
  await page.keyboard.press(tabKey);
  const focused = page.getByRole("button", { name: "Secondary", exact: true });
  await expect(focused).toBeFocused();
  const outline = await focused.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  expect(outline.style).not.toBe("none");
  expect(outline.width).toBeGreaterThanOrEqual(1);
});
