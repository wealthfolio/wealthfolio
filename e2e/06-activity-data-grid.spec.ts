import { expect, Page, test } from "@playwright/test";
import { BASE_URL, gotoActivities, loginIfNeeded } from "./helpers";

test.describe.configure({ mode: "serial" });

test.describe("Activity Data Grid Inline Editing", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("1. Setup: login and navigate to activities", async () => {
    test.setTimeout(180000);
    await loginIfNeeded(page);
    await gotoActivities(page);
  });

  test("2. Grid loads: switch to edit mode, verify rows", async () => {
    await gotoActivities(page);
    await page.waitForTimeout(1000);

    // Switch to data grid (Edit mode)
    const editModeButton = page.getByTestId("edit-mode-toggle");
    await expect(editModeButton).toBeVisible({ timeout: 5000 });
    await editModeButton.click();
    await page.waitForTimeout(1000);

    // DataGrid renders with role="grid" (not <table>)
    const gridEl = page.locator('[data-slot="grid"]');
    await expect(gridEl).toBeVisible({ timeout: 10000 });

    // At least 5 data rows (from spec 02 which created 19 activities)
    const dataRows = page.locator('[data-slot="grid-row"]');
    const rowCount = await dataRows.count();
    expect(rowCount).toBeGreaterThanOrEqual(5);

    // Save/Cancel buttons should NOT be visible initially (no unsaved changes)
    await expect(page.getByRole("button", { name: "Save changes" })).not.toBeVisible();
  });

  test("3. Inline edit comment: dirty state and Save appears", async () => {
    await page.goto(`${BASE_URL}/activities`, { waitUntil: "domcontentloaded" });
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
    await page.goto(`${BASE_URL}/activities`, { waitUntil: "domcontentloaded" });
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
    await page.goto(`${BASE_URL}/activities`, { waitUntil: "domcontentloaded" });
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
    await page.goto(`${BASE_URL}/activities`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // Switch to edit mode
    await page.getByTestId("edit-mode-toggle").click();
    await page.waitForTimeout(1000);

    const dataRows = page.locator('[data-slot="grid-row"]');
    const initialCount = await dataRows.count();
    expect(initialCount).toBeGreaterThan(0);

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
  });
});
