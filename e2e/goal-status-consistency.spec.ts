import { expect, test } from "@playwright/test";
import { BASE_URL, gotoAppPath } from "./helpers";

test("saved goal health reaches a mounted list and agrees with detail in both directions", async ({
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
  const settings = await page.request.put(`${api}/settings`, {
    headers,
    data: {
      onboardingCompleted: true,
      language: "en",
      timezone: "UTC",
      syncEnabled: false,
      autoUpdateCheckEnabled: false,
    },
  });
  expect(settings.ok()).toBeTruthy();
  await gotoAppPath(page, "/goals");
  const created = await page.request.post(`${api}/goals`, {
    headers,
    data: {
      goalType: "custom_save_up",
      title: "Status regression",
      targetAmount: 10000,
      targetDate: "2030-12-31",
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const goal = await created.json();
  const plan = (monthlyContribution: number) =>
    page.request.post(`${api}/goals/plan`, {
      headers,
      data: {
        goalId: goal.id,
        planKind: "save_up",
        settingsJson: JSON.stringify({ monthlyContribution, expectedAnnualReturn: 0 }),
      },
    });
  try {
    expect((await plan(10000)).ok()).toBeTruthy();
    await page.reload();
    const card = page
      .getByRole("link")
      .filter({ has: page.getByRole("heading", { name: goal.title, exact: true }) });
    await expect(card).toBeVisible();
    await expect(card.getByText("Off track", { exact: true })).toHaveCount(0);
    // Another client changes the plan. The SSE event must update this mounted list.
    expect((await plan(0)).ok()).toBeTruthy();
    await expect(card.getByText("Off track", { exact: true })).toBeVisible();
    for (const dir of ["ltr", "rtl"]) {
      await gotoAppPath(page, `/goals/${goal.id}?dir=${dir}`);
      await expect(page.getByText("Off track", { exact: true }).first()).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("dir", dir);
    }
    const overview = await page.request.get(`${api}/goals/${goal.id}/save-up/overview`, {
      headers,
    });
    const saved = await page.request.get(`${api}/goals/${goal.id}`, { headers });
    expect((await saved.json()).statusHealth).toBe((await overview.json()).health);
    const current = await (await page.request.get(`${api}/goals/${goal.id}`, { headers })).json();
    const { targetDate, ...withoutDeadline } = current;
    const preserved = await page.request.put(`${api}/goals`, { headers, data: withoutDeadline });
    expect(preserved.ok()).toBeTruthy();
    expect((await preserved.json()).targetDate).toBe(targetDate);
    const cleared = await page.request.put(`${api}/goals`, {
      headers,
      data: { ...current, targetDate: null },
    });
    expect(cleared.ok()).toBeTruthy();
    expect(await cleared.json()).toMatchObject({
      targetDate: null,
      statusHealth: "not_applicable",
    });
  } finally {
    await page.request.delete(`${api}/goals/${goal.id}`, { headers });
  }
});
