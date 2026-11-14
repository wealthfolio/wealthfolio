import { api, createAccount, createActivity, deposit, uniqueName } from "./api";
import { expect, test, type Page } from "./fixtures";
import { BASE_URL } from "./helpers";
import { PHONE } from "./phone";

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
// The phone pass opens the phone layout: tab bar, stacked screens and sheets.
const PASSES = [
  { name: "normal", query: "", slow: undefined, phone: false },
  { name: "slow API", query: "", slow: "forward", phone: false },
  { name: "slow API, reversed", query: "", slow: "reversed", phone: false },
  { name: "right-to-left", query: "?dir=rtl", slow: undefined, phone: false },
  { name: "phone", query: "", slow: undefined, phone: true },
] as const;

// App bugs this sweep finds, by "<pass> <route>", each to fix separately. The
// test is expected to fail until then.
const KNOWN_FAILURES: Record<string, string> = {};

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

/**
 * What reaches past the window's sides. The document mustn't scroll sideways,
 * but the app clips sideways on `html`, `body` and most containers, so content
 * that is too wide is cut off rather than scrolled to: also look for visible
 * elements that cross the window's left or right edge. Elements in a scroller
 * meant to scroll sideways (overflow-x auto, as wide tables and tab strips
 * use) or in a carousel, which shows its next slide in part, don't count; nor do
 * ones their containers hide, such as a swipeable page's other tabs.
 */
function sidewaysOverflow(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const found: string[] = [];
    if (root.scrollWidth > root.clientWidth) {
      found.push(`document scrolls: ${root.scrollWidth} > ${root.clientWidth}`);
    }
    const width = root.clientWidth;
    // Elements in a sideways scroller or a carousel don't count. Of the rest,
    // the part not clipped by the containers around it is what shows.
    const shownPart = (element: Element, box: DOMRect) => {
      let [left, right] = [box.left, box.right];
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const overflowX = getComputedStyle(parent).overflowX;
        if (/(auto|scroll)/.test(overflowX) || parent.dataset.slot === "carousel-content") {
          return null;
        }
        if (overflowX !== "visible") {
          const bounds = parent.getBoundingClientRect();
          [left, right] = [Math.max(left, bounds.left), Math.min(right, bounds.right)];
        }
      }
      return right - left > 1 ? { left, right } : null;
    };
    for (const element of document.querySelectorAll("body *")) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const crossesEdge =
        (box.left < -1 && box.right > 1) || (box.left < width - 1 && box.right > width + 1);
      if (!crossesEdge) continue;
      if (!element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
      // Wholly hidden by a container, such as a swipeable page's other tabs.
      if (!shownPart(element, box)) continue;
      const name = `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 60)}`;
      found.push(`${name}: ${Math.round(box.left)}-${Math.round(box.right)} of ${width}`);
      if (found.length >= 5) break;
    }
    return found;
  });
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
    if (pass.phone) test.use(PHONE);
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
        const knownFailure = KNOWN_FAILURES[`${pass.name} ${label}`];
        test.fail(knownFailure !== undefined, knownFailure);
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
        // The phone keeps the screens under the top one mounted and hidden.
        const skeletons = content.locator('[data-slot="skeleton"]');
        await expect(pass.phone ? skeletons.locator("visible=true") : skeletons).toHaveCount(0);
        // Nothing reaches past the window's sides: the page doesn't scroll sideways or cut content off.
        // Polled, so a sheet or tab still sliding into place can finish.
        await expect.poll(() => sidewaysOverflow(page)).toEqual([]);
        if (pass.query.includes("rtl")) {
          await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
        }
      });
    }
  });
}
