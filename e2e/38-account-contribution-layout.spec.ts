import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

test("account contribution details remain readable on phones, tablets and desktop", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await completeOnboardingIfNeeded(page);
  const response = await page.request.post(`${BASE_URL}/api/v1/accounts`, {
    data: {
      name: "Contribution layout",
      accountType: "CASH",
      currency: "USD",
      isActive: true,
      isDefault: false,
    },
  });
  expect(response.ok(), await response.text()).toBe(true);
  const { id } = await response.json();
  const year = new Date().getFullYear();
  const limit = await page.request.post(`${BASE_URL}/api/v1/limits`, {
    data: { groupName: "TFSA", contributionYear: year, limitAmount: 7000, accountIds: id },
  });
  expect(limit.ok(), await limit.text()).toBe(true);
  const deposit = await page.request.post(`${BASE_URL}/api/v1/activities`, {
    data: {
      accountId: id,
      activityType: "DEPOSIT",
      activityDate: `${year}-01-02T15:00:00Z`,
      currency: "USD",
      amount: 500,
      fee: 0,
      needsReview: false,
    },
  });
  expect(deposit.ok(), await deposit.text()).toBe(true);
  await expect
    .poll(
      async () => {
        const holdings = await page.request.post(`${BASE_URL}/api/v1/holdings/list/query`, {
          data: { filter: { type: "account", accountId: id }, includeClosed: true },
        });
        expect(holdings.ok()).toBe(true);
        return ((await holdings.json()) as { holdings: unknown[] }).holdings.length;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);

  for (const dir of ["ltr", "rtl"]) {
    for (const width of [390, 768, 820, 1440]) {
      await page.setViewportSize({ width, height: 1100 });
      await gotoAppPath(page, `/accounts/${id}?dir=${dir}`);
      const title = page.getByText(`${year} TFSA limit`, { exact: true });
      await expect(title).toBeVisible();
      const balance = page.getByTestId("account-cash-balance-value");
      await expect(balance).toBeVisible();
      await expect
        .poll(
          () =>
            balance.evaluate((element) => {
              const header = element.closest('[data-slot="card-header"]');
              const label = header?.querySelector('[data-slot="card-title"]');
              if (!header || !label) throw new Error("Balance header missing");
              const value = element.getBoundingClientRect();
              const name = label.getBoundingClientRect();
              const box = header.getBoundingClientRect();
              return (
                value.left >= box.left &&
                value.right <= box.right &&
                (name.right <= value.left ||
                  value.right <= name.left ||
                  name.bottom <= value.top ||
                  value.bottom <= name.top)
              );
            }),
          {
            message: `${width}px ${dir}: the balance stays inside its card without overlapping its label`,
          },
        )
        .toBe(true);
      await expect
        .poll(
          () =>
            title.evaluate((element) => {
              const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
              return element.getBoundingClientRect().height / lineHeight;
            }),
          { message: `${width}px ${dir}: year and group stay within two lines` },
        )
        .toBeLessThanOrEqual(2);
      await expect
        .poll(
          () =>
            title.evaluate((element) => {
              const card = element.closest('[data-slot="card-content"]');
              if (!card) throw new Error("Contribution card missing");
              return element.getBoundingClientRect().width >= Math.min(card.clientWidth - 32, 120);
            }),
          { message: `${width}px ${dir}: status does not squeeze the contribution details` },
        )
        .toBe(true);
    }
  }
});
