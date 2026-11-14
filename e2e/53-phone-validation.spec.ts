import { createAccount, getActivity, uniqueName, updateSettings, type ApiAccount } from "./api";
import { expect, test, type Locator, type Page } from "./fixtures";
import { completeOnboardingIfNeeded, gotoAppPath } from "./helpers";
import {
  activitySheet,
  addActivityOnPhone,
  choosePhoneActivityType,
  fillPhoneActivityDetails,
  openPhoneActivityForm,
  PHONE,
  type SavedActivity,
} from "./phone";

// The activity form's validation errors (as in 05-form-validation) on a phone,
// and amounts typed with a decimal comma.
test.use(PHONE);

let account: ApiAccount;

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  await completeOnboardingIfNeeded(page);
  account = await createAccount(page, { name: uniqueName("Phone checks") });
  // The form preselects the only account; a second one keeps the field empty.
  await createAccount(page, { name: uniqueName("Phone checks other"), currency: "CAD" });
  await page.close();
});

test.beforeEach(async ({ page }) => {
  await completeOnboardingIfNeeded(page);
  await gotoAppPath(page, "/activities");
  await expect(page.getByTitle("Add", { exact: true })).toBeVisible();
});

/**
 * Taps Add Activity and checks that the form stays open without saving and
 * shows each message on screen, still there a moment later. The phone form
 * words some messages differently from the desktop one.
 */
async function expectErrorsOnSave(page: Page, messages: string[]) {
  const writes: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      /\/api\/v1\/activities(\/transfer-pair)?$/.test(request.url())
    ) {
      writes.push(request.url());
    }
  });
  const sheet = activitySheet(page);
  await sheet.getByRole("button", { name: "Add Activity", exact: true }).click();
  const errors: Locator[] = messages.map((message) => sheet.getByText(message, { exact: true }));
  for (const error of errors) await expect(error).toBeVisible();
  await page.waitForTimeout(1500);
  for (const error of errors) await expect(error).toBeVisible();
  // On screen: not scrolled out of the sheet or hidden under its buttons.
  for (const error of errors) await expect(error).toBeInViewport();
  await expect(sheet).toBeVisible();
  expect(writes).toEqual([]);
}

test("deposit without an account or amount shows both errors", async ({ page }) => {
  await openPhoneActivityForm(page);
  await choosePhoneActivityType(page, "DEPOSIT");
  await expectErrorsOnSave(page, [
    "Please select an account.",
    "Amount must be a positive number.",
  ]);
});

test("buy without a symbol shows the symbol error", async ({ page }) => {
  await openPhoneActivityForm(page);
  await choosePhoneActivityType(page, "BUY");
  await fillPhoneActivityDetails(page, {
    type: "BUY",
    account: account.name,
    quantity: "10",
    price: "100",
  });
  await expectErrorsOnSave(page, ["Please select a security."]);
});

test("buy of zero shares shows the quantity error", async ({ page }) => {
  // The form focuses Shares, scrolling it only as far as the sheet's bottom edge;
  // its message, below it, must still be in view.
  await openPhoneActivityForm(page);
  await choosePhoneActivityType(page, "BUY");
  await fillPhoneActivityDetails(page, {
    type: "BUY",
    account: account.name,
    symbol: "MSFT",
    quantity: "0",
    price: "100",
  });
  await expectErrorsOnSave(page, ["Quantity must be greater than 0."]);
});

test("buy at a price of zero shows the price error", async ({ page }) => {
  await openPhoneActivityForm(page);
  await choosePhoneActivityType(page, "BUY");
  await fillPhoneActivityDetails(page, {
    type: "BUY",
    account: account.name,
    symbol: "MSFT",
    quantity: "5",
    price: "0",
  });
  await expectErrorsOnSave(page, ["Price must be greater than 0."]);
});

test("amounts typed with a decimal comma save their value", async ({ page }) => {
  test.setTimeout(90_000);
  // Germany writes 1.234,56; the region is app-wide, so it is put back.
  const previous = await updateSettings(page, { formattingRegion: "DE" });
  try {
    await page.reload();
    await expect(page.getByTitle("Add", { exact: true })).toBeVisible();
    const deposit = (await addActivityOnPhone(page, {
      type: "DEPOSIT",
      account: account.name,
      amount: "2.500,25",
    })) as SavedActivity;
    expect(Number((await getActivity(page, deposit.id)).amount)).toBe(2500.25);

    const buy = (await addActivityOnPhone(page, {
      type: "BUY",
      account: account.name,
      symbol: "MSFT",
      quantity: "1,5",
      price: "1.234,56",
      fee: "0,75",
    })) as SavedActivity;
    const stored = await getActivity(page, buy.id);
    expect([Number(stored.quantity), Number(stored.unitPrice), Number(stored.fee)]).toEqual([
      1.5, 1234.56, 0.75,
    ]);
  } finally {
    await updateSettings(page, previous);
  }
});
