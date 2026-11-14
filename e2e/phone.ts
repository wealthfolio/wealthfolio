import { expect, type Locator, type Page } from "@playwright/test";

// Phone-screen helpers. Phone specs run in Chrome on an iPhone-sized screen
// with touch input and an iPhone user agent, so the app picks its phone layout
// (tab bar, stacked screens, sheets, the step-based activity form).

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

/** `test.use(PHONE)` for a phone spec or describe block. */
export const PHONE = {
  viewport: { width: 390, height: 844 },
  userAgent: IPHONE_UA,
  hasTouch: true,
};

/** The tab bar at the bottom of the phone layout. */
export function tabBar(page: Page) {
  return page.getByRole("navigation", { name: "Primary navigation" });
}

/**
 * Taps the Back button of the screen on top, once the stack has settled: while
 * a screen slides in or out, the one it covers shows its own Back too.
 */
export async function tapBack(page: Page) {
  // Exact: "Back" alone would also match rows such as "Backup & export".
  const back = page.getByRole("button", { name: "Back", exact: true }).locator("visible=true");
  await expect(back).toHaveCount(1);
  await back.click();
}

export type PhoneActivityType =
  | "BUY"
  | "SELL"
  | "DEPOSIT"
  | "WITHDRAWAL"
  | "DIVIDEND"
  | "INTEREST"
  | "FEE"
  | "TAX"
  | "SPLIT"
  | "TRANSFER";

/** What a user types into the phone activity form; amounts as typed. */
export interface PhoneActivity {
  type: PhoneActivityType;
  /** Account name; for a transfer, the account it leaves. */
  account: string;
  /** Transfer only: the account it arrives in. */
  toAccount?: string;
  /** Buy, sell, dividend, split: a symbol the market-data search finds. */
  symbol?: string;
  quantity?: string;
  price?: string;
  /** Cash amount; for a dividend or interest, the amount received. */
  amount?: string;
  fee?: string;
  /** Split only, e.g. "2" for 2-for-1. */
  ratio?: string;
}

// The form's type picker names the transfer card by its outgoing leg.
const PICKER_VALUE: Record<PhoneActivityType, string> = {
  BUY: "BUY",
  SELL: "SELL",
  DEPOSIT: "DEPOSIT",
  WITHDRAWAL: "WITHDRAWAL",
  DIVIDEND: "DIVIDEND",
  INTEREST: "INTEREST",
  FEE: "FEE",
  TAX: "TAX",
  SPLIT: "SPLIT",
  TRANSFER: "TRANSFER_OUT",
};

/** The phone activity form, open as a sheet. */
export function activitySheet(
  page: Page,
  name: "Add Activity" | "Update Activity" = "Add Activity",
) {
  return page.getByRole("dialog", { name, exact: true });
}

/** Opens the form from the Activities screen's Add button. */
export async function openPhoneActivityForm(page: Page) {
  await page.getByTitle("Add", { exact: true }).click();
  const sheet = activitySheet(page);
  await expect(sheet.getByRole("radiogroup")).toBeVisible();
  return sheet;
}

/** Step 1: taps the type's card, then Next. */
export async function choosePhoneActivityType(page: Page, type: PhoneActivityType) {
  const sheet = activitySheet(page);
  await sheet.locator(`label[for$="-${PICKER_VALUE[type]}"]`).click();
  await sheet.getByRole("button", { name: "Next", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "Add Activity", exact: true })).toBeVisible();
}

/** Opens an account field's sheet and taps the account. */
export async function pickPhoneAccount(
  page: Page,
  sheet: Locator,
  accountName: string,
  label = "Account",
) {
  await sheet.getByRole("combobox", { name: label, exact: true }).click();
  const picker = page.getByRole("dialog", { name: label, exact: true });
  await picker
    .getByRole("option", { name: new RegExp(`^${escapeRegExp(accountName)}\\b`) })
    .click();
  await expect(picker).toBeHidden();
  await expect(sheet.getByRole("combobox", { name: label, exact: true })).toContainText(
    accountName,
  );
}

/** Opens the Symbol sheet, searches and taps the exact symbol (not a custom one). */
export async function pickPhoneSymbol(page: Page, sheet: Locator, symbol: string) {
  await sheet.getByRole("combobox", { name: "Symbol", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Select Symbol", exact: true });
  await picker.getByPlaceholder("Search for symbol").fill(symbol);
  const option = picker
    .getByRole("option")
    .filter({
      has: page.locator("span.font-mono").filter({
        hasText: new RegExp(`^${escapeRegExp(symbol)}$`, "i"),
      }),
      hasNotText: /Create custom|manual/i,
    })
    .first();
  await expect(option).toBeVisible({ timeout: 30_000 });
  await option.click();
  await expect(picker).toBeHidden();
  await expect(sheet.getByRole("combobox", { name: "Symbol", exact: true })).toContainText(symbol);
}

async function fill(sheet: Locator, label: string, value: string | undefined) {
  if (value === undefined) return;
  const input = sheet.getByRole("textbox", { name: label, exact: true });
  await input.fill(value);
  await input.blur();
}

/** Step 2: fills the details step for `activity`; leaves fields it doesn't name empty. */
export async function fillPhoneActivityDetails(page: Page, activity: PhoneActivity) {
  const sheet = activitySheet(page);
  if (activity.type === "TRANSFER") {
    await pickPhoneAccount(page, sheet, activity.account, "From Account");
    if (activity.toAccount) {
      await pickPhoneAccount(page, sheet, activity.toAccount, "To Account");
    }
  } else {
    await pickPhoneAccount(page, sheet, activity.account);
  }
  if (activity.symbol) await pickPhoneSymbol(page, sheet, activity.symbol);

  switch (activity.type) {
    case "BUY":
    case "SELL":
      await fill(sheet, "Shares", activity.quantity);
      await fill(sheet, "Price", activity.price);
      await fill(sheet, "Fee (Optional)", activity.fee);
      break;
    case "DIVIDEND":
    case "INTEREST":
      await fill(sheet, "Received amount", activity.amount);
      break;
    case "FEE":
      await fill(sheet, "Fee Amount", activity.amount);
      break;
    case "TAX":
      await fill(sheet, "Tax Amount", activity.amount);
      break;
    case "SPLIT":
      await fill(sheet, "Split Ratio", activity.ratio);
      break;
    default:
      await fill(sheet, "Amount", activity.amount);
      await fill(sheet, "Fee (Optional)", activity.fee);
  }
}

export interface SavedActivity {
  id: string;
  accountId: string;
  activityType: string;
  assetId?: string | null;
  quantity?: string | null;
  unitPrice?: string | null;
  amount?: string | null;
  fee?: string | null;
  currency: string;
}

/**
 * Taps the form's save button and returns what the server saved. A transfer
 * saves two rows: its `transferOut` and `transferIn` legs.
 */
export async function savePhoneActivity(
  page: Page,
  button: "Add Activity" | "Update Activity" = "Add Activity",
) {
  const sheet = activitySheet(page, button);
  const saved = page.waitForResponse((response) => {
    const path = new URL(response.url()).pathname;
    return (
      ["POST", "PUT"].includes(response.request().method()) &&
      (path.endsWith("/api/v1/activities") || path.endsWith("/api/v1/activities/transfer-pair"))
    );
  });
  await sheet.getByRole("button", { name: button, exact: true }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(sheet).toBeHidden();
  return response.json();
}

/**
 * Adds an activity the way a phone user does: Add on the Activities screen,
 * the type's card, Next, the details step, then Add Activity. Call on the
 * Activities screen. Returns what the server saved.
 */
export async function addActivityOnPhone(page: Page, activity: PhoneActivity) {
  await openPhoneActivityForm(page);
  await choosePhoneActivityType(page, activity.type);
  await fillPhoneActivityDetails(page, activity);
  return savePhoneActivity(page);
}

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
