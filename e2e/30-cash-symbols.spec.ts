import { expect, test, type Page } from "./fixtures";
import { BASE_URL, loginIfNeeded } from "./helpers";

const api = `${BASE_URL}/api/v1`;

async function createAccount(page: Page, name: string) {
  const response = await page.request.post(`${api}/accounts`, {
    data: {
      name,
      accountType: "CASH",
      currency: "USD",
      isDefault: false,
      isActive: true,
      isArchived: false,
      trackingMode: "TRANSACTIONS",
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return (await response.json()) as { id: string };
}

test("cash-symbol transfer pairs survive a datagrid edit", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  await loginIfNeeded(page);
  const runId = Date.now();
  const source = await createAccount(page, `Cash symbols source ${runId}`);
  const destination = await createAccount(page, `Cash symbols destination ${runId}`);
  const group = `cash-symbols-${runId}`;
  const response = await page.request.post(`${api}/activities/bulk`, {
    data: {
      creates: [
        { accountId: source.id, activityType: "TRANSFER_OUT" },
        { accountId: destination.id, activityType: "TRANSFER_IN" },
      ].map((leg) => ({
        ...leg,
        asset: { symbol: "$CASH-USD" },
        amount: "100",
        currency: "USD",
        activityDate: "2026-05-01T12:00:00Z",
        sourceGroupId: group,
        metadata: JSON.stringify({ flow: { is_external: false } }),
      })),
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const result = await response.json();
  expect(result.errors).toEqual([]);
  expect(result.created).toHaveLength(2);
  for (const leg of result.created) {
    expect(leg.assetId).toBeNull();
    expect(leg.sourceGroupId).toBe(group);
    expect(Number(leg.amount)).toBe(100);
  }

  await page.goto(`${BASE_URL}/activities?account=${source.id}&tab=investments`);
  await page.getByTestId("edit-mode-toggle").click();
  const row = page.locator('[data-slot="grid-row"]');
  await expect(row).toHaveCount(1);
  const editor = page.locator("[data-grid-cell-editor] textarea");
  // Loading the page triggers a portfolio update whose refetch re-renders the
  // grid; a double-click landing on that re-render does not open the editor.
  await expect(async () => {
    await row.locator('[data-column-id="comment"]').dblclick();
    await expect(editor).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  await editor.fill("Cash symbol transfer edited");
  await page.keyboard.press("Tab");
  await expect(row.locator('[data-column-id="comment"]')).toContainText(
    "Cash symbol transfer edited",
  );
  const savedResponse = page.waitForResponse(
    (res) => res.url().endsWith("/activities/bulk") && res.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  const saved = await savedResponse;
  expect(saved.ok(), await saved.text()).toBeTruthy();
  expect(saved.request().postDataJSON().updates[0].notes).toBe("Cash symbol transfer edited");
  const updated = await saved.json();
  expect(updated.errors).toEqual([]);
  expect(updated.updated).toHaveLength(2);
  for (const leg of updated.updated) {
    expect(leg.assetId).toBeNull();
    expect(leg.sourceGroupId).toBe(group);
    expect(Number(leg.amount)).toBe(100);
    expect(leg.notes).toBe("Cash symbol transfer edited");
  }
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).not.toBeVisible();
});

for (const bulk of [false, true]) {
  test(`${bulk ? "bulk" : "single"}: cash-symbol repair preserves stored amount and infers currency`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await loginIfNeeded(page);
    const runId = Date.now();
    const account = await createAccount(page, `Cash symbol repair ${runId}`);
    const assetResponse = await page.request.post(`${api}/assets`, {
      data: {
        kind: "INVESTMENT",
        name: `Legacy cash security ${runId}`,
        displayCode: `LEGACY${runId}`,
        instrumentSymbol: `LEGACY${runId}`,
        instrumentType: "EQUITY",
        quoteMode: "MANUAL",
        quoteCcy: "USD",
      },
    });
    expect(assetResponse.ok(), await assetResponse.text()).toBeTruthy();
    const asset = (await assetResponse.json()) as { id: string };
    const createResponse = await page.request.post(`${api}/activities`, {
      data: {
        accountId: account.id,
        activityType: "TRANSFER_OUT",
        asset: { id: asset.id },
        quantity: "1",
        unitPrice: "100",
        amount: "75",
        currency: "USD",
        activityDate: "2026-05-01T12:00:00Z",
      },
    });
    expect(createResponse.ok(), await createResponse.text()).toBeTruthy();
    const existing = await createResponse.json();
    const patch = {
      id: existing.id,
      accountId: account.id,
      activityType: "TRANSFER_OUT",
      activityDate: existing.activityDate,
      asset: { symbol: "$CASH-EUR" },
      quantity: "2",
      currency: "",
    };
    const response = bulk
      ? await page.request.post(`${api}/activities/bulk`, { data: { updates: [patch] } })
      : await page.request.put(`${api}/activities`, { data: patch });
    expect(response.ok(), await response.text()).toBeTruthy();
    const result = await response.json();
    if (bulk) expect(result.errors).toEqual([]);
    const saved = bulk ? result.updated[0] : result;
    expect(saved.id).toBe(existing.id);
    expect(saved.assetId).toBeNull();
    expect(saved.currency).toBe("EUR");
    expect(Number(saved.amount)).toBe(75);

    const storedResponse = await page.request.post(`${api}/activities/search`, {
      data: { page: 0, pageSize: 10, activityIdFilter: [existing.id] },
    });
    expect(storedResponse.ok()).toBeTruthy();
    const stored = (await storedResponse.json()).data[0];
    // Search exposes ActivityDetails, whose optional asset is an empty string.
    expect(stored.assetId).toBe("");
    expect(stored.currency).toBe("EUR");
    expect(Number(stored.amount)).toBe(75);
  });
}
