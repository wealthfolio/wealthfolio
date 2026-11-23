import { expect, test } from "./fixtures";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

// On a phone the whole return tile opens its explanation. The trigger is an
// overlay beside the tile's content, so a tap on the animated value must still
// land on it rather than on the value's own stacking context.
test("tapping a return tile's value on mobile opens its explanation", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await completeOnboardingIfNeeded(page);

  const runId = Date.now().toString(36);
  const accountResponse = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
    data: {
      name: `Metric tile ${runId}`,
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      isArchived: false,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(accountResponse.ok(), await accountResponse.text()).toBeTruthy();
  const accountId = ((await accountResponse.json()) as { id: string }).id;
  for (const data of [
    { activityType: "DEPOSIT", activityDate: "2024-01-02T15:00:00Z", amount: 2000 },
    {
      activityType: "BUY",
      activityDate: "2024-01-03T15:00:00Z",
      quantity: 10,
      unitPrice: 100,
      asset: {
        name: "Metric tile asset",
        symbol: `TILE${runId.toUpperCase()}`,
        kind: "INVESTMENT",
        quoteCcy: "USD",
        quoteMode: "MANUAL",
      },
    },
  ]) {
    const response = await page.request.post(`${BASE_URL}/api/v1/activities`, {
      data: { accountId, currency: "USD", fee: 0, needsReview: false, ...data },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  }

  await gotoAppPath(page, `/accounts/${accountId}`);
  const trigger = page.getByRole("button", { name: "More info about Time Weighted Return" });
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  const value = trigger.locator("xpath=..").locator("number-flow-react").first();
  await expect(value).toBeVisible({ timeout: 60_000 });
  await value.scrollIntoViewIfNeeded();

  const box = await value.boundingBox();
  if (!box) throw new Error("The tile's value has no box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByRole("dialog")).toBeVisible();
});
