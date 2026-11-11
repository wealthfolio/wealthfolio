import { expect, test } from "@playwright/test";
import { createAccount, uniqueName } from "./api";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";

test("option expiration preserves month/day while entering the year", async ({ page }) => {
  test.setTimeout(180000);
  await completeOnboardingIfNeeded(page);
  await createAccount(page, { name: uniqueName("Option expiration regression") });
  await page.goto(`${BASE_URL}/activities/manage?type=BUY`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Option", exact: true }).click();

  // The first date field is the activity timestamp; the last is option expiration.
  const month = page.getByRole("spinbutton", { name: /month/i }).last();
  const day = page.getByRole("spinbutton", { name: /day/i }).last();
  const year = page.getByRole("spinbutton", { name: /year/i }).last();
  await month.click();
  await page.keyboard.type("12");
  await day.click();
  await page.keyboard.type("31");
  await year.click();
  await page.keyboard.type("2");
  await expect(month).toHaveAttribute("aria-valuenow", "12");
  await expect(day).toHaveAttribute("aria-valuenow", "31");
  await page.keyboard.type("027");
  await page.keyboard.press("Tab");
  await expect(year).toHaveAttribute("aria-valuenow", "2027");
  await expect(month).toHaveAttribute("aria-valuenow", "12");
  await expect(day).toHaveAttribute("aria-valuenow", "31");
});
