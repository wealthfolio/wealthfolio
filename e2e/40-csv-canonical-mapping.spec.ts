import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";

for (const dir of ["ltr", "rtl"]) {
  test(`CSV import prefers appended canonical columns (${dir})`, async ({ page }) => {
    test.setTimeout(120_000);
    await completeOnboardingIfNeeded(page);

    const accountName = `Canonical CSV ${dir} ${Date.now().toString(36)}`;
    const accountResponse = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
      data: {
        name: accountName,
        accountType: "CASH",
        currency: "USD",
        isDefault: false,
        isActive: true,
        trackingMode: "TRANSACTIONS",
      },
    });
    expect(accountResponse.ok(), await accountResponse.text()).toBeTruthy();
    const account = (await accountResponse.json()) as { id: string };

    // The original bank values disagree with the prepared Wealthfolio columns.
    const csv = [
      "Transaction Date,Transaction Type,Sort Code,Account Number,Transaction Description,Debit Amount,Credit Amount,Balance,date,account,amount,activityType,subtype,comment",
      `2024-01-01,DEBIT,123456,00001234,Bank description,999,,1000,2024-02-02,${account.id},75,DEPOSIT,,Prepared comment`,
    ].join("\n");

    await page.goto(`${BASE_URL}/import?account=${account.id}&dir=${dir}`, {
      waitUntil: "domcontentloaded",
    });
    await expect(page.locator("html")).toHaveAttribute("dir", dir);
    await page.locator('input[type="file"]').setInputFiles({
      name: "canonical-columns.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });
    const configureMapping = page.getByRole("button", { name: /Configure Mapping/i });
    await expect(configureMapping).toBeEnabled({ timeout: 10_000 });
    await configureMapping.click();

    const preview = page.getByRole("tabpanel", { name: "Transaction Preview" });
    for (const field of ["date", "account", "amount", "activityType", "comment"]) {
      await expect(
        preview.locator("thead").getByRole("button", { name: field, exact: true }),
      ).toBeVisible();
    }
    await expect(preview.locator("tbody tr")).toHaveCount(1);
    await expect(preview.locator("tbody")).toContainText("Prepared comment");
    await expect(preview.locator("tbody")).not.toContainText("Bank description");

    await page.getByRole("button", { name: /Review Transactions/i }).click();
    const continueToImport = page.getByRole("button", { name: /Continue to Import/i });
    await expect(continueToImport).toBeEnabled({ timeout: 30_000 });
    await continueToImport.click();
    const importButton = page.getByRole("button", { name: /Import 1 Activity/i });
    await expect(importButton).toBeEnabled({ timeout: 10_000 });
    await importButton.click();
    await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 30_000 });

    const response = await page.request.post(`${BASE_URL}/api/v1/activities/search`, {
      data: { page: 0, pageSize: 100 },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = (await response.json()) as {
      data: Array<{
        accountId: string;
        activityType: string;
        date: string;
        amount: string | null;
        comment: string | null;
      }>;
    };
    const rows = body.data.filter((row) => row.accountId === account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ activityType: "DEPOSIT", comment: "Prepared comment" });
    expect(rows[0].date).toMatch(/^2024-02-02/);
    expect(Number(rows[0].amount)).toBe(75);
  });
}
