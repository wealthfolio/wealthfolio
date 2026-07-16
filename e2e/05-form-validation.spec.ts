import { expect, Page, test } from "@playwright/test";
import { BASE_URL, loginIfNeeded, selectFirstAccount } from "./helpers";

test.describe.configure({ mode: "serial" });

test.describe("Activity Form Validation", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("1. Setup: login", async () => {
    test.setTimeout(180000);
    await loginIfNeeded(page);
    await page.goto(`${BASE_URL}/dashboard`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("portfolio-balance-value")).toBeVisible({ timeout: 30000 });
  });

  test("2. Deposit — missing account and amount shows errors", async () => {
    await page.goto(`${BASE_URL}/activities/manage?type=DEPOSIT`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(1000);

    // Submit without filling anything
    const submitButton = page.getByRole("button", { name: /Add Deposit/i });
    await expect(submitButton).toBeVisible({ timeout: 10000 });
    await submitButton.click();
    await page.waitForTimeout(500);

    // Both errors should be visible (exact match avoids strict mode violation with toast)
    await expect(page.getByText("Please select an account.", { exact: true }).first()).toBeVisible({
      timeout: 5000,
    });
    await expect(page.getByText("Amount must be a number.", { exact: true }).first()).toBeVisible({
      timeout: 5000,
    });
  });

  test("3. Deposit — zero amount shows error", async () => {
    await page.goto(`${BASE_URL}/activities/manage?type=DEPOSIT`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(1000);

    // Select an account
    await selectFirstAccount(page);

    // Fill zero amount (the MoneyInput disallows negatives, so use 0 to trigger the error)
    const amountInput = page.getByTestId("amount-input");
    await amountInput.fill("0");
    await amountInput.blur();
    await page.waitForTimeout(200);

    const submitButton = page.getByRole("button", { name: /Add Deposit/i });
    await submitButton.click();
    await page.waitForTimeout(500);

    await expect(
      page.getByText("Amount must be greater than 0.", { exact: true }).first(),
    ).toBeVisible({ timeout: 5000 });
  });

  test("4. Buy — missing symbol shows error", async () => {
    await page.goto(`${BASE_URL}/activities/manage?type=BUY`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // Select an account
    await selectFirstAccount(page);

    // Fill quantity and price but NOT symbol
    const quantityInput = page.getByTestId("quantity-input");
    await quantityInput.fill("10");
    await quantityInput.blur();

    const priceInput = page.getByTestId("price-input");
    await priceInput.fill("100");
    await priceInput.blur();
    await page.waitForTimeout(200);

    const submitButton = page.getByRole("button", { name: /Add Buy/i });
    await submitButton.click();
    await page.waitForTimeout(500);

    // Should show symbol-related validation error
    await expect(page.getByText("Please enter a symbol.", { exact: true }).first()).toBeVisible({
      timeout: 5000,
    });
  });

  test("5. Buy — zero quantity shows error", async () => {
    await page.goto(`${BASE_URL}/activities/manage?type=BUY`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // Select an account
    await selectFirstAccount(page);

    // Fill quantity as 0
    const quantityInput = page.getByTestId("quantity-input");
    await quantityInput.fill("0");
    await quantityInput.blur();

    const priceInput = page.getByTestId("price-input");
    await priceInput.fill("100");
    await priceInput.blur();
    await page.waitForTimeout(200);

    const submitButton = page.getByRole("button", { name: /Add Buy/i });
    await submitButton.click();
    await page.waitForTimeout(500);

    // Should show quantity error
    await expect(
      page.getByText("Quantity must be greater than 0.", { exact: true }).first(),
    ).toBeVisible({ timeout: 5000 });
  });
});
