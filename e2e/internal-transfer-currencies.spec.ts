import { expect, test, type Page } from "@playwright/test";
import {
  completeOnboardingIfNeeded,
  createAccount,
  gotoActivities,
  gotoAppPath,
  selectAccountOption,
} from "./helpers";

async function selectCurrency(page: Page, field: string, currency: string, mobile: boolean) {
  await page.getByTestId(field).click();
  await page
    .getByPlaceholder(mobile ? "Search all currencies..." : "Search currency...")
    .fill(currency);
  await page
    .getByRole(mobile ? "button" : "option", { name: new RegExp(currency) })
    .last()
    .click();
}

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"}: independent cash currencies survive creation and editing`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    const source = `Transfer currency ${mobile ? "mobile" : "desktop"} A`;
    const destination = `Transfer currency ${mobile ? "mobile" : "desktop"} B`;
    await completeOnboardingIfNeeded(page);
    await createAccount(page, source, "USD");
    await createAccount(page, destination, "USD");
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const openActivities = () =>
      mobile ? gotoAppPath(page, "/activities?tab=investments") : gotoActivities(page);
    await openActivities();
    if (mobile) {
      await page.getByTitle("Add", { exact: true }).click();
      await page.locator('label[for="TRANSFER_OUT"]').click();
      await page.getByRole("button", { name: "Next", exact: true }).click();
    } else {
      await page.getByTestId("add-activities-button").click();
      await page.getByTestId("add-transaction-action").click();
      const transfer = page.getByTestId("activity-type-transfer");
      if (!(await transfer.isVisible()))
        await page.getByRole("button", { name: "Expand to show all types" }).click();
      await transfer.click();
    }
    for (const [label, account] of [
      ["From Account", source],
      ["To Account", destination],
    ]) {
      const control = page.getByRole("combobox", { name: label, exact: true });
      if (mobile) {
        await control.click();
        await page.getByRole("button", { name: new RegExp(account) }).click();
      } else {
        await selectAccountOption(page, account, "USD", control);
      }
    }
    await page.getByText(/Advanced.*Notes/i).click();
    await selectCurrency(page, "sourceCurrency", "HKD", mobile);
    if (!mobile) await selectCurrency(page, "destinationCurrency", "HKD", false);
    const amount = mobile ? 780 : 1000;
    await page.getByLabel(mobile ? "Sent amount" : "Amount", { exact: true }).fill(String(amount));
    if (mobile) await page.getByLabel("Received amount", { exact: true }).fill("100");
    const save = async () => {
      const response = page.waitForResponse(
        (res) =>
          res.url().endsWith("/activities/transfer-pair") && res.request().method() === "POST",
      );
      if (mobile) {
        await page.getByRole("button", { name: /^(Add|Update) Activity$/ }).click();
      } else {
        await page.getByTestId("activity-form-dialog").locator('button[type="submit"]').click();
      }
      const saved = await response;
      expect(saved.ok(), await saved.text()).toBeTruthy();
      const request = saved.request().postDataJSON();
      expect(request.sourceCurrency).toBe("HKD");
      expect(request.destinationCurrency).toBe(mobile ? "USD" : "HKD");
      expect(Number(request.sourceAmount)).toBe(amount);
      expect(Number(request.destinationAmount)).toBe(mobile ? 100 : amount);
      expect(request.fxRate).toBeUndefined();
      const pair = await saved.json();
      expect(pair.transferOut.currency).toBe("HKD");
      expect(pair.transferIn.currency).toBe(mobile ? "USD" : "HKD");
      expect(pair.transferOut.fxRate ?? null).toBeNull();
      expect(pair.transferIn.fxRate ?? null).toBeNull();
      return pair;
    };
    const created = await save(); // No deposits: negative cash must remain recordable.
    // Exercise editing from either leg, without depending on other tests' rows.
    const editId = mobile ? created.transferIn.id : created.transferOut.id;
    await gotoAppPath(page, `/activities?tab=investments&activity=${encodeURIComponent(editId)}`);
    if (mobile) {
      await page.getByRole("button", { name: "Open", exact: true }).first().click();
      await page.getByText("Edit", { exact: true }).click();
    } else {
      await page
        .locator("tbody tr")
        .filter({ hasText: source })
        .first()
        .getByRole("button", { name: "Open", exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    }
    await page.getByText(/Advanced.*Notes/i).click();
    await expect(page.getByTestId("sourceCurrency")).toContainText(/HKD|Hong Kong/);
    await page.locator('textarea[name="comment"]').fill("Currency round trip");
    const updated = await save();
    expect(updated.transferOut.id).toBe(created.transferOut.id);
    expect(updated.transferIn.id).toBe(created.transferIn.id);
  });
}
