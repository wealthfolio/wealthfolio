import { expect, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

interface TransferRecord {
  id: string;
  activityDate: string;
  notes: string | null;
  sourceRecordId: string | null;
}

for (const mobile of [false, true]) {
  for (const kind of ["manual", "sourced", "fx"] as const) {
    test(`${mobile ? "mobile" : "desktop"}: ${kind} transfer edits keep the correct record scope`, async ({
      page,
    }) => {
      test.setTimeout(120_000);
      await completeOnboardingIfNeeded(page);
      const api = `${BASE_URL}/api/v1`;
      const runId = `${kind}-${mobile}-${Date.now()}`;
      const accountIds: string[] = [];
      for (const side of ["from", "to"]) {
        const response = await page.request.post(`${api}/accounts`, {
          data: {
            name: `Edit scope ${runId} ${side}`,
            accountType: "SECURITIES",
            currency: "USD",
            isDefault: false,
            isActive: true,
            isArchived: false,
            trackingMode: "TRANSACTIONS",
          },
        });
        expect(response.ok(), await response.text()).toBeTruthy();
        accountIds.push(((await response.json()) as { id: string }).id);
      }
      const fx = kind === "fx";
      const sourced = kind !== "manual";
      const records: TransferRecord[] = [];
      for (const incoming of [false, true]) {
        const response = await page.request.post(`${api}/activities`, {
          data: {
            accountId: accountIds[incoming && !fx ? 1 : 0],
            activityType: incoming ? "TRANSFER_IN" : "TRANSFER_OUT",
            activityDate: incoming && !fx ? "2026-01-15T12:00:00Z" : "2026-01-18T12:00:00Z",
            currency: fx && incoming ? "EUR" : "USD",
            amount: fx && incoming ? 90 : 100,
            fee: 0,
            fxRate: fx && incoming ? 1.1 : undefined,
            needsReview: false,
            notes: incoming ? "Original incoming reference" : "Original outgoing reference",
            sourceSystem: sourced ? "SIMPLEFIN" : "MANUAL",
            sourceRecordId: sourced ? `${runId}-${incoming}` : undefined,
            sourceGroupId: `wf-transfer-${runId}`,
            metadata: JSON.stringify({
              flow: { is_external: false },
              ...(fx && {
                fx: {
                  sourceCurrency: "USD",
                  destinationCurrency: "EUR",
                  sourceAmount: "100",
                  destinationAmount: "90",
                  impliedRate: "0.9",
                  rateSource: "implied_from_import",
                },
              }),
            }),
          },
        });
        expect(response.ok(), await response.text()).toBeTruthy();
        records.push((await response.json()) as TransferRecord);
      }
      const selected = records[mobile ? 1 : 0];
      if (mobile) await page.setViewportSize({ width: 390, height: 844 });
      await gotoAppPath(
        page,
        `/activities?tab=investments&activity=${encodeURIComponent(selected.id)}`,
      );
      await page.getByRole("button", { name: "Open", exact: true }).first().click();
      if (mobile) {
        await page.getByText("Edit", { exact: true }).click();
      } else {
        await page.getByRole("menuitem", { name: "Edit", exact: true }).click();
      }
      const day = page.locator('[data-type="day"]').first();
      await day.click();
      await day.press("ArrowUp");
      await day.press("Tab");
      await page.getByText(/Advanced.*Notes/i).click();
      const notes = page.locator('textarea[name="comment"]');
      await expect(notes).toHaveValue(selected.notes!);
      await notes.fill("Corrected selected record");
      const previewResponse = page.waitForResponse(
        (res) =>
          res.url().endsWith("/activities/transfer-pair/split-effects") &&
          res.request().method() === "POST",
      );
      const response = page.waitForResponse(
        (res) =>
          res.url().endsWith("/activities/transfer-pair") && res.request().method() === "POST",
      );
      if (mobile) {
        await page.getByRole("button", { name: "Update Activity", exact: true }).click();
      } else {
        await page.getByTestId("activity-form-dialog").locator('button[type="submit"]').click();
      }
      const saved = await response;
      expect(saved.ok(), await saved.text()).toBeTruthy();
      const request = saved.request().postDataJSON();
      expect(request.editedActivityId).toBe(selected.id);
      const preview = await previewResponse;
      expect(preview.ok(), await preview.text()).toBeTruthy();
      expect(request.splitReview).toEqual(await preview.json());
      expect(
        request.splitReview.map((effect: { activityId: string }) => effect.activityId).sort(),
      ).toEqual(records.map((record) => record.id).sort());

      const editedDate = new Date(request.activityDate).getTime();
      expect(editedDate).not.toBe(new Date(selected.activityDate).getTime());
      const stored = await page.request.get(`${api}/activities/${selected.id}/transfer-pair`);
      expect(stored.ok()).toBeTruthy();
      const pair = (await stored.json()) as {
        transferOut: TransferRecord;
        transferIn: TransferRecord;
      };
      for (const after of [pair.transferOut, pair.transferIn]) {
        const original = records.find((record) => record.id === after.id)!;
        expect(new Date(after.activityDate).getTime()).toBe(
          !sourced || fx || after.id === selected.id
            ? editedDate
            : new Date(original.activityDate).getTime(),
        );
        expect(after.notes).toBe(
          !sourced || after.id === selected.id ? "Corrected selected record" : original.notes,
        );
        expect(after.sourceRecordId).toBe(original.sourceRecordId);
      }
    });
  }
}
