import { devices, expect, test, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

const iphone =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
test.use({ viewport: { width: 390, height: 844 }, userAgent: iphone, hasTouch: true });
test.beforeEach(async ({ browser, page }) => {
  const desktop = await browser.newContext({ ...devices["Desktop Chrome"] });
  await completeOnboardingIfNeeded(await desktop.newPage());
  await desktop.close();
  await completeOnboardingIfNeeded(page);
  await gotoAppPath(page, "/");
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
});

async function profileRequest(
  page: Page,
  url: string,
  options: { data: unknown; method?: string },
) {
  return page.evaluate(
    async ({ url, options }) => {
      // Use this application's admitted session; do not unlock or switch profiles.
      const { profileScope } = await import(
        new URL("/src/features/profiles/session.ts", location.href).href
      );
      const response = await fetch(url, {
        method: options.method ?? "POST",
        headers: { "Content-Type": "application/json", "x-wf-profile-scope": profileScope() },
        body: JSON.stringify(options.data),
      });
      return { ok: response.ok, data: await response.json() };
    },
    { url, options },
  );
}

test("the legacy Add Holding command opens the existing entry dialog", async ({ page }) => {
  await gotoAppPath(page, "/activities/add?tab=holdings");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: /holdings/i })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Page not found", exact: true })).toHaveCount(0);
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(/\/activities$/);
  await gotoAppPath(page, "/activities/add?tab=holdings");
  await expect(page.getByRole("dialog")).toBeVisible();
});

for (const direction of ["ltr", "rtl"]) {
  test(`phone navigation keeps accessible icons, selected-only section tab labels and touch-sized Back (${direction})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await gotoAppPath(page, `/holdings?dir=${direction}`);
    const nav = page.getByRole("navigation", { name: "Primary navigation" });
    await expect(nav.getByRole("link", { name: "Dashboard", exact: true })).toHaveText("");
    await expect(nav.getByRole("link", { name: "Holdings", exact: true })).toHaveText("");
    await expect(nav.getByRole("link", { name: "Search", exact: true })).toHaveText("");
    await expect(nav.getByRole("button", { name: "More options", exact: true })).toHaveText("");
    // Section tabs name only the selected one; the others are icons with accessible names.
    const strip = page.getByRole("button", { name: "Investments", exact: true }).locator("..");
    await expect(strip).toHaveCSS("overflow-x", "auto");
    await expect(page.getByRole("button", { name: "Investments", exact: true })).toHaveText(
      "Investments",
    );
    await page.getByRole("button", { name: "Liabilities", exact: true }).click();
    await expect(page.getByRole("button", { name: "Liabilities", exact: true })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Liabilities", exact: true })).toHaveText(
      "Liabilities",
    );
    await expect(page.getByRole("button", { name: "Investments", exact: true })).toHaveText("");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await gotoAppPath(page, `/settings/general?dir=${direction}`);
    const backBounds = await page.getByRole("button", { name: "Back", exact: true }).boundingBox();
    expect(backBounds!.width).toBeGreaterThanOrEqual(44);
    expect(backBounds!.height).toBeGreaterThanOrEqual(44);
  });
}

test("Android navigation retains destination labels in both orientations", async ({ browser }) => {
  const context = await browser.newContext({ ...devices["Pixel 7"] });
  try {
    const page = await context.newPage();
    await completeOnboardingIfNeeded(page);
    for (const direction of ["ltr", "rtl"]) {
      await gotoAppPath(page, `/holdings?dir=${direction}`);
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 844, height: 390 },
      ]) {
        await page.setViewportSize(viewport);
        const nav = page.getByRole("navigation", { name: "Primary navigation" });
        for (const title of ["Dashboard", "Holdings", "Search"]) {
          await expect(nav.getByRole("link", { name: title, exact: true })).toHaveText(title);
        }
        await expect(nav.getByRole("button", { name: "More options", exact: true })).toHaveText(
          "More",
        );
      }
    }
  } finally {
    await context.close();
  }
});

test("Spending dashboard opens its transaction form directly", async ({ page }) => {
  const account = await profileRequest(page, `${BASE_URL}/api/v1/accounts`, {
    data: {
      name: "Mobile entry QA",
      accountType: "CASH",
      currency: "USD",
      isActive: true,
      isDefault: false,
      isArchived: false,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(account.ok).toBe(true);
  const { id } = account.data;
  const settings = await profileRequest(page, `${BASE_URL}/api/v1/spending/settings`, {
    method: "PUT",
    data: { enabled: true, accountIds: [id] },
  });
  expect(settings.ok).toBe(true);
  await gotoAppPath(page, "/?tab=spending");
  // Spending joins the tabs once settings load; Investments' menu has its own
  // "Add transaction", which opens the investment form instead.
  await expect(
    page.getByRole("button", { name: "Spending", exact: true }).filter({ visible: true }),
  ).toHaveAttribute("aria-current", "page");
  // Creation lives in the tab's overflow menu.
  await page.getByRole("button", { name: "More options", exact: true }).first().click();
  await page.getByRole("button", { name: "Add transaction", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Add Transaction", exact: true });
  await expect(form).toBeVisible();
  await expect(form.getByText("Select Transaction Type", { exact: true })).toBeVisible();
});

test("editor Save stays visible and dismissal preserves a draft until confirmed", async ({
  page,
}) => {
  const accountResponse = await profileRequest(page, `${BASE_URL}/api/v1/accounts`, {
    data: {
      name: "Mobile editor QA",
      accountType: "SECURITIES",
      currency: "USD",
      isActive: true,
      isDefault: false,
      isArchived: false,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(accountResponse.ok).toBe(true);
  const { id: accountId } = accountResponse.data;
  const buy = await profileRequest(page, `${BASE_URL}/api/v1/activities`, {
    data: {
      accountId,
      activityType: "BUY",
      activityDate: "2024-01-02T15:00:00Z",
      currency: "USD",
      fee: 0,
      needsReview: false,
      quantity: 1,
      unitPrice: 100,
      asset: {
        name: "Mobile editor asset",
        symbol: "MOBILEQA",
        kind: "INVESTMENT",
        quoteCcy: "USD",
        quoteMode: "MANUAL",
      },
    },
  });
  expect(buy.ok).toBe(true);
  await gotoAppPath(page, "/settings/securities");
  await page.getByPlaceholder("Search...").fill("MOBILEQA");
  await page.getByRole("button", { name: "Open actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
  const editor = page.getByRole("dialog").first();
  await expect(editor.getByRole("button", { name: "Save changes", exact: true })).toBeInViewport();
  const name = editor.getByRole("textbox", { name: "Name", exact: true });
  await name.fill("Unfinished mobile edit");
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  const discard = page.getByRole("alertdialog");
  await expect(discard).toBeVisible();
  await discard.getByRole("button", { name: "Keep Editing", exact: true }).click();
  await expect(name).toHaveValue("Unfinished mobile edit");
  await editor.getByRole("button", { name: "Close", exact: true }).click();
  await discard.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(editor).toBeHidden();
});

for (const direction of ["ltr", "rtl"]) {
  test(`Discard changes keeps its buttons' focus outline whole on a phone (${direction})`, async ({
    page,
  }) => {
    await gotoAppPath(page, `/activities?dir=${direction}`);
    await page.getByTitle("Add", { exact: true }).click();
    await page.locator('label[for$="-DEPOSIT"]').click();
    await page.getByRole("button", { name: /Next/ }).click();
    await page.getByPlaceholder("0.00").first().fill("25");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const discard = page.getByRole("alertdialog");
    await expect(discard).toBeVisible();

    for (const name of ["Keep Editing", "Discard"]) {
      const button = discard.getByRole("button", { name, exact: true });
      // Focus it by keyboard, so the outline shows as it does for a keyboard user.
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press("Tab");
        if (await button.evaluate((el) => el === document.activeElement)) break;
      }
      await expect(button).toBeFocused();
      const clipped = await button.evaluate((el) => {
        const style = getComputedStyle(el);
        const reach = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
        const box = el.getBoundingClientRect();
        const clippers: string[] = [];
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          if (getComputedStyle(parent).overflowX === "visible") continue;
          const bounds = parent.getBoundingClientRect();
          if (box.left - reach < bounds.left || box.right + reach > bounds.right) {
            clippers.push(parent.dataset.slot ?? parent.tagName);
          }
          if (parent.getAttribute("role") === "alertdialog") break;
        }
        return { outline: style.outlineStyle, reach, clippers };
      });
      expect(clipped.outline).not.toBe("none");
      expect(clipped.reach).toBeGreaterThan(0);
      expect(clipped.clippers).toEqual([]);
    }
  });
}
