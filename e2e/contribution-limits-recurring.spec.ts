import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test("future limits render and recurring projections retain their account and tax-year dates", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await completeOnboardingIfNeeded(page);
  const year = new Date().getFullYear();
  let bobAccountId = "";
  for (const name of ["Alice TFSA", "Bob TFSA"]) {
    const response = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
      data: { name, accountType: "CASH", currency: "USD", isActive: true, isDefault: false },
    });
    expect(response.ok(), await response.text()).toBe(true);
    const { id } = await response.json();
    if (name === "Bob TFSA") bobAccountId = id;
    const limit = await page.request.post(`${BASE_URL}/api/v1/limits`, {
      data: {
        groupName: "TFSA",
        contributionYear: year - 1,
        limitAmount: 7000,
        accountIds: id,
        isRecurring: true,
        startDate: new Date(Date.UTC(year - 1, 3, 6, 12)).toISOString(),
        endDate: new Date(Date.UTC(year, 3, 5, 12)).toISOString(),
      },
    });
    expect(limit.ok(), await limit.text()).toBe(true);
    expect((await limit.json()).isRecurring).toBe(true);
  }
  const future = await page.request.post(`${BASE_URL}/api/v1/limits`, {
    data: { groupName: "Saved future limit", contributionYear: year + 2, limitAmount: 9000 },
  });
  expect(future.ok(), await future.text()).toBe(true);

  for (const dir of ["ltr", "rtl"]) {
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await gotoAppPath(page, `/settings/contribution-limits?dir=${dir}`);
      await expect(
        page.getByText("Saved future limit", { exact: true }).filter({ visible: true }),
      ).toBeVisible();
      for (const name of ["Alice TFSA", "Bob TFSA"]) {
        const add = page.getByRole("button", {
          name: `Add TFSA for ${year} (${name})`,
          exact: true,
        });
        await expect(add).toBeVisible();
        const card = add.locator("xpath=ancestor::*[@data-slot='card']");
        await expect(card.getByText(name, { exact: true })).toBeVisible();
        expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
      }
    }
  }

  await page.getByRole("button", { name: `Add TFSA for ${year} (Bob TFSA)`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Add contribution limit" })).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  const limitsResponse = await page.request.get(`${BASE_URL}/api/v1/limits`);
  expect(limitsResponse.ok()).toBe(true);
  const limits = await limitsResponse.json();
  const added = limits.find(
    (limit: { contributionYear: number; accountIds?: string }) =>
      limit.contributionYear === year && limit.accountIds === bobAccountId,
  );
  expect(added).toMatchObject({ isRecurring: true });
  // The form saves each picked day at its start in the app's timezone.
  const settingsResponse = await page.request.get(`${BASE_URL}/api/v1/settings`);
  expect(settingsResponse.ok()).toBe(true);
  const timeZone = (await settingsResponse.json()).timezone?.trim() || "UTC";
  const dayStart = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  expect(dayStart.format(new Date(added.startDate))).toBe(`${year}-04-06, 00:00`);
  expect(dayStart.format(new Date(added.endDate))).toBe(`${year + 1}-04-05, 00:00`);
  const invalid = await page.request.post(`${BASE_URL}/api/v1/limits`, {
    data: { groupName: "Unsupported year", contributionYear: 2147483647, limitAmount: 7000 },
  });
  expect(invalid.status()).toBe(400);
});
