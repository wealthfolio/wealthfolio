import { expect, test, type Locator, type Page } from "@playwright/test";
import { BASE_URL } from "./helpers";

let requestHeaders: Record<string, string> = {};

async function post<T>(page: Page, path: string, data?: unknown): Promise<T> {
  const response = await page.request.post(`${BASE_URL}/api/v1${path}`, {
    data,
    headers: requestHeaders,
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return response.json() as Promise<T>;
}

let profileToDelete: { id: string; name: string } | null = null;

// While a second profile exists, the server refuses requests that name no profile,
// so the specs that run after this one would fail. Delete it even when the test fails.
test.afterEach(async ({ page }) => {
  if (!profileToDelete) return;
  await post(page, "/profiles/delete_profile", {
    profileId: profileToDelete.id,
    confirmation: profileToDelete.name,
  });
  profileToDelete = null;
});

async function enterAmount(field: Locator, value: string) {
  await field.focus();
  await field.press("ControlOrMeta+A");
  await field.press("Backspace");
  await field.pressSequentially(value);
}

test("whole-share edits update impact and require account placement, in LTR and RTL", async ({
  page,
}) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  // Give this spec its own profile so other specs' accounts and targets cannot leak in.
  const profileName = "Worksheet preview";
  const profile = await post<{ id: string }>(page, "/profiles/create_profile", {
    name: profileName,
    avatarId: "clay-bot-animated",
  });
  profileToDelete = { id: profile.id, name: profileName };
  const session = await post<{ scopeId: string }>(page, "/profiles/unlock_profile", {
    profileId: profile.id,
  });
  requestHeaders = { "x-wf-profile-scope": session.scopeId };
  const settings = await page.request.put(`${BASE_URL}/api/v1/settings`, {
    headers: requestHeaders,
    data: { onboardingCompleted: true, language: "en", timezone: "UTC", baseCurrency: "USD" },
  });
  expect(settings.ok(), await settings.text()).toBe(true);

  let assetId = "";
  const assetIds = new Set<string>();
  for (const name of ["Preview brokerage", "Preview retirement"]) {
    const account = await post<{ id: string }>(page, "/accounts", {
      name,
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      isArchived: false,
      trackingMode: "TRANSACTIONS",
    });
    await post(page, "/activities", {
      id: `${account.id}-deposit`,
      accountId: account.id,
      activityType: "DEPOSIT",
      activityDate: "2026-05-10T10:00:00.000Z",
      amount: 10000,
      currency: "USD",
    });
    for (const symbol of ["AAPL", "MSFT"]) {
      const buy = await post<{ assetId: string }>(page, "/activities", {
        id: `${account.id}-${symbol}-buy`,
        accountId: account.id,
        activityType: "BUY",
        activityDate: "2026-05-11T10:00:00.000Z",
        asset: {
          symbol,
          quoteMode: "MARKET",
          quoteCcy: "USD",
          instrumentType: "EQUITY",
          exchangeMic: "XNAS",
        },
        quantity: 10,
        unitPrice: 100,
        amount: 1000,
        currency: "USD",
        fee: 0,
        tax: 0,
      });
      if (symbol === "AAPL") assetId = buy.assetId;
      assetIds.add(buy.assetId);
    }
  }
  for (const classifiedAssetId of assetIds) {
    const assignment = await page.request.put(
      `${BASE_URL}/api/v1/taxonomies/assignments/asset/${classifiedAssetId}/taxonomy/asset_classes`,
      {
        headers: requestHeaders,
        data: [
          {
            assetId: classifiedAssetId,
            taxonomyId: "asset_classes",
            categoryId: "EQUITY",
            weight: 10000,
            source: "manual",
          },
        ],
      },
    );
    expect(assignment.ok(), await assignment.text()).toBe(true);
  }
  const saved = await post<{ target: { id: string } }>(
    page,
    "/allocation-targets/save-with-weights",
    {
      input: {
        name: "Live preview",
        scopeType: "all",
        scopeId: null,
        taxonomyId: "asset_classes",
        triggerType: "manual",
        driftBandBps: 500,
        bandType: "absolute",
        relativeFactorBps: 2000,
        rebalanceGoal: "exact_target",
        minTradeAmount: "0",
        wholeSharesOnly: true,
        allowSells: true,
        maxTurnoverBps: null,
      },
      weights: [
        { categoryId: "EQUITY", targetBps: 8000, isLocked: false, isRequired: true },
        { categoryId: "CASH", targetBps: 2000, isLocked: false, isRequired: true },
      ],
    },
  );
  const recalculate = await page.request.post(`${BASE_URL}/api/v1/portfolio/recalculate`, {
    headers: requestHeaders,
  });
  expect(recalculate.status()).toBe(202);
  await expect
    .poll(
      async () => {
        const drift = await post<{ rows: { categoryId: string; currentBps: number }[] }>(
          page,
          `/allocation-targets/${saved.target.id}/drift`,
          { filter: { type: "all" }, includeHoldings: true },
        );
        return drift.rows.find((row) => row.categoryId === "EQUITY")?.currentBps ?? 0;
      },
      { timeout: 60000 },
    )
    .toBeGreaterThan(0);

  for (const dir of ["ltr", "rtl"]) {
    await page.goto(`${BASE_URL}/insights?dir=${dir}`);
    await page.evaluate(() => {
      for (const key of Object.keys(localStorage)) {
        if (key.includes("rebalancing-worksheet")) localStorage.removeItem(key);
      }
    });
    await page.reload();
    await page.getByRole("button", { name: /^Details/ }).click();
    await page.getByRole("button", { name: "Open rebalancing" }).click();
    const disclosure = page.getByRole("alertdialog");
    await expect(disclosure).toBeVisible();
    await disclosure.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("Across all 2 accounts", { exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: "Rebalance", exact: true }).click();
    // Every mark on Setup's percentage bars uses the same logical origin.
    const gapBars = await page.locator("[data-gap-category]").evaluateAll((rows) =>
      rows.map((row) => {
        const track = row.querySelector<HTMLElement>(":scope > span[aria-hidden]")!;
        const marks = [...track.children] as HTMLElement[];
        const bounds = track.getBoundingClientRect();
        const marker = marks[marks.length - 1].getBoundingClientRect();
        const current = marks[marks.length - 2].getBoundingClientRect();
        const rtl = getComputedStyle(track).direction === "rtl";
        return {
          width: bounds.width,
          markerOffset: rtl ? bounds.right - marker.right : marker.left - bounds.left,
          fillOffset: rtl ? bounds.right - current.right : current.left - bounds.left,
          target: Number.parseFloat(
            marks[marks.length - 1].style.insetInlineStart.match(/[\d.]+/)?.[0] ?? "NaN",
          ),
        };
      }),
    );
    expect(gapBars.length).toBeGreaterThan(0);
    for (const bar of gapBars) {
      expect(bar.fillOffset).toBeCloseTo(0, 0);
      expect(bar.markerOffset).toBeCloseTo((bar.width * bar.target) / 100 - 1, 0);
    }
    await page.getByRole("button", { name: "Next: Adjust positions" }).click();
    const heading = page.getByRole("heading", { name: "Rebalancing worksheet", exact: true });
    const steps = page.getByRole("navigation", { name: "Rebalancing worksheet" });
    const header = page.locator("[data-worksheet-header]");
    await expect(header).toContainText("Back to overview");
    const titleBounds = await heading.boundingBox();
    const stepBounds = await steps.boundingBox();
    expect(titleBounds).not.toBeNull();
    expect(stepBounds).not.toBeNull();
    expect(
      Math.abs(titleBounds!.y + titleBounds!.height / 2 - (stepBounds!.y + stepBounds!.height / 2)),
    ).toBeLessThan(2);
    if (dir === "ltr") expect(stepBounds!.x).toBeGreaterThan(titleBounds!.x + titleBounds!.width);
    else expect(stepBounds!.x + stepBounds!.width).toBeLessThan(titleBounds!.x);
    const titleToStepsGap =
      dir === "ltr"
        ? stepBounds!.x - titleBounds!.x - titleBounds!.width
        : titleBounds!.x - stepBounds!.x - stepBounds!.width;
    expect(titleToStepsGap).toBeLessThanOrEqual(32);
    await expect(header).not.toContainText(/Target measured|Planning currency|Across all/);
    const activeStep = steps.locator('[aria-current="step"]');
    await expect(activeStep).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(activeStep).toHaveCSS("border-bottom-width", "0px");
    const amount = page.getByLabel("Adjustment for AAPL", { exact: true });
    const row = page.locator(`#worksheet-position-${assetId}`);
    await expect(amount).toBeVisible();
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await expect(
      page.getByRole("menuitem", { name: "Reset to calculated adjustments" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    const calculationDetails = page.locator("[data-calculation-details]");
    await expect(calculationDetails).toBeVisible();
    await expect(calculationDetails).not.toHaveAttribute("open");
    await calculationDetails.locator("summary").click();
    await expect(calculationDetails).toHaveAttribute("open");
    await calculationDetails.locator("summary").click();
    await expect(row.locator("[data-position-details]")).toHaveCount(0);
    const positionDetails = row.getByRole("button", { name: "Details for AAPL", exact: true });
    await positionDetails.click();
    await expect(row.locator("[data-position-details]")).toBeVisible();
    await positionDetails.click();
    await expect(row.locator("[data-position-details]")).toHaveCount(0);
    await amount.focus();
    await expect(amount).toHaveValue(/^-?\d+\.\d{2}$/);
    await expect(page.getByText("Estimated impact: account allocation incomplete")).toBeVisible();
    const rail = page.locator('[data-impact-class="EQUITY"]');
    const current = rail.locator("[data-current-marker]");
    const projected = rail.locator("[data-projected-marker]");
    await expect(current).toBeVisible();
    await expect(projected).toBeVisible();
    const impact = page.locator("[data-impact-rail]");
    await expect(impact.locator("[data-track-legend]")).toHaveText(/Current → Projected \/ Target/);
    await expect(impact.locator("[data-impact-summary]")).not.toContainText("→");
    await expect(impact.getByText(/Largest difference| adjusted$/)).toHaveCount(0);
    await impact.locator("[data-impact-summary]").click();
    await expect(impact.getByText("Net change", { exact: true })).toHaveCount(0);
    const restingBounds = await rail.boundingBox();
    await rail.hover();
    await expect(rail.getByText("Net change", { exact: true })).toBeVisible();
    const activeBounds = await rail.boundingBox();
    expect(activeBounds!.height).toBeCloseTo(restingBounds!.height, 1);
    await amount.focus();
    const before = await projected.getAttribute("style");
    const original = Number((await amount.inputValue()).replaceAll(",", ""));
    const nextAmount = (original + 1000).toFixed(2);
    await enterAmount(amount, nextAmount);
    await expect.poll(() => projected.getAttribute("style")).not.toBe(before);
    await expect(amount).toHaveValue(nextAmount);
    await expect(page.locator("html")).toHaveAttribute("dir", dir);
    await page.screenshot({ path: `test-results/worksheet-preview-${dir}.png`, fullPage: true });
    await page.setViewportSize({ width: 1024, height: 768 });
    const expandSidebar = page.getByRole("button", { name: "Expand Sidebar", exact: true });
    await expandSidebar.click();
    await expect(page.getByRole("button", { name: "Collapse Sidebar", exact: true })).toBeVisible();
    await expect
      .poll(async () => {
        const navBounds = await steps.boundingBox();
        const headingBounds = await heading.boundingBox();
        return Boolean(
          navBounds && headingBounds && navBounds.y >= headingBounds.y + headingBounds.height,
        );
      })
      .toBe(true);
    await page.screenshot({
      path: `test-results/worksheet-header-narrow-${dir}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Collapse Sidebar", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole("button", { name: "Next: Review" }).click();
    await expect(page.getByRole("button", { name: "Export CSV" })).toBeDisabled();

    await page.getByRole("button", { name: "Previous: Adjust positions" }).click();
    // $1 of a $50 change buys no whole AAPL share. This used to count as placed.
    await enterAmount(amount, "50");
    await row.getByRole("button", { name: "Choose accounts" }).click();
    await enterAmount(row.getByLabel("Amount for Preview brokerage", { exact: true }), "1");
    await expect(row.getByRole("button", { name: "Choose accounts" })).toBeVisible();
    await expect(page.getByText("Estimated impact: account allocation incomplete")).toBeVisible();
    await page.getByRole("button", { name: "Next: Review" }).click();
    await expect(page.getByRole("button", { name: "Export CSV" })).toBeDisabled();

    await page.getByRole("button", { name: "Previous: Adjust positions" }).click();
    await amount.click();
    await row.getByRole("button", { name: "Reduce to zero" }).click();
    const otherAmount = page.getByLabel("Adjustment for MSFT", { exact: true });
    const otherNext = (Number((await otherAmount.inputValue()).replaceAll(",", "")) + 1000).toFixed(
      2,
    );
    const response = page.waitForResponse((result) => {
      if (!result.url().endsWith("/allocation-targets/worksheet/calculate")) return false;
      const request = result.request().postDataJSON() as {
        lines: { assetId: string; inputMode: string; value: number }[];
      };
      return (
        request.lines.some(
          (line) => line.assetId === assetId && line.inputMode === "quantity" && line.value === 20,
        ) &&
        request.lines.some((line) => line.assetId !== assetId && line.value === Number(otherNext))
      );
    });
    const beforeMixed = await projected.getAttribute("style");
    await enterAmount(otherAmount, otherNext);
    expect((await response).ok()).toBe(true);
    await expect.poll(() => projected.getAttribute("style")).not.toBe(beforeMixed);
    await page.setViewportSize({ width: 390, height: 844 });
    // Start the phone layout fresh; resizing the swipe shell retains its native horizontal scroll.
    await page.reload();
    await page.getByRole("button", { name: /^Details/ }).click();
    await page.getByRole("button", { name: "Open rebalancing" }).click();
    await page
      .getByRole("navigation", { name: "Rebalancing worksheet" })
      .getByRole("button", { name: /Adjust positions/ })
      .click();
    await expect(amount).toBeVisible();
    const mobileTitleBounds = await heading.boundingBox();
    const mobileStepBounds = await steps.boundingBox();
    expect(mobileTitleBounds).not.toBeNull();
    expect(mobileStepBounds).not.toBeNull();
    expect(mobileStepBounds!.y).toBeGreaterThanOrEqual(
      mobileTitleBounds!.y + mobileTitleBounds!.height,
    );
    await expect
      .poll(async () => {
        const bounds = await steps.boundingBox();
        return bounds ? Math.max(0, -bounds.x, bounds.x + bounds.width - 390) : Infinity;
      })
      .toBe(0);
    await positionDetails.click();
    await expect(row.locator("[data-position-details]")).toBeVisible();
    const inputBounds = await amount.boundingBox();
    expect(inputBounds).not.toBeNull();
    expect(inputBounds!.x).toBeGreaterThanOrEqual(0);
    expect(inputBounds!.x + inputBounds!.width).toBeLessThanOrEqual(390);
    await page.screenshot({
      path: `test-results/worksheet-table-mobile-${dir}.png`,
      fullPage: true,
    });
    await positionDetails.click();
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});
