import { devices, expect, test, type Locator, type Page } from "@playwright/test";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test.use({
  viewport: { width: 390, height: 844 },
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  hasTouch: true,
});

// Header icon buttons look 36px on phones; an invisible ::after layer gives them a
// larger tap area. Measure that area, not the visible circle.
async function tapArea(control: Locator) {
  return control.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const layer = getComputedStyle(element, "::after");
    const covers = layer.position === "absolute";
    return {
      width: Math.max(rect.width, covers ? parseFloat(layer.width) : 0),
      height: Math.max(rect.height, covers ? parseFloat(layer.height) : 0),
    };
  });
}

async function seedAccounts(page: Page) {
  await page.evaluate(async () => {
    const { profileScope } = await import(
      new URL("/src/features/profiles/session.ts", location.href).href
    );
    const headers = { "Content-Type": "application/json", "x-wf-profile-scope": profileScope() };
    const ids = [];
    for (const [name, accountType] of [
      ["Grid bank", "CASH"],
      ["Grid card", "CREDIT_CARD"],
    ]) {
      const response = await fetch("/api/v1/accounts", {
        method: "POST",
        headers,
        body: JSON.stringify({
          name,
          accountType,
          currency: "USD",
          isActive: true,
          isDefault: false,
          isArchived: false,
          trackingMode: "TRANSACTIONS",
        }),
      });
      if (!response.ok) throw new Error("Could not seed spending account");
      ids.push((await response.json()).id);
    }
    const response = await fetch("/api/v1/spending/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ enabled: true, accountIds: ids }),
    });
    if (!response.ok) throw new Error("Could not enable spending fixture");
  });
}

test.beforeEach(async ({ browser, page }) => {
  const desktop = await browser.newContext({ ...devices["Desktop Chrome"] });
  await completeOnboardingIfNeeded(await desktop.newPage());
  await desktop.close();
  await completeOnboardingIfNeeded(page);
  await gotoAppPath(page, "/");
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
  await seedAccounts(page);
});

for (const direction of ["ltr", "rtl"] as const) {
  test(`contextual creation menu and direct Spending entries at 320px ${direction}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 844 });
    await gotoAppPath(page, `/?tab=spending&dir=${direction}`);
    // Spending joins the tabs once settings load; until then the header shows
    // Investments' menu, which has no "Add expense".
    await expect(
      page.getByRole("button", { name: "Spending", exact: true }).filter({ visible: true }),
    ).toHaveAttribute("aria-current", "page");
    const add = page.getByRole("button", { name: "More options", exact: true }).first();
    await expect(add).toBeInViewport();
    const bounds = await tapArea(add);
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    await add.click();
    await page.getByRole("button", { name: "Add expense", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Add expense" })).toBeVisible();
    await expect(dialog.getByRole("radiogroup")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Next", exact: true })).toHaveCount(0);
    const account = dialog.getByRole("combobox", { name: "Account", exact: true });
    await expect(account).toContainText("Select an account");
    const amount = dialog.getByRole("textbox", { name: "Amount", exact: true });
    expect((await amount.boundingBox())!.y).toBeLessThan((await account.boundingBox())!.y);
    // Enabled from the start: a missing account is reported on its row instead.
    const save = dialog.getByRole("button", { name: "Add expense", exact: true });
    await expect(save).toBeEnabled();
    await account.click();
    await page.getByRole("option", { name: /^Grid card\b/ }).click();
    await amount.fill("12.50");
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /\/api\/v1\/activities$/.test(new URL(response.url()).pathname),
    );
    await save.click();
    const response = await created;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON()).toMatchObject({
      activityType: "WITHDRAWAL",
      amount: 12.5,
    });
    await expect(page).not.toHaveURL(/transactions\/new/);

    await add.click();
    await page.getByRole("button", { name: "Add income", exact: true }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Add income" })).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Account", exact: true })).toContainText(
      "Grid bank",
    );
    await dialog.getByRole("combobox", { name: "Account", exact: true }).click();
    await expect(page.getByRole("option", { name: /^Grid card\b/ })).toHaveCount(0);
    await page.getByRole("option", { name: /^Grid bank\b/ }).click();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page).not.toHaveURL(/transactions\/new/);

    await add.click();
    await page.getByRole("button", { name: "Transfer", exact: true }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("radiogroup")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Next", exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();

    await page.getByRole("link", { name: "Search", exact: true }).click();
    const search = page.getByRole("dialog");
    await search.getByRole("combobox").fill("expense");
    await search.getByRole("option", { name: "Add expense", exact: true }).click();
    await expect(
      page.getByRole("dialog").getByRole("heading", { name: "Add expense" }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test("compact dashboard tabs share a row with square actions and keep swipe navigation", async ({
  page,
}) => {
  for (const direction of ["ltr", "rtl"]) {
    for (const width of [320, 402]) {
      await page.setViewportSize({ width, height: 874 });
      await gotoAppPath(page, `/dashboard?tab=investments&dir=${direction}`);
      const investments = page.getByRole("button", { name: "Investments", exact: true });
      const netWorth = page.getByRole("button", { name: "Net Worth", exact: true });
      const spending = page.getByRole("button", { name: "Spending", exact: true });
      await expect(investments).toHaveText("Investments");
      await expect(netWorth).toHaveText("");
      await expect(spending).toHaveText("");
      const filter = page.getByRole("combobox", {
        name: "Choose portfolio: All Accounts",
        exact: true,
      });
      const menu = page.getByRole("button", { name: "More options", exact: true }).first();
      for (const action of [filter, menu]) {
        await expect(action).toBeInViewport({ ratio: 1 });
        const box = (await action.boundingBox())!;
        const tab = (await investments.boundingBox())!;
        expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(1);
        expect((await tapArea(action)).width).toBeGreaterThanOrEqual(44);
        expect(Math.abs(box.y + box.height / 2 - (tab.y + tab.height / 2))).toBeLessThan(2);
      }
      if (width === 402 && direction === "ltr") {
        await page.screenshot({ path: test.info().outputPath("restored-dashboard-header.png") });
      }
      await netWorth.click();
      await expect(netWorth).toHaveAttribute("aria-current", "page");
      await expect(netWorth).toHaveText("Net Worth");
      await expect(investments).toHaveText("");
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    }
  }

  await gotoAppPath(page, "/dashboard?tab=investments&dir=ltr");
  await expect(page.getByRole("button", { name: "Investments", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator(".touch-pan-y:has(> .basis-full)").first()).toHaveCSS(
    "transform",
    /matrix/,
  );
  const accounts = page.getByRole("heading", { name: "Accounts", exact: true });
  await expect(accounts).toBeVisible();
  // Swipe once Spending has joined the tabs, not while the carousel changes.
  await expect(
    page.getByRole("button", { name: "Spending", exact: true }).filter({ visible: true }),
  ).toBeVisible();
  const swipeY = (await accounts.boundingBox())!.y + 10;
  // A real finger gesture in the page body still switches the carousel.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 350, y: swipeY }],
  });
  for (let step = 1; step <= 10; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: 350 - step * 30, y: swipeY }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
  await expect(page.getByRole("button", { name: "Net Worth", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("all dashboards use the overflow menu for creation without a separate plus button", async ({
  page,
}) => {
  await gotoAppPath(page, "/?tab=investments");
  await expect(page.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "More options", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Add transaction", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add expense", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add income", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Update prices", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await gotoAppPath(page, "/?tab=net-worth");
  await expect(page.getByRole("button", { name: "Add", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "More options", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "Add expense", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add income", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add Asset", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByRole("heading", { name: "Add New Asset", exact: true }),
  ).toBeVisible();
});
