import { expect, test } from "@playwright/test";
import {
  restoreSpendingSettings,
  seedSpendingAccounts,
  translator,
  updateSettings,
  type Settings,
} from "./api";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test.use({
  viewport: { width: 390, height: 844 },
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  hasTouch: true,
});

let seeded: Awaited<ReturnType<typeof seedSpendingAccounts>> | undefined;
let previousSettings: Settings | undefined;

test.beforeEach(async ({ page }) => {
  await completeOnboardingIfNeeded(page);
  seeded = await seedSpendingAccounts(page, "Grid");
  await gotoAppPath(page, "/");
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeVisible();
});

test.afterEach(async ({ page }) => {
  if (previousSettings) await updateSettings(page, previousSettings);
  if (seeded) await restoreSpendingSettings(page, seeded.previous);
  previousSettings = undefined;
  seeded = undefined;
});

for (const scenario of [
  { width: 390, language: "en", direction: "ltr", largeText: false },
  { width: 320, language: "en", direction: "ltr", largeText: false },
  { width: 320, language: "de", direction: "ltr", largeText: true },
  { width: 320, language: "ar", direction: "rtl", largeText: true },
] as const) {
  test(`Spending grid preserves account-specific choices at ${scenario.width}px, ${scenario.language}, ${scenario.largeText ? "large" : "default"} text`, async ({
    page,
  }) => {
    const { bank, card } = seeded!;
    previousSettings = await updateSettings(page, {
      language: scenario.language,
      textSize: scenario.largeText ? "extra-large" : "default",
    });
    const t = translator(scenario.language);
    const copy = {
      spending: t("dashboard:tabs.spending"),
      moreOptions: t("common:layout.more_options"),
      addTransaction: t("spending:txTab.addTransaction"),
      account: t("common:account"),
      next: t("common:next"),
      back: t("common:back"),
      deposit: t("activity:type_deposit"),
      withdrawal: t("activity:type_withdrawal"),
      charge: t("spending:activityTypes.charge"),
      fee: t("activity:type_fee"),
      refund: t("spending:activityTypes.refundCredit"),
      withdrawalDescription: t("spending:cashForm.descWithdrawal"),
      creditDescription: t("spending:cashForm.descCredit"),
    };
    await page.setViewportSize({ width: scenario.width, height: 844 });
    await gotoAppPath(page, `/?tab=spending&dir=${scenario.direction}`);
    // Spending joins the tabs once settings load; Investments' menu has its own
    // "Add transaction", which opens the investment form instead.
    await expect(
      page.getByRole("button", { name: copy.spending, exact: true }).filter({ visible: true }),
    ).toHaveAttribute("aria-current", "page");
    await page.getByRole("button", { name: copy.moreOptions, exact: true }).first().click();
    await page.getByRole("button", { name: copy.addTransaction, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const account = dialog.getByRole("combobox", { name: copy.account, exact: true });
    await account.click();
    await page.getByRole("option", { name: bank.name }).click();
    const grid = dialog.getByRole("radiogroup");
    const bankHeight = (await dialog.boundingBox())!.height;
    await expect(grid.getByRole("radio")).toHaveCount(6);
    const cards = grid.locator("label");
    const first = (await cards.nth(0).boundingBox())!;
    const second = (await cards.nth(1).boundingBox())!;
    expect(Math.abs(first.y - second.y)).toBeLessThan(1);
    expect(first.height).toBeGreaterThanOrEqual(64);
    expect(scenario.direction === "rtl" ? first.x > second.x : first.x < second.x).toBe(true);
    expect(
      await cards.evaluateAll((labels) =>
        labels.every((label) => {
          const text = label.querySelector("span")!;
          return (
            text.scrollWidth <= text.clientWidth + 1 && text.scrollHeight <= text.clientHeight + 1
          );
        }),
      ),
    ).toBe(true);
    const next = dialog.getByRole("button", { name: copy.next, exact: true });
    if (!scenario.largeText) {
      const footer = (await dialog.locator('[data-slot="sheet-footer"]').boundingBox())!;
      const last = (await cards.last().boundingBox())!;
      expect(footer.y - last.y - last.height).toBeLessThan(40);
    }
    await expect(grid.getByRole("radio", { name: copy.withdrawal, exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(
      grid.getByRole("radio", { name: copy.withdrawal, exact: true }),
    ).toHaveAccessibleDescription(copy.withdrawalDescription);
    await expect(next).toBeEnabled();
    if (scenario.width === 390) {
      const last = (await cards.last().boundingBox())!;
      expect(last.y + last.height).toBeLessThanOrEqual((await next.boundingBox())!.y);
    }
    await cards.first().tap();
    await expect(grid.getByRole("radio", { name: copy.deposit, exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const writes: string[] = [];
    page.on("request", (request) => {
      if (
        ["POST", "PUT", "PATCH"].includes(request.method()) &&
        /\/api\/v1\/activities(?:\/|\?|$)/.test(request.url())
      )
        writes.push(request.method());
    });
    await next.click();
    await expect(grid).toBeHidden();
    await dialog.getByRole("button", { name: copy.back, exact: true }).click();
    await expect(grid.getByRole("radio", { name: copy.deposit, exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(writes).toHaveLength(0);

    await account.click();
    await page.getByRole("option", { name: card.name }).click();
    await expect(grid.getByRole("radio")).toHaveCount(4);
    if (!scenario.largeText)
      expect((await dialog.boundingBox())!.height).toBeLessThan(bankHeight - 32);
    await expect(grid.getByRole("radio", { name: copy.deposit, exact: true })).toHaveCount(0);
    const charge = grid.getByRole("radio", { name: copy.charge, exact: true });
    await expect(charge).toHaveAttribute("aria-checked", "true");
    await cards.last().scrollIntoViewIfNeeded();
    await cards.last().tap();
    await expect(grid.getByRole("radio", { name: copy.refund, exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(
      grid.getByRole("radio", { name: copy.refund, exact: true }),
    ).toHaveAccessibleDescription(copy.creditDescription);
    await charge.focus();
    await page.keyboard.press(scenario.direction === "rtl" ? "ArrowLeft" : "ArrowRight");
    await expect(grid.getByRole("radio", { name: copy.fee, exact: true })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(cards.nth(1)).toHaveCSS("outline-style", "solid");
    await expect(next).toBeInViewport();
    expect(writes).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}
