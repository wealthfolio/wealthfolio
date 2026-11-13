import { api, createAccount, createActivity, deposit, uniqueName } from "./api";
import { expect, test, type Page } from "./fixtures";
import { BASE_URL } from "./helpers";

// Opens every page of the app and checks that it renders: no crash (the
// fixture's crash guard), content in the page, and no loading placeholders
// left. The slow passes hold back each API response by a different amount, so
// data arrives late and in a different order, which is when refetch races and
// missing-data crashes show up. Records are seeded once per worker, for the pages that take an id.

interface Seed {
  accountId: string;
  assetId: string;
  goalId: string;
  limitId: string;
}

// Routes from apps/frontend/src/app-screen-routes.tsx, ids filled from `Seed`.
const ROUTES: Array<string | ((seed: Seed) => string)> = [
  "/dashboard",
  "/activities",
  "/activities/add",
  "/activities/manage",
  "/activities/transfers",
  "/holdings",
  (seed) => `/holdings/${encodeURIComponent(seed.assetId)}`,
  "/import",
  (seed) => `/accounts/${seed.accountId}`,
  "/income",
  "/performance",
  "/insights",
  "/health",
  "/assistant",
  "/connect",
  "/allocation-targets",
  "/goals",
  "/goals/new",
  (seed) => `/goals/${seed.goalId}`,
  (seed) => `/goals/${seed.goalId}/guide`,
  "/spending/insights",
  "/spending/transactions/new",
  "/spending/budget",
  "/settings",
  "/settings/general",
  "/settings/accounts",
  "/settings/portfolios",
  "/settings/appearance",
  "/settings/about",
  "/settings/exports",
  "/settings/contribution-limits",
  (seed) => `/settings/contribution-limits/${seed.limitId}`,
  "/settings/spending",
  "/settings/spending/categories",
  "/settings/spending/events",
  "/settings/spending/rules",
  "/settings/spending/setup",
  "/settings/market-data",
  "/settings/market-data/import",
  "/settings/securities",
  "/settings/taxonomies",
  "/settings/connect",
  "/settings/ai-providers",
  "/settings/agent-access",
  "/settings/addons",
  "/no-such-page",
];

// The second slow pass reverses every delay, so any two requests the page sends
// together arrive in one order in the first pass and the other in the second.
const PASSES = [
  { name: "normal", query: "", slow: undefined },
  { name: "slow API", query: "", slow: "forward" },
  { name: "slow API, reversed", query: "", slow: "reversed" },
  { name: "right-to-left", query: "?dir=rtl", slow: undefined },
] as const;

const MAX_API_DELAY_MS = 750;

// Each request is held back 0-0.75 s, by its URL: responses arrive in a different
// order than on a fast server, and the same order on every run.
function apiDelay(url: string, order: "forward" | "reversed") {
  let hash = 0;
  for (const char of new URL(url).pathname + new URL(url).search) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
  }
  const delay = hash % MAX_API_DELAY_MS;
  return order === "forward" ? delay : MAX_API_DELAY_MS - delay;
}

async function seed(page: Page): Promise<Seed> {
  const account = await createAccount(page, { name: uniqueName("Sweep"), currency: "USD" });
  await deposit(page, account.id, 10_000, "USD", "2026-01-05T15:00:00.000Z");
  const buy = await createActivity(page, {
    accountId: account.id,
    activityType: "BUY",
    activityDate: "2026-01-06T15:00:00.000Z",
    currency: "USD",
    quantity: 10,
    unitPrice: 100,
    asset: { symbol: uniqueName("SWEEP").replace(/\W/g, "").slice(0, 16) },
  });
  const goal = await api<{ id: string }>(page, "POST", "/goals", {
    goalType: "custom_save_up",
    title: uniqueName("Sweep goal"),
    targetAmount: 10_000,
    targetDate: "2030-12-31",
  });
  const year = new Date().getUTCFullYear();
  const limit = await api<{ id: string }>(page, "POST", "/limits", {
    groupName: uniqueName("Sweep limit"),
    contributionYear: year,
    limitAmount: 7000,
    accountIds: account.id,
  });
  return { accountId: account.id, assetId: buy.assetId ?? "", goalId: goal.id, limitId: limit.id };
}

const EVENT_STREAM = "/api/v1/events/stream";
const QUIET_MS = 750;

/**
 * Resolves once the page has made at least one API request and none has been in
 * flight for `QUIET_MS`: the page has loaded its data, including what the load's
 * portfolio update refetches. Call before navigating.
 */
function trackApiRequests(page: Page) {
  let inFlight = 0;
  let started = 0;
  let lastChange = Date.now();
  const isApi = (url: string) => url.includes("/api/v1/") && !url.includes(EVENT_STREAM);
  const done = () => {
    inFlight -= 1;
    lastChange = Date.now();
  };
  page.on("request", (request) => {
    if (!isApi(request.url())) return;
    inFlight += 1;
    started += 1;
    lastChange = Date.now();
  });
  page.on("requestfinished", (request) => isApi(request.url()) && done());
  page.on("requestfailed", (request) => isApi(request.url()) && done());
  return () =>
    expect
      .poll(() => started > 0 && inFlight === 0 && Date.now() - lastChange >= QUIET_MS, {
        message: "the page's API requests settle",
        timeout: 60_000,
        intervals: [100],
      })
      .toBe(true);
}

let seeded: Seed;

test.describe.configure({ mode: "parallel" });

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage();
  seeded = await seed(page);
  expect(seeded.assetId, "the buy created an asset").not.toBe("");
  await page.close();
});

for (const pass of PASSES) {
  test.describe(`page sweep, ${pass.name}`, () => {
    for (const route of ROUTES) {
      const label =
        typeof route === "string"
          ? route
          : route({
              accountId: ":id",
              assetId: ":assetId",
              goalId: ":goalId",
              limitId: ":limitId",
            });
      test(label, async ({ page }) => {
        test.setTimeout(pass.slow ? 120_000 : 60_000);
        const { slow } = pass;
        if (slow) {
          await page.route("**/api/v1/**", async (request) => {
            // The event stream stays open; holding it back only delays events.
            if (!request.request().url().includes(EVENT_STREAM)) {
              await new Promise((resolve) =>
                setTimeout(resolve, apiDelay(request.request().url(), slow)),
              );
            }
            await request.fallback();
          });
        }
        const settled = trackApiRequests(page);
        const path = typeof route === "string" ? route : route(seeded);
        await page.goto(`${BASE_URL}${path}${pass.query}`, { waitUntil: "domcontentloaded" });
        await settled();

        // Some pages title themselves in the app bar, so any text counts as
        // rendered; the spending entry page is a dialog over an empty page.
        const content = page.locator('main, [role="dialog"]');
        await expect(content.filter({ hasText: /\S/ }).first()).toBeVisible();
        await expect(content.locator('[data-slot="skeleton"]')).toHaveCount(0);
        if (pass.query.includes("rtl")) {
          await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
        }
      });
    }
  });
}
