import { expect, test, type Locator, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded } from "./helpers";

const api = `${BASE_URL}/api/v1`;

// Up to 1024 px, globals.css hides the overflow of every `.flex` and `.grid`, chart
// containers included. A Recharts tooltip drawn outside such a box was cut off (#2161).
const cases = [
  { width: 390, height: 844, dir: "ltr" },
  { width: 800, height: 900, dir: "ltr" },
  { width: 1024, height: 768, dir: "ltr" },
  { width: 1024, height: 768, dir: "rtl" },
  { width: 1025, height: 768, dir: "ltr" },
] as const;

/** The part of the shown tooltip that an ancestor's overflow or the viewport cuts off. */
async function hiddenTooltipEdges(chart: Locator) {
  return chart.evaluate((element) => {
    const tooltip = [...element.querySelectorAll<HTMLElement>(".recharts-tooltip-wrapper")].find(
      (candidate) => getComputedStyle(candidate).visibility === "visible",
    );
    if (!tooltip) return "no tooltip shown";
    const box = tooltip.getBoundingClientRect();
    const cut: string[] = [];
    const check = (
      name: string,
      clip: { left: number; top: number; right: number; bottom: number },
      x: boolean,
      y: boolean,
    ) => {
      if (x && (box.left < clip.left - 0.5 || box.right > clip.right + 0.5))
        cut.push(`${name} sideways`);
      if (y && (box.top < clip.top - 0.5 || box.bottom > clip.bottom + 0.5))
        cut.push(`${name} vertically`);
    };
    for (let ancestor = tooltip.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      check(
        `${ancestor.tagName.toLowerCase()}.${[...ancestor.classList].slice(0, 3).join(".")}`,
        ancestor.getBoundingClientRect(),
        style.overflowX !== "visible",
        style.overflowY !== "visible",
      );
    }
    check("viewport", { left: 0, top: 0, right: innerWidth, bottom: innerHeight }, true, true);
    return cut;
  });
}

async function hoverUntilTooltip(page: Page, chart: Locator, target: Locator) {
  await expect(async () => {
    const box = await target.boundingBox();
    if (!box) throw new Error("hover target has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
    expect(await hiddenTooltipEdges(chart)).not.toBe("no tooltip shown");
  }).toPass({ timeout: 10_000 });
}

/** The first of these charts that lies within the viewport. */
async function chartOnScreen(page: Page, charts: Locator) {
  let onScreen: Locator | undefined;
  await expect(async () => {
    const width = page.viewportSize()?.width ?? 0;
    for (const chart of await charts.all()) {
      const box = await chart.boundingBox();
      if (box && box.width > 0 && box.x >= 0 && box.x + box.width <= width + 1) {
        onScreen = chart;
        return;
      }
    }
    throw new Error("no chart on screen yet");
  }).toPass({ timeout: 30_000 });
  if (!onScreen) throw new Error("no chart on screen");
  return onScreen;
}

// Soft, so one run reports every chart and width that cuts a tooltip off.
const softExpect = expect.configure({ soft: true });

test("chart tooltips stay whole where flex boxes clip their overflow", async ({ page }) => {
  test.setTimeout(240_000);
  await completeOnboardingIfNeeded(page);
  const runId = Date.now().toString(36);
  const account = await page.request.post(`${api}/accounts`, {
    data: {
      name: `Tooltip ${runId}`,
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(account.ok(), await account.text()).toBeTruthy();
  const accountId = ((await account.json()) as { id: string }).id;
  for (const data of [
    { activityType: "DEPOSIT", activityDate: "2024-01-02T15:00:00Z", amount: 5000 },
    { activityType: "INTEREST", activityDate: "2024-02-01T15:00:00Z", amount: 90 },
  ]) {
    const activity = await page.request.post(`${api}/activities`, {
      data: { accountId, currency: "USD", fee: 0, needsReview: false, ...data },
    });
    expect(activity.ok(), await activity.text()).toBeTruthy();
  }

  for (const { width, height, dir } of cases) {
    await test.step(`${width}×${height} ${dir}`, async () => {
      await page.setViewportSize({ width, height });

      // The account value chart draws its tooltip above the plot on wide screens.
      await page.goto(`${BASE_URL}/accounts/${accountId}?dir=${dir}`);
      const valueChart = page
        .locator("[data-chart]")
        .filter({ has: page.locator(".recharts-area") })
        .first();
      // A cash-only account's value is a flat line, whose box has no height: wait for the plot.
      await expect(valueChart.locator(".recharts-surface").first()).toBeVisible({
        timeout: 30_000,
      });
      await hoverUntilTooltip(page, valueChart, valueChart.locator(".recharts-surface").first());
      // Recharts slides the tooltip into place, so poll until it settles.
      await softExpect
        .poll(() => hiddenTooltipEdges(valueChart), { message: "account value tooltip" })
        .toEqual([]);

      // The net worth chart places its tooltip the same way. A phone keeps the dashboard's
      // other tabs mounted beside it, off screen.
      await page.goto(`${BASE_URL}/dashboard?tab=net-worth&dir=${dir}`);
      const netWorthChart = await chartOnScreen(
        page,
        page.locator("[data-chart]").filter({ has: page.locator(".recharts-area") }),
      );
      await hoverUntilTooltip(
        page,
        netWorthChart,
        netWorthChart.locator(".recharts-surface").first(),
      );
      await softExpect
        .poll(() => hiddenTooltipEdges(netWorthChart), { message: "net worth tooltip" })
        .toEqual([]);

      // The income currency pie is far smaller than its tooltip.
      await page.goto(`${BASE_URL}/insights?tab=income&dir=${dir}`);
      const pie = page
        .locator("[data-chart]")
        .filter({ has: page.locator(".recharts-pie") })
        .first();
      await expect(pie.locator(".recharts-sector").first()).toBeVisible({ timeout: 30_000 });
      await hoverUntilTooltip(page, pie, pie.locator(".recharts-sector").first());
      await softExpect
        .poll(() => hiddenTooltipEdges(pie), { message: "income currency tooltip" })
        .toEqual([]);
    });
  }
});
