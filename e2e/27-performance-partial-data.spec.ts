import { expect, test } from "./fixtures";
import { BASE_URL } from "./helpers";

test("partial P&L keeps its subtotal and explains the gap on desktop/mobile in LTR/RTL", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const stateResponse = await page.request.post(`${BASE_URL}/api/v1/profiles/get_profile_state`, {
    data: {},
  });
  expect(stateResponse.ok()).toBeTruthy();
  const state = await stateResponse.json();
  let session = state.session;
  if (!session) {
    const unlock = await page.request.post(`${BASE_URL}/api/v1/profiles/unlock_profile`, {
      data: { profileId: state.profiles[0].id },
    });
    expect(unlock.ok()).toBeTruthy();
    session = await unlock.json();
  }
  const headers = { "x-wf-profile-scope": session.scopeId };
  const settings = await page.request.put(`${BASE_URL}/api/v1/settings`, {
    headers,
    data: { onboardingCompleted: true, language: "en", timezone: "UTC", baseCurrency: "USD" },
  });
  expect(settings.ok()).toBeTruthy();

  const accountIds: string[] = [];
  for (const name of ["Partial P&L sender", "Partial P&L receiver"]) {
    const account = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
      headers,
      data: {
        name,
        accountType: "SECURITIES",
        currency: "USD",
        isDefault: false,
        isActive: true,
        isArchived: false,
        trackingMode: "TRANSACTIONS",
      },
    });
    expect(account.ok(), await account.text()).toBeTruthy();
    accountIds.push((await account.json()).id);
  }

  // The selected window cuts an internal transfer between its two dated legs.
  // Its missing principal must remain an explained residual, never FX or P&L.
  const group = `partial-pnl-${Date.now()}`;
  for (const [accountId, activityType, amount, day] of [
    [accountIds[0], "DEPOSIT", "1000", "01"],
    [accountIds[1], "DEPOSIT", "1", "01"],
    [accountIds[0], "TRANSFER_OUT", "100", "10"],
    [accountIds[1], "TRANSFER_IN", "100", "11"],
  ]) {
    const activity = await page.request.post(`${BASE_URL}/api/v1/activities`, {
      headers,
      data: {
        accountId,
        activityType,
        amount,
        activityDate: `2026-05-${day}T12:00:00Z`,
        currency: "USD",
        ...(activityType.startsWith("TRANSFER") && {
          sourceGroupId: group,
          metadata: JSON.stringify({ flow: { is_external: false } }),
        }),
      },
    });
    expect(activity.ok(), await activity.text()).toBeTruthy();
  }
  const recalculate = await page.request.post(`${BASE_URL}/api/v1/portfolio/recalculate`, {
    headers,
  });
  expect(recalculate.status()).toBe(202);

  const filter = { type: "accounts", accountIds };
  await expect
    .poll(
      async () => {
        const result = await page.request.post(`${BASE_URL}/api/v1/performance/history`, {
          headers,
          data: {
            itemType: "account",
            itemId: "partial-test",
            filter,
            startDate: "2026-05-01",
            endDate: "2026-05-10",
          },
        });
        if (!result.ok()) return null;
        const data = await result.json();
        return { amount: data.summary?.amount, quality: data.summary?.quality };
      },
      { timeout: 90_000 },
    )
    .toEqual({ amount: 0, quality: "partial" });

  await page.goto(BASE_URL);
  await expect(page.locator(".app-shell").first()).toBeVisible({ timeout: 30_000 });
  // Seed only normal UI preferences; all financial data above uses the real API.
  await page.evaluate(
    ({ profileId, accountIds }) => {
      const key = (name: string) => `profile:${profileId}:${name}`;
      const id = `accounts:${[...accountIds].sort().join(",")}`;
      localStorage.setItem(
        key("performance:selectedItems"),
        JSON.stringify([
          {
            id,
            type: "account",
            name: "Partial P&L",
            accountScope: { type: "accounts", accountIds },
          },
        ]),
      );
      localStorage.setItem(key("performance:selectedItemId"), JSON.stringify(id));
      localStorage.setItem(
        key("performance:dateRange"),
        JSON.stringify({ from: new Date(2026, 4, 1), to: new Date(2026, 4, 10) }),
      );
    },
    { profileId: session.profileId, accountIds },
  );

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const dir of ["ltr", "rtl"]) {
      await page.goto(`${BASE_URL}/performance?dir=${dir}`);
      await expect(page.locator("html")).toHaveAttribute("dir", dir);
      const trigger = page.getByRole("button", { name: /Partial data/i });
      await expect(trigger).toBeVisible({ timeout: 30_000 });
      await expect(trigger).toContainText("0.00");
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByText("Partial data", { exact: true })).toBeVisible();
      await expect(dialog.getByRole("note", { name: "Partial data" })).toContainText(
        /attribution.*(?:incomplete|differ|reconcile)/i,
      );
      await expect(dialog.getByRole("note", { name: "Partial data" })).toBeVisible();
      await expect
        .poll(async () => {
          const box = await dialog.boundingBox();
          return (
            box !== null &&
            box.x >= -1 &&
            box.y >= -1 &&
            box.x + box.width <= width + 1 &&
            box.y + box.height <= 901
          );
        })
        .toBe(true);
      await page.screenshot({
        path: `test-results/partial-pnl-${width}-${dir}.png`,
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
    }
  }
});
