import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";

for (const dir of ["ltr", "rtl"]) {
  for (const explicit of [false, true]) {
    test(`CSV numeric ${explicit ? "ambiguity and explicit setting" : "column detection"} (${dir})`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await completeOnboardingIfNeeded(page);

      const accountResponse = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
        data: {
          name: `CSV numbers ${dir} ${explicit}`,
          accountType: "CASH",
          currency: "USD",
          isDefault: false,
          isActive: true,
          trackingMode: "TRANSACTIONS",
        },
      });
      expect(accountResponse.ok(), await accountResponse.text()).toBeTruthy();
      const account = (await accountResponse.json()) as { id: string };
      const amounts = explicit ? ["1,500", "2,000"] : ["$1,500", "25.50", "1,234,567"];
      const csv = [
        "date,activityType,amount,currency,comment",
        ...amounts.map(
          (amount, index) => `2024-02-0${index + 1},DEPOSIT,"${amount}",USD,numeric-${index}`,
        ),
      ].join("\n");

      await page.goto(`${BASE_URL}/import?account=${account.id}&dir=${dir}`);
      await expect(page.locator("html")).toHaveAttribute("dir", dir);
      await page.locator('input[type="file"]').setInputFiles({
        name: "number-formats.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(csv),
      });
      await page.getByRole("button", { name: /Configure Mapping/i }).click();
      await page.getByRole("button", { name: /Review Transactions/i }).click();
      const continueToImport = page.getByRole("button", { name: /Continue to Import/i });
      await expect(continueToImport).toBeEnabled({ timeout: 30_000 });

      if (explicit) {
        await expect(page.getByText("Check number formats")).toBeVisible();
        await expect(page.getByText(/ambiguous or conflicting/)).toContainText("Parse Settings");
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await page.getByRole("button", { name: "Back", exact: true }).click();
        await page.getByText("Parse Settings", { exact: true }).click();
        await page.locator("#decimalSeparator").click();
        await page.getByRole("option", { name: "Period (.)", exact: true }).click();
        await page.getByRole("button", { name: /Configure Mapping/i }).click();
        await page.getByRole("button", { name: /Review Transactions/i }).click();
        await expect(continueToImport).toBeEnabled({ timeout: 30_000 });
      }
      await expect(page.getByText("Check number formats")).not.toBeVisible();
      await continueToImport.click();
      await page
        .getByRole("button", { name: new RegExp(`Import ${amounts.length} Activities`, "i") })
        .click();
      await expect(page.getByText("Import Complete")).toBeVisible({ timeout: 30_000 });

      const response = await page.request.post(`${BASE_URL}/api/v1/activities/search`, {
        data: { page: 0, pageSize: 100, accountIdFilter: [account.id] },
      });
      expect(response.ok(), await response.text()).toBeTruthy();
      const body = (await response.json()) as { data: { amount: string; comment: string }[] };
      const persisted = Object.fromEntries(
        body.data.map((row) => [row.comment, Number(row.amount)]),
      );
      expect(persisted).toEqual(
        explicit
          ? { "numeric-0": 1500, "numeric-1": 2000 }
          : { "numeric-0": 1500, "numeric-1": 25.5, "numeric-2": 1234567 },
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
    });
  }
}
