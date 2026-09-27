import { expect, test } from "@playwright/test";
import { BASE_URL, loginIfNeeded } from "./helpers";

test("asset exchange edits preserve identity or report conflicts explicitly", async ({ page }) => {
  test.setTimeout(180000);
  page.setDefaultTimeout(15000);
  await loginIfNeeded(page);

  const api = `${BASE_URL}/api/v1`;
  const assets = [];
  for (const mic of ["XNYS", "XNAS"]) {
    const response = await page.request.post(`${api}/assets`, {
      data: {
        kind: "INVESTMENT",
        name: `Exchange edit test ${mic}`,
        displayCode: "TESTMIC20",
        instrumentSymbol: "TESTMIC20",
        instrumentType: "EQUITY",
        instrumentExchangeMic: mic,
        quoteMode: "MANUAL",
        quoteCcy: "USD",
      },
    });
    expect(response.ok()).toBeTruthy();
    assets.push(await response.json());
  }
  const original = assets[0];
  const readOriginal = async () => {
    const response = await page.request.get(`${api}/assets`);
    expect(response.ok()).toBeTruthy();
    const current = await response.json();
    return current.find((asset: { id: string }) => asset.id === original.id);
  };
  const openEditor = async () => {
    await page.goto(`${BASE_URL}/settings/securities`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Securities" })).toBeVisible();
    const reset = page.getByRole("button", { name: "Reset", exact: true });
    const row = page.getByRole("row").filter({ hasText: "Exchange edit test XNYS" });
    await expect(reset.or(row).first()).toBeVisible({ timeout: 15000 });
    if (await reset.isVisible()) await reset.click();
    await expect(row).toBeVisible();
    // Initial query refreshes can remount the row and close its menu.
    await expect(async () => {
      if (await page.getByRole("dialog", { name: "TESTMIC20", exact: true }).isVisible()) return;
      const edit = page.getByRole("menuitem", { name: "Edit", exact: true });
      if (!(await edit.isVisible())) {
        await row.getByRole("button", { name: "Open actions" }).click();
      }
      await edit.click({ timeout: 2000 });
    }).toPass({ timeout: 15000 });
    await expect(page.getByRole("dialog", { name: "TESTMIC20", exact: true })).toBeVisible();
  };

  await openEditor();
  await page.getByPlaceholder("Add any context or links").fill("Saved notes");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "TESTMIC20", exact: true })).not.toBeVisible();
  expect(await readOriginal()).toMatchObject({
    id: original.id,
    notes: "Saved notes",
    instrumentKey: "EQUITY:TESTMIC20@XNYS",
    instrumentExchangeMic: "XNYS",
  });

  await openEditor();
  await page.getByPlaceholder("Add any context or links").fill("Unsaved conflict notes");
  await page
    .getByRole("dialog", { name: "TESTMIC20", exact: true })
    .getByRole("combobox")
    .filter({ hasText: "(XNYS)" })
    .click();
  await page.getByPlaceholder("Search exchanges...").fill("XNAS");
  await page.getByRole("option", { name: /\(XNAS\)$/ }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText(/Another asset already has this identity/)).toBeVisible();
  await expect(page.getByRole("dialog", { name: "TESTMIC20", exact: true })).toBeVisible();
  expect(await readOriginal()).toMatchObject({
    notes: "Saved notes",
    instrumentKey: "EQUITY:TESTMIC20@XNYS",
    instrumentExchangeMic: "XNYS",
  });

  // An ISO-only venue needs no provider catalog entry to be selected and saved.
  await page
    .getByRole("dialog", { name: "TESTMIC20", exact: true })
    .getByRole("combobox")
    .filter({ hasText: "(XNAS)" })
    .click();
  await page.getByPlaceholder("Search exchanges...").fill("21XX");
  await page.getByRole("option", { name: /\(21XX\)$/ }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "TESTMIC20", exact: true })).not.toBeVisible();
  expect(await readOriginal()).toMatchObject({
    id: original.id,
    instrumentKey: "EQUITY:TESTMIC20@21XX",
    instrumentExchangeMic: "21XX",
  });
});
