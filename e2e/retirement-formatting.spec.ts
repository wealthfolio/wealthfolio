import { expect, test } from "@playwright/test";
import { BASE_URL, gotoAppPath } from "./helpers";

const plan = {
  version: "v3",
  currency: "USD",
  personal: { currentAge: 34, targetRetirementAge: 55, planningHorizonAge: 90 },
  expenses: {
    items: [{ id: "living", label: "Living", monthlyAmount: 5600, inflationRate: 0.025 }],
  },
  incomeStreams: [],
  investment: {
    preRetirementAnnualReturn: 0.0577,
    retirementAnnualReturn: 0.0337,
    annualInvestmentFeeRate: 0.006,
    annualVolatility: 0.12,
    inflationRate: 0.02,
    monthlyContribution: 4200,
    contributionGrowthRate: 0.02,
  },
};

test("retirement respects Spain's formats and keeps chart labels visible in both directions", async ({
  page,
}) => {
  test.setTimeout(120000);
  const api = `${BASE_URL}/api/v1`;
  const stateResponse = await page.request.post(`${api}/profiles/get_profile_state`, { data: {} });
  expect(stateResponse.ok()).toBeTruthy();
  const state = await stateResponse.json();
  const session =
    state.session ??
    (await (
      await page.request.post(`${api}/profiles/unlock_profile`, {
        data: { profileId: state.profiles[0].id },
      })
    ).json());
  const headers = { "x-wf-profile-scope": session.scopeId };
  const previousSettings = await (await page.request.get(`${api}/settings`, { headers })).json();
  const settings = await page.request.put(`${api}/settings`, {
    headers,
    data: {
      baseCurrency: "USD",
      onboardingCompleted: true,
      language: "en",
      formattingRegion: "ES",
      currencyFormattingRegions: {},
      timezone: "UTC",
      syncEnabled: false,
      autoUpdateCheckEnabled: false,
    },
  });
  expect(settings.ok()).toBeTruthy();
  const created = await page.request.post(`${api}/goals`, {
    headers,
    data: { goalType: "retirement", title: "Spain formatting regression" },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const goal = await created.json();
  try {
    const savedPlan = await page.request.post(`${api}/goals/plan`, {
      headers,
      data: {
        goalId: goal.id,
        planKind: "retirement",
        settingsJson: JSON.stringify(plan),
      },
    });
    expect(savedPlan.ok(), await savedPlan.text()).toBeTruthy();
    for (const dir of ["ltr", "rtl"]) {
      await gotoAppPath(page, `/goals/${goal.id}?dir=${dir}`);
      await expect(page.locator("html")).toHaveAttribute("dir", dir);
      const chart = page.locator(".recharts-wrapper").filter({ visible: true }).first();
      const ticks = chart.locator(".recharts-yAxis-tick-labels text");
      await expect(ticks.first()).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await expect
        .poll(() =>
          ticks.evaluateAll((labels) =>
            labels.every((label) => {
              const svg = label.closest("svg")!.getBoundingClientRect();
              const bounds = label.getBoundingClientRect();
              return bounds.left >= svg.left - 1 && bounds.right <= svg.right + 1;
            }),
          ),
        )
        .toBe(true);
      await expect(ticks.last()).toContainText("US$");
      // How funded the plan is depends on the accounts earlier specs left behind.
      await expect(page.getByText(/\d,\d\s%.*funded/)).toBeVisible();
      await page.getByRole("button", { name: "Edit Projection Assumptions" }).click();
      const rateInput = page.getByRole("textbox", { name: "Return before retirement" });
      await expect(rateInput).toHaveValue(dir === "ltr" ? "5,8" : "5,9");
      await rateInput.click();
      await rateInput.evaluate((element: HTMLInputElement) =>
        element.setSelectionRange(element.value.length - 1, element.value.length),
      );
      await rateInput.pressSequentially(dir === "ltr" ? "9" : "7");
      await rateInput.press("Tab");
      const saving = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.endsWith("/goals/plan"),
      );
      await page.getByRole("button", { name: "Save", exact: true }).first().click();
      const saved = await saving;
      expect(saved.ok()).toBeTruthy();
      const persisted = await (
        await page.request.get(`${api}/goals/${goal.id}/plan`, { headers })
      ).json();
      expect(JSON.parse(persisted.settingsJson).investment.preRetirementAnnualReturn).toBeCloseTo(
        dir === "ltr" ? 0.059 : 0.057,
      );
      await chart.screenshot({ path: test.info().outputPath(`retirement-${dir}.png`) });
    }
  } finally {
    await page.request.delete(`${api}/goals/${goal.id}`, { headers });
    await page.request.put(`${api}/settings`, { headers, data: previousSettings });
  }
});
