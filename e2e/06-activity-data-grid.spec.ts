import { expect, Page, test } from "@playwright/test";
import { createAccount, deposit, uniqueName } from "./api";
import { BASE_URL, loginIfNeeded } from "./helpers";

test.describe.configure({ mode: "serial" });

const ACCOUNT_NAME = uniqueName("Data Grid");
const ACCOUNT_CURRENCY = "USD";
const SEEDED_ROWS = 5;

test.describe("Activity Data Grid Inline Editing", () => {
  let page: Page;
  // The grid is scoped to this spec's account, so it edits and deletes only its own rows.
  let activitiesUrl: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("1. Setup: login and seed activities", async () => {
    test.setTimeout(180000);
    await loginIfNeeded(page);
    const account = await createAccount(page, { name: ACCOUNT_NAME, currency: ACCOUNT_CURRENCY });
    for (let daysAgo = 1; daysAgo <= SEEDED_ROWS; daysAgo++) {
      const date = new Date();
      date.setDate(date.getDate() - daysAgo);
      await deposit(page, account.id, 100 * daysAgo, ACCOUNT_CURRENCY, date.toISOString());
    }
    activitiesUrl = `${BASE_URL}/activities?account=${account.id}`;
  });

  test("2. Grid loads: switch to edit mode, verify rows", async () => {
    await page.goto(activitiesUrl, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("add-activities-button")).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    // Switch to data grid (Edit mode)
    const editModeButton = page.getByTestId("edit-mode-toggle");
    await expect(editModeButton).toBeVisible({ timeout: 5000 });
    await editModeButton.click();
    await page.waitForTimeout(1000);

    // DataGrid renders with role="grid" (not <table>)
    const gridEl = page.locator('[data-slot="grid"]');
    await expect(gridEl).toBeVisible({ timeout: 10000 });

    // Exactly the rows this spec seeded in its own account
    const dataRows = page.locator('[data-slot="grid-row"]');
    await expect(dataRows).toHaveCount(SEEDED_ROWS, { timeout: 10000 });

    // Save/Cancel buttons should NOT be visible initially (no unsaved changes)
    await expect(page.getByRole("button", { name: "Save changes" })).not.toBeVisible();
  });

  test("3. Inline edit comment: dirty state and Save appears", async () => {
    await page.goto(activitiesUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // Switch to edit mode
    await page.getByTestId("edit-mode-toggle").click();
    await page.waitForTimeout(1000);

    // Find first data row
    const firstRow = page.locator('[data-slot="grid-row"]').first();
    await expect(firstRow).toBeVisible({ timeout: 10000 });

    // Double-click the comment cell to start editing
    const commentCell = firstRow.locator('[data-column-id="comment"]');
    await commentCell.dblclick();
    await page.waitForTimeout(300);

    // Type some text
    await page.keyboard.type("E2E test note");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(500);

    // "pending change" text should appear in toolbar
    await expect(page.getByText(/pending change/i)).toBeVisible({ timeout: 5000 });

    // Save button should appear
    await expect(page.getByRole("button", { name: "Save changes" })).toBeVisible({ timeout: 5000 });
  });

  test("4. Save edits: pending changes clear after save", async () => {
    await page.goto(activitiesUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // Switch to edit mode
    await page.getByTestId("edit-mode-toggle").click();
    await page.waitForTimeout(1000);

    // Edit comment cell in first data row
    const firstRow = page.locator('[data-slot="grid-row"]').first();
    await expect(firstRow).toBeVisible({ timeout: 10000 });

    const commentCell = firstRow.locator('[data-column-id="comment"]');
    await commentCell.dblclick();
    await page.waitForTimeout(300);
    await page.keyboard.type("Save test note");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(500);

    // Click Save
    const saveBtn = page.getByRole("button", { name: "Save changes" });
    await expect(saveBtn).toBeVisible({ timeout: 5000 });
    await saveBtn.click();

    // After save, pending changes indicator should disappear
    await expect(page.getByText(/pending change/i)).not.toBeVisible({ timeout: 10000 });
    await expect(page.getByRole("button", { name: "Save changes" })).not.toBeVisible({
      timeout: 5000,
    });
  });

  test("5. Discard changes: Cancel reverts edits", async () => {
    await page.goto(activitiesUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // Switch to edit mode
    await page.getByTestId("edit-mode-toggle").click();
    await page.waitForTimeout(1000);

    const firstRow = page.locator('[data-slot="grid-row"]').first();
    await expect(firstRow).toBeVisible({ timeout: 10000 });

    const commentCell = firstRow.locator('[data-column-id="comment"]');
    await commentCell.dblclick();
    await page.waitForTimeout(300);
    await page.keyboard.type("DISCARD THIS");
    await page.keyboard.press("Tab");
    await page.waitForTimeout(500);

    // Verify pending change indicator is there
    await expect(page.getByText(/pending change/i)).toBeVisible({ timeout: 5000 });

    // Click Cancel (Discard)
    const cancelBtn = page.getByRole("button", { name: "Discard changes" });
    await expect(cancelBtn).toBeVisible({ timeout: 5000 });
    await cancelBtn.click();
    await page.waitForTimeout(500);

    // Pending changes should be gone
    await expect(page.getByText(/pending change/i)).not.toBeVisible({ timeout: 5000 });
    await expect(page.getByRole("button", { name: "Save changes" })).not.toBeVisible();
  });

  test("6. Delete row: select row and delete", async () => {
    await page.goto(activitiesUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // Switch to edit mode
    await page.getByTestId("edit-mode-toggle").click();
    await page.waitForTimeout(1000);

    const dataRows = page.locator('[data-slot="grid-row"]');
    await expect(dataRows).toHaveCount(SEEDED_ROWS, { timeout: 10000 });

    // Select the first row via its "Select row" checkbox
    const firstRowCheckbox = dataRows.first().getByRole("checkbox", { name: "Select row" });
    await firstRowCheckbox.click();
    await page.waitForTimeout(300);

    // Delete button should appear
    const deleteBtn = page.getByRole("button", { name: "Delete selected" });
    await expect(deleteBtn).toBeVisible({ timeout: 5000 });
    await deleteBtn.click();
    await page.waitForTimeout(500);

    // There should now be pending changes (row marked for deletion)
    await expect(page.getByText(/pending change/i)).toBeVisible({ timeout: 5000 });

    // Save to confirm deletion
    const saveBtn = page.getByRole("button", { name: "Save changes" });
    await expect(saveBtn).toBeVisible({ timeout: 5000 });
    await saveBtn.click();

    await expect(page.getByText(/pending change/i)).not.toBeVisible({ timeout: 10000 });
    await expect(dataRows).toHaveCount(SEEDED_ROWS - 1, { timeout: 10000 });
  });
});
