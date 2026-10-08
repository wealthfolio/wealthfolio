import { expect, test, type Locator } from "@playwright/test";
import { BASE_URL, loginIfNeeded } from "./helpers";

interface SavedActivity {
  id: string;
  date: string;
  comment?: string;
}

for (const mode of ["grid", "list", "spending"] as const) {
  test(`${mode} duplication uses today's date and preserves notes`, async ({ page }) => {
    test.setTimeout(180_000);
    await loginIfNeeded(page);
    const api = `${BASE_URL}/api/v1`;
    const runId = Date.now();
    const notes = `Duplicate notes ${runId}\nKeep this second line`;
    const originalDate = new Date();
    originalDate.setDate(originalDate.getDate() - 7);

    const accountResponse = await page.request.post(`${api}/accounts`, {
      data: {
        name: `Duplication ${runId}`,
        accountType: mode === "spending" ? "CASH" : "SECURITIES",
        currency: "USD",
        isDefault: false,
        isActive: true,
        isArchived: false,
        trackingMode: "TRANSACTIONS",
      },
    });
    expect(accountResponse.ok()).toBeTruthy();
    const account = (await accountResponse.json()) as { id: string };
    let assetId: string | undefined;
    if (mode !== "spending") {
      const assetResponse = await page.request.post(`${api}/assets`, {
        data: {
          kind: "INVESTMENT",
          name: `Duplication asset ${runId}`,
          displayCode: `DUP${runId}`,
          instrumentSymbol: `DUP${runId}`,
          instrumentType: "EQUITY",
          quoteMode: "MANUAL",
          quoteCcy: "USD",
        },
      });
      expect(assetResponse.ok()).toBeTruthy();
      assetId = ((await assetResponse.json()) as { id: string }).id;
    }
    const sourceResponse = await page.request.post(`${api}/activities`, {
      data: {
        accountId: account.id,
        activityType: mode === "spending" ? "WITHDRAWAL" : "BUY",
        activityDate: originalDate.toISOString(),
        ...(assetId ? { asset: { id: assetId }, quantity: "1", unitPrice: "25" } : {}),
        amount: "25",
        currency: "USD",
        comment: notes,
      },
    });
    expect(sourceResponse.ok()).toBeTruthy();
    const source = (await sourceResponse.json()) as { id: string };

    async function readActivities(): Promise<SavedActivity[]> {
      const response = await page.request.post(`${api}/activities/search`, {
        data: { page: 0, pageSize: 100, accountIdFilter: [account.id] },
      });
      expect(response.ok()).toBeTruthy();
      return ((await response.json()) as { data: SavedActivity[] }).data;
    }

    async function duplicate(row: Locator, actionName: string) {
      await row.hover();
      await row.getByRole("button", { name: actionName, exact: true }).click();
      await page.getByRole("menuitem", { name: "Duplicate", exact: true }).click();
    }

    const settingsResponse = await page.request.get(`${api}/spending/settings`);
    expect(settingsResponse.ok()).toBeTruthy();
    const previousSettings = await settingsResponse.json();
    try {
      if (mode === "spending") {
        const enabled = await page.request.put(`${api}/spending/settings`, {
          data: { enabled: true, accountIds: [account.id] },
        });
        expect(enabled.ok()).toBeTruthy();
      }
      const tab = mode === "spending" ? "spending" : "investments";
      await page.goto(`${BASE_URL}/activities?account=${account.id}&tab=${tab}`);
      const beforeDuplication = Date.now();
      if (mode === "grid") {
        await page.getByTestId("edit-mode-toggle").click();
        const rows = page.locator('[data-slot="grid-row"]');
        await expect(rows).toHaveCount(1);
        await duplicate(rows.first(), "Open");
        await expect(rows).toHaveCount(2);
        await expect(rows.first().locator('[data-column-id="comment"]')).toContainText(notes);
        // Grid duplicates remain drafts until the existing Save action is used.
        expect(await readActivities()).toHaveLength(1);
        await page.getByRole("button", { name: "Save changes", exact: true }).click();
        await expect(
          page.getByRole("button", { name: "Save changes", exact: true }),
        ).not.toBeVisible({ timeout: 15_000 });
      } else {
        const row = page.getByRole("row").filter({
          hasText: mode === "spending" ? notes.split("\n")[0] : `DUP${runId}`,
        });
        await expect(row).toHaveCount(1);
        await duplicate(row, mode === "spending" ? "Row actions" : "Open");
      }

      await expect.poll(async () => (await readActivities()).length).toBe(2);
      const activities = await readActivities();
      const original = activities.find((activity) => activity.id === source.id);
      expect(original).toBeDefined();
      expect(original?.comment).toBe(notes);
      expect(new Date(original?.date ?? "").getTime()).toBe(originalDate.getTime());
      const duplicated = activities.find((activity) => activity.id !== source.id);
      expect(duplicated?.comment).toBe(notes);
      expect(new Date(duplicated?.date ?? "").getTime()).toBeGreaterThanOrEqual(beforeDuplication);
      expect(new Date(duplicated?.date ?? "").getTime()).toBeLessThanOrEqual(Date.now());
    } finally {
      if (mode === "spending") {
        const restored = await page.request.put(`${api}/spending/settings`, {
          data: previousSettings,
        });
        expect(restored.ok()).toBeTruthy();
      }
    }
  });
}
