import { expect, test } from "@playwright/test";
import { BASE_URL, gotoAppPath } from "./helpers";

for (const mobile of [false, true]) {
  for (const direction of ["ltr", "rtl"] as const) {
    test(`calendar years and adjacent months stay shared on ${mobile ? "phone" : "desktop"} in ${direction}`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      page.setDefaultTimeout(15_000);
      await page.setViewportSize({ width: mobile ? 393 : 1440, height: 900 });
      await page.clock.setFixedTime(new Date("2026-09-15T12:00:00Z"));
      const profileState = await (
        await page.request.post(`${BASE_URL}/api/v1/profiles/get_profile_state`, { data: {} })
      ).json();
      const session =
        profileState.session ??
        (await (
          await page.request.post(`${BASE_URL}/api/v1/profiles/unlock_profile`, {
            data: { profileId: profileState.profiles[0].id },
          })
        ).json());
      const headers = { "x-wf-profile-scope": session.scopeId };
      const originalSettings = await (
        await page.request.get(`${BASE_URL}/api/v1/settings`, { headers })
      ).json();
      const oldSettings = await (
        await page.request.get(`${BASE_URL}/api/v1/spending/settings`, { headers })
      ).json();
      let createdAccountId: string | undefined;
      try {
        expect(
          (
            await page.request.put(`${BASE_URL}/api/v1/settings`, {
              headers,
              data: {
                onboardingCompleted: true,
                language: "en",
                timezone: "UTC",
                baseCurrency: "USD",
                autoUpdateCheckEnabled: false,
              },
            })
          ).ok(),
        ).toBeTruthy();
        const response = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
          headers,
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
        createdAccountId = id;
        for (const [date, activityType, amount] of [
          ["2019-01-02", "DEPOSIT", 1000],
          ["2024-01-01", "WITHDRAWAL", 25],
          ["2025-06-01", "WITHDRAWAL", 50],
        ] as const) {
          const activity = await page.request.post(`${BASE_URL}/api/v1/activities`, {
            headers,
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
        expect(
          (
            await page.request.put(`${BASE_URL}/api/v1/spending/settings`, {
              headers,
              data: { ...oldSettings, enabled: true, accountIds: [id] },
            })
          ).ok(),
        ).toBeTruthy();
        const reportRequests: { startDate: string; endDate: string }[] = [];
        const insightRequests: { startDate: string; endDate: string }[] = [];
        page.on("request", (request) => {
          if (new URL(request.url()).pathname === "/api/v1/spending/report") {
            reportRequests.push(request.postDataJSON());
          }
          if (new URL(request.url()).pathname === "/api/v1/spending/insight") {
            insightRequests.push(request.postDataJSON());
          }
        });
        await gotoAppPath(page, `/dashboard?tab=spending&dir=${direction}&spendingYear=2025`);
        const visible = (name: string | RegExp) =>
          page
            .getByRole("button", { name, exact: typeof name === "string" })
            .filter({ visible: true });
        // Formatting isolates calendar labels in RTL text.
        const periodButton = (label: string) =>
          visible(new RegExp(`${label}\\u2069?, Select dates`));
        // Mobile keeps neighboring tabs mounted with the same period labels.
        const spendingPane = page
          .locator("[data-virtual-scroll-parent]")
          .filter({ has: page.getByText(/^Spent ·/) })
          .last();
        const spendingPeriodButton = (label: string) =>
          spendingPane.getByRole("button", { name: new RegExp(`${label}\\u2069?, Select dates`) });
        await expect(periodButton("2025")).toBeVisible();
        await expect
          .poll(() => reportRequests)
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                startDate: "2025-01-01T00:00:00.000Z",
                endDate: "2025-12-31T23:59:59.999Z",
              }),
              expect.objectContaining({
                startDate: "2024-01-01T00:00:00.000Z",
                endDate: "2024-12-31T23:59:59.999Z",
              }),
            ]),
          );
        await expect(
          page
            .getByRole("application")
            .locator(".recharts-xAxis-tick-labels")
            .getByText("Jun '25", { exact: true })
            .filter({ visible: true }),
        ).toBeVisible();
        expect(new URL(page.url()).searchParams.has("spendingYear")).toBe(false);
        const dashboardMenu = visible("More options").and(page.locator('[aria-haspopup="dialog"]'));
        await dashboardMenu.click();
        const compareAction = page.getByRole("button", { name: "Compare to prior period" });
        await expect(compareAction).toHaveAttribute("aria-pressed", "false");
        await compareAction.click();
        await expect(spendingPane.locator(".recharts-bar")).toHaveCount(2);
        const priorBar = spendingPane
          .locator(".recharts-bar")
          .nth(1)
          .locator(".recharts-rectangle")
          .first();
        await priorBar.hover();
        await expect(spendingPane.locator(".recharts-tooltip-wrapper")).toContainText("2024");
        await page.screenshot({
          path: testInfo.outputPath("comparison-chart.png"),
          animations: "disabled",
        });
        await dashboardMenu.click();
        await expect(compareAction).toHaveAttribute("aria-pressed", "true");
        await compareAction.click();
        await expect(spendingPane.locator(".recharts-bar")).toHaveCount(1);
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
        await spendingPeriodButton("2024").click();
        const popup = page.getByRole("dialog");
        const yearButton = (year: number) =>
          popup.getByRole("button", { name: new RegExp(`^\\u2068?${year}\\u2069?$`) });
        await expect(yearButton(2024)).toHaveAttribute("aria-pressed", "true");
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
        const insightsHeader = page.getByTestId("spending-period-header");
        const previousInsight = insightsHeader.getByRole("button", { name: "Previous period" });
        const nextInsight = insightsHeader.getByRole("button", { name: "Next period" });
        await expect(visible("Last month")).toHaveCount(0);
        await expect(
          page.getByRole("button", { name: "Prev", exact: true }).filter({ visible: true }),
        ).toHaveCount(0);
        await previousInsight.click();
        await expect(page.getByTestId("spending-selected-range")).toContainText("2023");
        await nextInsight.click();
        await expect(page.getByTestId("spending-selected-range")).toContainText("2024");
        await visible("6M").click();
        await expect(nextInsight).toBeDisabled();
        const arrowBox = await previousInsight.boundingBox();
        expect(arrowBox).not.toBeNull();
        if (mobile) {
          expect(arrowBox!.width).toBeGreaterThanOrEqual(44);
          expect(arrowBox!.height).toBeGreaterThanOrEqual(44);
        }
        await previousInsight.click();
        await expect(visible("6M")).toHaveAttribute("aria-pressed", "true");
        await expect
          .poll(() => insightRequests)
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                startDate: "2025-10-01T00:00:00.000Z",
                endDate: "2026-03-31T23:59:59.999Z",
              }),
            ]),
          );
        await page.reload();
        await expect(nextInsight).toBeEnabled();
        await expect(visible("6M")).toHaveAttribute("aria-pressed", "true");
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.screenshot({
          path: testInfo.outputPath("insights-period-navigation.png"),
          animations: "disabled",
        });
        await gotoAppPath(page, `/dashboard?tab=spending&dir=${direction}`);
        await expect(visible("6M")).toHaveAttribute("aria-pressed", "true");
        await expect
          .poll(() => reportRequests)
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                startDate: "2025-10-01T00:00:00.000Z",
                endDate: "2026-03-31T23:59:59.999Z",
              }),
            ]),
          );
        await gotoAppPath(page, `/insights?tab=spending&dir=${direction}`);
        await expect(nextInsight).toBeEnabled();
        await nextInsight.click();
        await expect(nextInsight).toBeDisabled();
        await visible(mobile ? "MTD" : "This month").click();
        await expect
          .poll(() => insightRequests)
          .toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                startDate: "2026-09-01T00:00:00.000Z",
                endDate: "2026-09-30T23:59:59.999Z",
                compareStartDate: "2026-08-01T00:00:00.000Z",
                compareEndDate: "2026-08-31T23:59:59.999Z",
              }),
            ]),
          );
        await previousInsight.click();
        await expect(page.getByTestId("spending-selected-range")).toContainText("August 2026");
        await nextInsight.click();
        await expect(visible(mobile ? "MTD" : "This month")).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        await expect(nextInsight).toBeDisabled();

        // Restore the calendar year before continuing the dashboard picker flow.
        await gotoAppPath(page, `/dashboard?tab=spending&dir=${direction}&spendingYear=2024`);
        await spendingPeriodButton("2024").click();
        await expect(popup).toBeVisible();
        await popup.getByRole("button", { name: "Month", exact: true }).click();
        await expect(
          popup.locator('[data-slot="month-year-picker"]').getByRole("button", { pressed: true }),
        ).toHaveCount(0);
        await popup.getByRole("button", { name: /February/ }).click();
        await expect(periodButton("February 2024")).toBeVisible();
        await visible("Previous period").click();
        await expect(periodButton("January 2024")).toBeVisible();
        await visible("Previous period").click();
        await expect(periodButton("December 2023")).toBeVisible();
        await visible("Next period").click();
        await expect(periodButton("January 2024")).toBeVisible();
        await visible("YTD").click();
        await expect(visible("Previous period")).toBeEnabled();
        await expect(visible("Next period")).toBeDisabled();
        await expect(visible("Last month")).toHaveCount(0);

        for (const [code, from, to] of [
          ["1W", "2026-09-02", "2026-09-08"],
          ["3M", "2026-03-15", "2026-06-15"],
          ["6M", "2025-09-15", "2026-03-15"],
          ["YTD", "2025-01-01", "2025-09-15"],
          ["1Y", "2024-09-15", "2025-09-15"],
        ]) {
          await visible(code).click();
          await expect(visible("Previous period")).toBeEnabled();
          const headline = await spendingPane.getByText(/^Spent ·/).boundingBox();
          const arrow = await visible("Previous period").boundingBox();
          expect(headline).not.toBeNull();
          expect(arrow).not.toBeNull();
          if (mobile) {
            expect(arrow!.width).toBeGreaterThanOrEqual(44);
            expect(arrow!.height).toBeGreaterThanOrEqual(44);
          }
          expect(
            Math.abs(arrow!.y + arrow!.height / 2 - headline!.y - headline!.height / 2),
          ).toBeLessThan(3);
          if (code === "6M")
            await page.screenshot({
              path: testInfo.outputPath("header-6m-navigation.png"),
              animations: "disabled",
            });
          await visible("Previous period").click();
          await expect
            .poll(() => reportRequests)
            .toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  startDate: `${from}T00:00:00.000Z`,
                  endDate: `${to}T23:59:59.999Z`,
                }),
              ]),
            );
          await expect(visible(code)).toHaveAttribute("aria-pressed", "true");
          await expect(visible("Next period")).toBeEnabled();
          if (code === "6M") {
            await page.reload();
            await expect(visible("Next period")).toBeEnabled();
            await expect(visible(code)).toHaveAttribute("aria-pressed", "true");
            await page.screenshot({
              path: testInfo.outputPath("header-6m-previous-window.png"),
              animations: "disabled",
            });
          }
          await visible("Next period").click();
          await expect(visible("Next period")).toBeDisabled();
          await expect(visible(code)).toHaveAttribute("aria-pressed", "true");
        }

        await visible(mobile ? "MTD" : "This month").click();
        await visible("Previous period").click();
        await expect(periodButton("August 2026")).toBeVisible();
        await visible("Next period").click();
        await expect(visible(mobile ? "MTD" : "This month")).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        await expect(visible("Next period")).toBeDisabled();

        for (const tab of ["investments", "net-worth"]) {
          await gotoAppPath(page, `/dashboard?tab=${tab}&dir=${direction}`);
          await visible("1M").click();
          await expect(visible("Previous period")).toBeEnabled();
          const header = visible("Previous period").locator(
            "xpath=ancestor::*[@data-testid='dashboard-period-header']",
          );
          await expect(header.getByTestId("dashboard-period-caption")).toContainText(
            tab === "investments" ? "Investments" : "Net Worth",
          );
          const balance = header.locator("..").getByRole("heading", { level: 1 });
          await expect(balance).toBeVisible();
          const headerBox = await header.boundingBox();
          const balanceBox = await balance.boundingBox();
          expect(headerBox).not.toBeNull();
          expect(balanceBox).not.toBeNull();
          expect(headerBox!.y + headerBox!.height).toBeLessThanOrEqual(balanceBox!.y + 1);
          expect(
            await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
          ).toBe(true);
          await page.screenshot({
            path: testInfo.outputPath(`${tab}-matching-header.png`),
            animations: "disabled",
          });
          await visible("Previous period").click();
          await expect(visible("1M")).toHaveAttribute("aria-pressed", "true");
          await expect(visible("Next period")).toBeEnabled();
          await visible("Next period").click();
          await expect(visible("Next period")).toBeDisabled();
          await expect(visible("1M")).toHaveAttribute("aria-pressed", "true");
        }

        await gotoAppPath(page, `/dashboard?tab=investments&dir=${direction}`);
        await visible("ALL").click();
        await expect(visible("ALL")).toHaveAttribute("aria-pressed", "true");
        for (const year of ["2026", "invalid"]) {
          await gotoAppPath(page, `/dashboard?tab=spending&dir=${direction}&spendingYear=${year}`);
          await expect(page).not.toHaveURL(/spendingYear/);
          await gotoAppPath(page, `/dashboard?tab=investments&dir=${direction}`);
          await expect(visible("ALL")).toHaveAttribute("aria-pressed", "true");
        }
      } finally {
        await page.request.put(`${BASE_URL}/api/v1/settings`, {
          headers,
          data: originalSettings,
        });
        await page.request.put(`${BASE_URL}/api/v1/spending/settings`, {
          headers,
          data: oldSettings,
        });
        if (createdAccountId) {
          expect(
            (
              await page.request.delete(`${BASE_URL}/api/v1/accounts/${createdAccountId}`, {
                headers,
              })
            ).ok(),
          ).toBeTruthy();
        }
      }
    });
  }
}
