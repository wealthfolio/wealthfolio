import { expect, test, type Page } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath, selectAccountOption } from "./helpers";

const api = `${BASE_URL}/api/v1`;

async function newAccount(page: Page, accountType = "SECURITIES") {
  const name = `Same-account FX ${Date.now()}`;
  const response = await page.request.post(`${api}/accounts`, {
    data: {
      name,
      accountType,
      currency: "USD",
      isDefault: false,
      isActive: true,
      isArchived: false,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(response.ok()).toBeTruthy();
  return { ...(await response.json()), name } as { id: string; name: string };
}

for (const mobile of [false, true]) {
  test(`${mobile ? "mobile" : "desktop"}: create and edit a same-account cash exchange`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    await completeOnboardingIfNeeded(page);
    const account = await newAccount(page);
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    await gotoAppPath(page, `/activities?tab=investments&account=${account.id}`);
    if (mobile) {
      await page.getByTitle("Add", { exact: true }).click();
      // Each card's id carries a prefix unique to the list.
      await page.locator('label[for$="-TRANSFER_OUT"]').click();
      await page.getByRole("button", { name: "Next", exact: true }).click();
    } else {
      await page.getByTestId("add-activities-button").click();
      await page.getByTestId("add-transaction-action").click();
      const transfer = page.getByTestId("activity-type-transfer");
      if (!(await transfer.isVisible()))
        await page.getByRole("button", { name: "Expand to show all types" }).click();
      await transfer.click();
    }
    for (const label of ["From Account", "To Account"]) {
      const control = page.getByRole("combobox", { name: label, exact: true });
      if (mobile) {
        await control.click();
        await page.getByRole("option", { name: new RegExp(account.name) }).click();
      } else await selectAccountOption(page, account.name, "USD", control);
    }
    // Currency choices must be discoverable without opening advanced options.
    await expect(page.getByTestId("destinationCurrency")).toBeVisible();
    await page.getByTestId("destinationCurrency").click();
    await page
      .getByPlaceholder(mobile ? "Search all currencies..." : "Search currency...")
      .fill("EUR");
    await page
      .getByRole(mobile ? "button" : "option", { name: /EUR/ })
      .last()
      .click();
    await page.getByLabel("Sent amount", { exact: true }).fill("100");
    await page.getByLabel("Received amount", { exact: true }).fill("92.12345678");

    async function save() {
      const response = page.waitForResponse(
        (res) =>
          res.url().endsWith("/activities/transfer-pair") && res.request().method() === "POST",
      );
      if (mobile) await page.getByRole("button", { name: /^(Add|Update) Activity$/ }).click();
      else await page.getByTestId("activity-form-dialog").locator('button[type="submit"]').click();
      const saved = await response;
      expect(saved.ok(), await saved.text()).toBeTruthy();
      const pair = await saved.json();
      for (const leg of [pair.transferOut, pair.transferIn]) {
        expect(leg.accountId).toBe(account.id);
        expect(leg.sourceSystem).toBe("MANUAL");
        expect(leg.metadata.flow.is_external).toBe(false);
        expect(leg.fxRate ?? null).toBeNull();
      }
      expect(pair.transferOut.currency).toBe("USD");
      expect(pair.transferIn.currency).toBe("EUR");
      expect(pair.transferOut.sourceGroupId).toBe(pair.transferIn.sourceGroupId);
      return pair;
    }
    const created = await save();
    expect(Number(created.transferOut.amount)).toBe(100);
    expect(Number(created.transferIn.amount)).toBe(92.12345678);

    // Resolve the pair from either leg; editing uses the same pair-save endpoint.
    const editId = mobile ? created.transferIn.id : created.transferOut.id;
    await gotoAppPath(page, `/activities?tab=investments&activity=${editId}`);
    await page.getByRole("button", { name: "Open", exact: true }).first().click();
    if (mobile) await page.getByText("Edit", { exact: true }).click();
    else await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
    await expect(page.getByTestId("destinationCurrency")).toBeVisible();
    await page.getByLabel("Received amount", { exact: true }).fill("91.5");
    const edited = await save();
    expect(edited.transferOut.id).toBe(created.transferOut.id);
    expect(edited.transferIn.id).toBe(created.transferIn.id);
    expect(Number(edited.transferOut.amount)).toBe(100);
    expect(Number(edited.transferIn.amount)).toBe(91.5);

    const rejected = await page.request.post(`${api}/activities/transfer-pair`, {
      data: {
        fromAccountId: account.id,
        toAccountId: account.id,
        activityDate: new Date().toISOString(),
        sourceAmount: "100",
        destinationAmount: "100",
        sourceCurrency: "USD",
        destinationCurrency: "USD",
        transferMode: "cash",
      },
    });
    expect(rejected.ok()).toBe(false);
    const deleted = await page.request.delete(`${api}/activities/${created.transferIn.id}`);
    expect(deleted.ok()).toBeTruthy();
    const search = await page.request.post(`${api}/activities/search`, {
      data: { accountIdFilter: [account.id], page: 0, pageSize: 100 },
    });
    expect((await search.json()).data).toHaveLength(0);
  });
}

for (const mode of ["grid", "list", "spending"] as const) {
  test(`${mode}: duplicates both FX legs without turning them into cash flows`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    page.setDefaultTimeout(15_000);
    await completeOnboardingIfNeeded(page);
    const account = await newAccount(page, mode === "spending" ? "CASH" : "SECURITIES");
    const notes = `FX duplicate ${Date.now()}`;
    const response = await page.request.post(`${api}/activities/transfer-pair`, {
      data: {
        fromAccountId: account.id,
        toAccountId: account.id,
        activityDate: new Date().toISOString(),
        sourceAmount: "100",
        destinationAmount: "92",
        sourceCurrency: "USD",
        destinationCurrency: "EUR",
        notes,
        transferMode: "cash",
      },
    });
    expect(response.ok()).toBeTruthy();
    const original = await response.json();
    async function readActivities() {
      const result = await page.request.post(`${api}/activities/search`, {
        data: { accountIdFilter: [account.id], page: 0, pageSize: 100 },
      });
      expect(result.ok()).toBeTruthy();
      return (await result.json()).data as {
        id: string;
        sourceGroupId: string;
        amount: string;
        currency: string;
      }[];
    }
    const previousSettings = await (await page.request.get(`${api}/spending/settings`)).json();
    try {
      if (mode === "spending") {
        expect(
          (
            await page.request.put(`${api}/spending/settings`, {
              data: { enabled: true, accountIds: [account.id] },
            })
          ).ok(),
        ).toBeTruthy();
        const deposit = await page.request.post(`${api}/activities`, {
          data: {
            accountId: account.id,
            activityType: "DEPOSIT",
            amount: "1000",
            currency: "USD",
            activityDate: new Date().toISOString(),
          },
        });
        expect(deposit.ok()).toBeTruthy();
        const totals = await page.request.post(`${api}/spending/cash-activities/search`, {
          data: { accountIds: [account.id] },
        });
        const cash = await totals.json();
        expect(cash.net.byCurrency).toEqual(
          expect.arrayContaining([
            { currency: "USD", amount: 900 },
            { currency: "EUR", amount: 92 },
          ]),
        );
        const exchanges = cash.items.filter((item: { activityType: string }) =>
          item.activityType.startsWith("TRANSFER"),
        );
        expect(exchanges).toHaveLength(2);
        expect(
          exchanges.every((item: { cashFlowBucket: string }) => item.cashFlowBucket === "neutral"),
        ).toBe(true);
      }
      await gotoAppPath(
        page,
        `/activities?account=${account.id}&tab=${mode === "spending" ? "spending" : "investments"}`,
      );
      if (mode === "grid") {
        await page.getByTestId("edit-mode-toggle").click();
        const rows = page.locator('[data-slot="grid-row"]');
        await expect(rows).toHaveCount(2);
        await rows.first().getByRole("button", { name: "Open", exact: true }).click();
        await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
        await expect(rows).toHaveCount(4);
        expect(await readActivities()).toHaveLength(2);
        await page.getByRole("button", { name: "Save changes", exact: true }).click();
        await expect(
          page.getByRole("button", { name: "Save changes", exact: true }),
        ).not.toBeVisible({ timeout: 15_000 });
      } else {
        const rows = page.getByRole("row").filter({ hasText: notes });
        await rows
          .first()
          .getByRole("button", { name: mode === "spending" ? "Row actions" : "Open", exact: true })
          .click();
        await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
      }
      await expect
        .poll(async () => (await readActivities()).length)
        .toBe(mode === "spending" ? 5 : 4);
      const duplicates = (await readActivities()).filter(
        (leg) => leg.sourceGroupId && leg.sourceGroupId !== original.transferOut.sourceGroupId,
      );
      expect(duplicates).toHaveLength(2);
      expect(duplicates[0].sourceGroupId).toBe(duplicates[1].sourceGroupId);
      expect(duplicates.map((leg) => `${leg.amount} ${leg.currency}`).sort()).toEqual([
        "100 USD",
        "92 EUR",
      ]);
      const deleted = await page.request.delete(`${api}/activities/${duplicates[0].id}`);
      expect(deleted.ok()).toBeTruthy();
      expect(await readActivities()).toHaveLength(mode === "spending" ? 3 : 2);
    } finally {
      if (mode === "spending")
        await page.request.put(`${api}/spending/settings`, { data: previousSettings });
    }
  });
}
