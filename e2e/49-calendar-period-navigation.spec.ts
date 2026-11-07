import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

for (const mobile of [false, true]) {
  for (const direction of ["ltr", "rtl"] as const) {
    test(`calendar years and adjacent months stay shared on ${mobile ? "phone" : "desktop"} in ${direction}`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width: mobile ? 393 : 1440, height: 900 });
      await completeOnboardingIfNeeded(page);
      const response = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
        data: {
          name: `Calendar ${mobile}-${direction}`,
          accountType: "CASH",
          currency: "USD",
          isDefault: false,
          isActive: true,
          trackingMode: "TRANSACTIONS",
        },
      });
      expect(response.ok()).toBeTruthy();
      const { id } = await response.json();
      for (const [date, activityType, amount] of [
        ["2019-01-02", "DEPOSIT", 1000],
        ["2024-01-01", "WITHDRAWAL", 25],
        ["2025-06-01", "WITHDRAWAL", 50],
      ] as const) {
        const activity = await page.request.post(`${BASE_URL}/api/v1/activities`, {
          data: {
            accountId: id,
            activityType,
            activityDate: `${date}T15:00:00Z`,
            amount,
            currency: "USD",
            fee: 0,
            needsReview: false,
          },
        });
        expect(activity.ok()).toBeTruthy();
      }
      const oldSettings = await (
        await page.request.get(`${BASE_URL}/api/v1/spending/settings`)
      ).json();
      try {
        expect(
          (
            await page.request.put(`${BASE_URL}/api/v1/spending/settings`, {
              data: { ...oldSettings, enabled: true, accountIds: [id] },
            })
          ).ok(),
        ).toBeTruthy();
        await gotoAppPath(page, `/dashboard?tab=spending&dir=${direction}&spendingYear=2025`);
        const visible = (name: string | RegExp) =>
          page.getByRole("button", { name }).filter({ visible: true });
        // Formatting isolates calendar labels in RTL text.
        const periodButton = (label: string) =>
          visible(new RegExp(`${label}\\u2069?, Select dates`));
        await expect(periodButton("2025")).toBeVisible();
        expect(new URL(page.url()).searchParams.has("spendingYear")).toBe(false);
        await visible("Previous period").click();
        await expect(periodButton("2024")).toBeVisible();
        await page.reload();
        await expect(periodButton("2024")).toBeVisible();
        await visible("Next period").click();
        await expect(periodButton("2025")).toBeVisible();
        await expect(visible("Next period")).toBeDisabled();
        await visible("Previous period").click();
        await expect(periodButton("2024")).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("dir", direction);
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({
          path: testInfo.outputPath("selected-year.png"),
          animations: "disabled",
        });
        await periodButton("2024").click();
        const popup = page.getByRole("dialog");
        const yearButton = (year: number) =>
          popup.getByRole("button", { name: new RegExp(`^\\u2068?${year}\\u2069?$`) });
        await expect(yearButton(2024)).toHaveAttribute("aria-pressed", "true");
        await expect(visible("Previous period")).toHaveCount(0);
        await expect(yearButton(2017)).toBeInViewport({
          ratio: 1,
        });
        await page.screenshot({
          path: testInfo.outputPath("year-picker.png"),
          animations: "disabled",
        });
        await yearButton(2025).click();

        for (const tab of ["investments", "net-worth"]) {
          await gotoAppPath(page, `/dashboard?tab=${tab}&dir=${direction}`);
          await expect(periodButton("2025")).toBeVisible();
          await expect(
            page.getByText("Current value", { exact: true }).filter({ visible: true }).first(),
          ).toBeVisible();
        }
        await visible("Previous period").click();
        await expect(periodButton("2024")).toBeVisible();
        await gotoAppPath(page, `/insights?tab=spending&dir=${direction}`);
        await expect(page.getByTestId("spending-selected-range")).toContainText("2024");

        await gotoAppPath(page, `/dashboard?tab=spending&dir=${direction}`);
        await periodButton("2024").click();
        await popup.getByRole("button", { name: "Month", exact: true }).click();
        await popup.getByRole("button", { name: /February/ }).click();
        await expect(periodButton("February 2024")).toBeVisible();
        await visible("Previous period").click();
        await expect(periodButton("January 2024")).toBeVisible();
        await visible("Previous period").click();
        await expect(periodButton("December 2023")).toBeVisible();
        await visible("Next period").click();
        await expect(periodButton("January 2024")).toBeVisible();
        await visible("YTD").click();
        await expect(visible("Previous period")).toHaveCount(0);
      } finally {
        await page.request.put(`${BASE_URL}/api/v1/spending/settings`, { data: oldSettings });
      }
    });
  }
}
