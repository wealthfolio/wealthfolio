import { expect, test } from "@playwright/test";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

const rootFontSize = (page: import("@playwright/test").Page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).fontSize);

test("the text size saves, scales the root font size and applies before the app loads", async ({
  page,
}) => {
  test.setTimeout(120000);
  await completeOnboardingIfNeeded(page);
  await gotoAppPath(page, "/settings/appearance");

  const sizes = page.getByRole("group", { name: "Text size" });
  await expect(sizes.getByRole("button", { name: "Default", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const base = parseFloat(await rootFontSize(page));

  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      new URL(response.url()).pathname.endsWith("/settings"),
  );
  await sizes.getByRole("button", { name: "Extra large", exact: true }).click();
  const response = await saved;
  expect(response.request().postDataJSON()).toEqual({ textSize: "extra-large" });
  expect(response.status(), await response.text()).toBe(200);
  expect(await response.json()).toMatchObject({ textSize: "extra-large" });

  await expect(page.locator("html")).toHaveAttribute("data-text-size", "extra-large");
  expect(parseFloat(await rootFontSize(page))).toBeCloseTo(base * 1.3, 1);

  // index.html applies the cached size before the app's scripts run: the
  // document turns interactive after the inline script, before module scripts.
  await page.addInitScript(() => {
    document.addEventListener("readystatechange", () => {
      if (document.readyState !== "interactive") return;
      (window as unknown as { bootSize?: string | null }).bootSize =
        document.documentElement.getAttribute("data-text-size");
    });
  });
  await page.reload();
  await expect(sizes.getByRole("button", { name: "Extra large", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await page.evaluate(() => (window as unknown as { bootSize?: string }).bootSize)).toBe(
    "extra-large",
  );

  await sizes.getByRole("button", { name: "Default", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-text-size", "default");
  expect(parseFloat(await rootFontSize(page))).toBeCloseTo(base, 1);
});
