import { expect, Page, test } from "@playwright/test";
import { BASE_URL, completeOnboardingIfNeeded, gotoAppPath } from "./helpers";

// Covers PR #1344's manual test-plan checklist end to end against the web app
// (Tauri desktop isn't Playwright-drivable — see e2e/README.md):
//   - hand-categorizing a merchant surfaces a suggestion with a sensible pattern
//   - accepting it creates the rule and future matches get picked up
//   - hand-categorizing a new merchant in a category with an existing
//     alternation rule offers to extend it instead of duplicating
//   - dismissing a suggestion hides it, and it stays hidden after reload
test.describe.configure({ mode: "serial" });

test.describe("Spending rule suggestions", () => {
  let page: Page;
  let accountId: string;
  const GROCERIES = { taxonomyId: "spending_categories", categoryId: "cat_groceries" };

  async function apiPost<T>(path: string, data: unknown): Promise<T> {
    const res = await page.request.post(`${BASE_URL}/api/v1${path}`, { data });
    expect(res.ok(), `POST ${path} failed: ${await res.text().catch(() => "")}`).toBeTruthy();
    return res.json();
  }

  async function apiPut<T>(path: string, data: unknown): Promise<T> {
    const res = await page.request.put(`${BASE_URL}/api/v1${path}`, { data });
    expect(res.ok(), `PUT ${path} failed: ${await res.text().catch(() => "")}`).toBeTruthy();
    return res.json();
  }

  async function seedActivity(notes: string, categorize: boolean) {
    const activity = await apiPost<{ id: string }>("/activities", {
      accountId,
      activityType: "WITHDRAWAL",
      activityDate: new Date().toISOString(),
      currency: "USD",
      amount: 42.5,
      notes,
    });
    if (categorize) {
      await apiPut(`/spending/activities/${activity.id}/assignments`, GROCERIES);
    }
    return activity.id;
  }

  // The settings shell renders its content twice — a mobile copy and a
  // desktop copy, toggled with responsive CSS rather than conditional
  // mounting — so plain .bg-card matches twice. Scope to the visible one.
  function suggestionCard(merchant: string) {
    return page.locator(".bg-card:visible").filter({ hasText: merchant });
  }

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(180000);
    page = await browser.newPage();
    await completeOnboardingIfNeeded(page);

    const account = await apiPost<{ id: string }>("/accounts", {
      name: "Suggestions Test Account",
      accountType: "CASH",
      group: null,
      currency: "USD",
      isDefault: false,
      isActive: true,
      isArchived: false,
      trackingMode: "TRANSACTIONS",
      platformId: null,
      accountNumber: null,
      meta: null,
      provider: null,
      providerAccountId: null,
    });
    accountId = account.id;

    await apiPut("/spending/settings", { enabled: true, accountIds: [accountId] });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("1. Hand-categorizing a merchant surfaces a suggestion", async () => {
    await seedActivity("BRISTOL FARMS 552", true);
    await seedActivity("BRISTOL FARMS STORE", true);
    // Not categorized — should be counted as an uncategorized match the
    // suggested pattern would newly catch.
    await seedActivity("BRISTOL FARMS 9910", false);

    await gotoAppPath(page, "/settings/spending/rules");
    await expect(page.getByRole("button", { name: /Suggested rules/i })).toBeVisible({
      timeout: 15000,
    });

    const card = suggestionCard("Bristol Farms");
    await expect(card).toBeVisible({ timeout: 10000 });
    await expect(card).toContainText("Groceries");
    await expect(card).toContainText("Catches 1 uncategorized");
  });

  test("2. Accepting the suggestion creates the rule", async () => {
    const card = suggestionCard("Bristol Farms");
    await card.getByRole("button", { name: "Add rule" }).click();

    await expect(page.getByText(/Added rule for Bristol Farms\./)).toBeVisible({
      timeout: 10000,
    });
    await expect(card).not.toBeVisible({ timeout: 10000 });
  });

  test("3. A new merchant in the same category offers to extend the rule", async () => {
    await seedActivity("GELSONS MARKET", true);
    await seedActivity("GELSONS 1201", true);
    await seedActivity("GELSONS 9812", false);

    await page.reload();
    const card = suggestionCard("Gelsons");
    await expect(card).toBeVisible({ timeout: 15000 });
    await expect(card.getByText("Extends existing rule")).toBeVisible();

    await card.getByRole("button", { name: "Extend" }).click();
    await expect(page.getByText(/Extended rule for Gelsons\./)).toBeVisible({ timeout: 10000 });
    await expect(card).not.toBeVisible({ timeout: 10000 });
  });

  test("4. Dismissing a suggestion hides it, and it stays hidden after reload", async () => {
    await seedActivity("HEINENS FINE FOODS", true);
    await seedActivity("HEINENS 88", true);
    await seedActivity("HEINENS 4471", false);

    await page.reload();
    const card = suggestionCard("Heinens");
    await expect(card).toBeVisible({ timeout: 15000 });

    await card.getByRole("button", { name: "Dismiss suggestion" }).click();
    await expect(card).not.toBeVisible({ timeout: 5000 });

    await page.reload();
    await expect(suggestionCard("Heinens")).not.toBeVisible({ timeout: 10000 });
  });
});
