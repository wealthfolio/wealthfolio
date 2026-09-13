# API Reference

Complete reference for Wealthfolio addon APIs. Data APIs require an appropriate
permission entry in `manifest.json`. The baseline capabilities — `query`,
`storage`, `toast`, `logger`, navigation, UI integration, and packaged assets —
are available to every addon and need no declaration.

## Context Overview

The `AddonContext` is provided to your addon's `enable` function:

```typescript
export interface AddonContext {
  api: HostAPI;
  sidebar: SidebarManager;
  router: RouterManager;
  ui: { root: HTMLElement };
  assets: AddonAssets;
  onDisable(callback: () => void): void;
}
```

Basic usage:

```typescript
export default async function enable(ctx: AddonContext) {
  const accounts = await ctx.api.accounts.getAll();
  const logoUrl = await ctx.assets.getUrl("assets/logo.png");
  ctx.api.logger.info(`Loaded ${accounts.length} accounts and ${logoUrl}`);
}
```

`ctx.assets` refers to files private to the addon package. The similarly named
`ctx.api.assets` API manages financial instrument records.

## Import Events

#### `onDropHover(callback: EventCallback): Promise<UnlistenFn>`

Fires when files are hovered over for import.

```typescript
const unlistenHover = await ctx.api.events.import.onDropHover(() => {
  showDropZone();
});
```

#### `onDrop(callback: EventCallback): Promise<UnlistenFn>`

Fires when files are dropped for import.

```typescript
const unlistenImport = await ctx.api.events.import.onDrop((event) => {
  console.log("File dropped:", event.payload);
  // Trigger import workflow
  handleFileImport(event.payload.files);
});
```

#### `onDropCancelled(callback: EventCallback): Promise<UnlistenFn>`

Fires when file drop is cancelled.

```typescript
const unlistenCancel = await ctx.api.events.import.onDropCancelled(() => {
  console.log("File drop cancelled");
  hideDropZone();
});
```

---

## Packaged Assets API

Access static files indexed from `assets/**` and `dist/assets/**`. No manifest
field or permission is required. Addons using this v3.7 API must set
`minWealthfolioVersion` to `3.7.0` or newer.

### Methods

#### `list(): readonly AddonAsset[]`

Returns public metadata (`path`, `mimeType`, and `size`). Host paths and opaque
asset identifiers are never exposed.

#### `has(path: string): boolean`

Checks a logical package path. Invalid and traversing paths return `false`.

#### `getBlob(path: string): Promise<Blob>`

Loads and verifies asset bytes lazily. Concurrent requests for the same asset
share a load; a failed load can be retried.

#### `getUrl(path: string): Promise<string>`

Returns a cached, sandbox-local Blob URL. The URL is revoked automatically when
the addon reloads or stops and must not be persisted.

```typescript
const [logoUrl, wasm] = await Promise.all([
  ctx.assets.getUrl("assets/logo.png"),
  ctx.assets.getBlob("dist/assets/module.wasm"),
]);

await WebAssembly.instantiate(await wasm.arrayBuffer());
```

Local CSS `url(...)` references are rewritten automatically relative to the CSS
file. `data:` and `blob:` URLs are preserved. Remote CSS URLs and `@import` are
rejected; JavaScript/JSX asset strings are not rewritten, so use `getUrl()`. See
the [v3.6 to v3.7 migration guide](./addon-migration-guide-v3.6-to-v3.7.md) for
package limits and compatibility details.

Blob URLs may be used by images, fonts, media elements, and WebAssembly. Worker
and service-worker entry points, popups, direct network access, and remote CSS
imports are intentionally unavailable inside the addon sandbox.

---

## Navigation API

Navigate programmatically within the Wealthfolio application.

### Methods

#### `navigate(route: string): Promise<void>`

Navigate to a specific route in the application.

```typescript
// Navigate to a specific account
await ctx.api.navigation.navigate("/accounts/account-123");

// Navigate to portfolio overview
await ctx.api.navigation.navigate("/portfolio");

// Navigate to activities page
await ctx.api.navigation.navigate("/activities");

// Navigate to settings
await ctx.api.navigation.navigate("/settings");
```

> **Info** **Navigation Routes**: The navigation API uses the same route
> structure as the main application. Common routes include `/accounts`,
> `/portfolio`, `/activities`, `/goals`, and `/settings`.

---

## Query API

Access the QueryClient scoped to this addon and coordinate invalidation with the
host.

### Methods

#### `getClient(): unknown`

Gets the sandbox's addon-local QueryClient as an opaque bridge value. Cast it to
the exported `QueryClient` type before using TanStack Query methods or passing
it to `QueryClientProvider`. It is reused across this addon's routes, but its
cache is not shared with the host or other addons. Calls to the client's
`invalidateQueries()` and `refetchQueries()` are mirrored to the host.

```typescript
import type { QueryClient } from "@wealthfolio/addon-sdk";

const queryClient = ctx.api.query.getClient() as QueryClient;

// Use standard React Query methods
const accounts = await queryClient.fetchQuery({
  queryKey: ["accounts"],
  queryFn: () => ctx.api.accounts.getAll(),
});
```

#### `invalidateQueries(queryKey: string | string[]): void`

Invalidates queries to trigger refetch.

```typescript
// Invalidate specific query
ctx.api.query.invalidateQueries(["accounts"]);

// Invalidate multiple related queries
ctx.api.query.invalidateQueries(["portfolio", "holdings"]);

// Invalidate all account-related queries
ctx.api.query.invalidateQueries(["accounts"]);
```

#### `refetchQueries(queryKey: string | string[]): void`

Triggers immediate refetch of queries.

```typescript
// Refetch portfolio data
ctx.api.query.refetchQueries(["portfolio"]);

// Refetch multiple queries
ctx.api.query.refetchQueries(["accounts", "holdings"]);
```

### Integration with Events

Combine Query API with event listeners for reactive data updates:

```typescript
export default function enable(ctx: AddonContext) {
  // Invalidate relevant queries when portfolio updates
  const unlistenPortfolio = await ctx.api.events.portfolio.onUpdateComplete(
    () => {
      ctx.api.query.invalidateQueries(["portfolio", "holdings", "performance"]);
    },
  );

  // Invalidate market data queries when sync completes
  const unlistenMarket = await ctx.api.events.market.onSyncComplete(() => {
    ctx.api.query.invalidateQueries(["quotes", "assets"]);
  });

  ctx.onDisable(() => {
    unlistenPortfolio();
    unlistenMarket();
  });
}
```

---

## UI Integration APIs

### Declarative Navigation (preferred)

Static navigation belongs in `manifest.json`, not in code. The host reads it
into a registry and renders your sidebar entry **without booting the addon**,
which is what enables lazy activation. Two primitives:

```jsonc
"contributes": {
  "routes": [{ "id": "my-addon" }],
  "links": {
    "sidebar": [
      { "id": "my-addon", "route": "my-addon", "label": "My Addon", "icon": "wallet", "order": 100 }
    ]
  }
}
```

- A **route** is a durable addon page — host-renderable before the addon boots,
  and the surface that triggers lazy activation. A route with no link is a legal
  deep-link-only page.
- The host owns its URL namespace: a route with no `path` mounts at
  `/addons/<manifest.id>`. An optional `path` is a relative suffix such as
  `reports/:year`; absolute paths, traversal, queries, and fragments are
  rejected.
- A **link** places a route into a host slot and references a declared route by
  `id`. Only `"sidebar"` is consumed today; unknown slot names are reserved for
  future surfaces.
- **Contract:** the runtime `router.add({ id })` MUST equal the declared
  `contributes.routes[].id`. A mismatch renders a blank "route is not available"
  page.

### Sidebar API

Runtime sidebar registration still exists for **genuinely dynamic** items;
static nav should be declared in the manifest instead.

#### `addItem(config: SidebarItemConfig): SidebarItemHandle`

```typescript
const sidebarItem = ctx.sidebar.addItem({
  id: "my-addon",
  label: "My Addon",
  route: "/addons/my-addon",
  icon: "puzzle-piece", // Optional host icon name; see the migration guide for the full list
  order: 100, // Lower numbers appear first
});

// Remove when addon is disabled
ctx.onDisable(() => {
  sidebarItem.remove();
});
```

### Router API

Register the component that renders your addon's page. The host owns a single
React root and mounts the component itself.

#### `add(route: RouteConfig): void`

```typescript
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The host mounts the route component with no ctx, so capture it at enable time.
let addonCtx: AddonContext | undefined;

const MyAddonRoute = () => (
  <QueryClientProvider client={addonCtx!.api.query.getClient() as QueryClient}>
    <MyAddonComponent ctx={addonCtx!} />
  </QueryClientProvider>
);

const enable: AddonEnableFunction = (ctx) => {
  addonCtx = ctx;

  // `id` MUST match the declared `contributes.routes[].id`.
  ctx.router.add({
    id: "my-addon",
    path: "/addons/my-addon",
    component: MyAddonRoute,
  });

  ctx.onDisable(() => {
    addonCtx = undefined;
  });
};
```

- **Do not call `createRoot` yourself.** The host owns the root; a per-route
  `createRoot` orphans the React tree so re-renders never reach the DOM (the
  "buttons do nothing" bug). Provide **exactly one** of `component` or `render`;
  if both are set, `component` wins.
- The component receives a `{ location }` prop (`AddonRouteLocation` with
  `pathname/search/hash/params`). The sandbox has **no** react-router provider,
  so do not call `useLocation()` / `useParams()` — read `location` from props.
- `render` still exists as a legacy/imperative escape hatch (it receives
  `{ root, location }` and you mount into `root` yourself), but `component` is
  preferred.

---

## Activities API

Create, update, search, and import activities. These methods require the
corresponding functions in the `activities` permission.

### Methods

#### `getAll(accountId?: string): Promise<ActivityDetails[]>`

Gets all activities, optionally filtered to one account.

```typescript
const activities = await ctx.api.activities.getAll("account-123");
```

#### `search(page: number, pageSize: number, filters: ActivitySearchFilters, searchKeyword: string, sort?: ActivitySort): Promise<ActivitySearchResponse>`

Searches activities with pagination, filters, and one optional sort.

- `page`: Zero-based page index. Use `0` for the first page.
- `filters`: Accepts a string or array for `accountIds` and `activityTypes`.
  Empty values are ignored.
- `searchKeyword`: Free-form keyword search; pass an empty string when unused.
- `sort`: Defaults to `{ id: "date", desc: true }` when omitted.

```typescript
const { data, meta } = await ctx.api.activities.search(
  0,
  50,
  {
    accountIds: "account-1",
    activityTypes: ["BUY", "DIVIDEND"],
    symbol: "AAPL",
  },
  "",
  { id: "date", desc: true },
);

console.log(meta.totalRowCount);
```

#### `create(activity: ActivityCreate): Promise<Activity>`

Creates an activity. Wealthfolio 3.8 adds the optional `status` and
`needsReview` fields to `ActivityCreate`.

```typescript
const activity = await ctx.api.activities.create({
  accountId: "account-123",
  activityType: "BUY",
  activityDate: "2026-09-04",
  asset: { symbol: "AAPL" },
  quantity: 100,
  unitPrice: 150.5,
  currency: "USD",
  status: "POSTED",
  needsReview: false,
});
```

#### `update(activity: ActivityUpdate): Promise<Activity>`

Updates an activity. Wealthfolio 3.8 adds the optional `status` and
`needsReview` fields. Omit `asset` to preserve the current asset association;
pass `asset: {}` to clear it.

```typescript
const updated = await ctx.api.activities.update({
  ...editableActivity, // ActivityUpdate
  quantity: 150,
  unitPrice: 145.75,
  needsReview: false,
});
```

Addons using the review fields or asset patch semantics must set
`minWealthfolioVersion` to `3.8.0` or newer.

#### `saveMany(request: ActivityBulkMutationRequest): Promise<ActivityBulkMutationResult>`

Creates, updates, and deletes activities in one request.

```typescript
const result = await ctx.api.activities.saveMany({
  creates: [
    {
      accountId: "account-123",
      activityType: "DIVIDEND",
      activityDate: "2026-09-04",
      amount: 25,
      currency: "USD",
    },
  ],
  updates: [],
  deleteIds: [],
});
```

#### `import(activities: ActivityImport[]): Promise<ImportActivitiesResult>`

Imports validated activities with duplicate detection and returns the import
run, imported activities, and summary.

```typescript
const result = await ctx.api.activities.import(checkedActivities);
```

Use `isExternal` to identify whether a transfer or credit crosses the tracked
Wealthfolio portfolio boundary. For example, an internal transfer can be
imported explicitly as:

```typescript
const internalTransfer: ActivityImport = {
  accountId: "account-123",
  activityType: "TRANSFER_IN",
  date: "2026-09-04",
  currency: "USD",
  amount: 100,
  symbol: "",
  isExternal: false,
  isValid: true,
  isDraft: false,
};
```

`false` means the activity stays within the tracked portfolio boundary; `true`
means it crosses that boundary. Do not set `false` for every transfer: when
omitted, `TRANSFER_IN` and `TRANSFER_OUT` default to internal at the portfolio
boundary. For `CREDIT`, omission keeps the subtype default (`BONUS` is external;
other credit subtypes are internal).

#### `checkImport(activities: ActivityImport[]): Promise<ActivityImport[]>`

Validates and normalizes activities without importing them.

```typescript
const validated = await ctx.api.activities.checkImport(activities);
```

#### `getImportMapping(accountId: string, contextKind?: string): Promise<ImportMappingData>`

Gets import mapping configuration for an account. `contextKind` defaults to
`"ACTIVITY"`.

```typescript
const mapping = await ctx.api.activities.getImportMapping("account-123");
```

#### `saveImportMapping(mapping: ImportMappingData): Promise<ImportMappingData>`

Saves import mapping configuration.

```typescript
const savedMapping = await ctx.api.activities.saveImportMapping(mapping);
```

#### `getTransferPair(activityId: string): Promise<InternalTransferPairResponse | null>`

Get the linked transfer pair for a given activity. Returns `null` when the
activity has no pair; rejects only on failure, such as an unknown activity id.

```typescript
const pair = await ctx.api.activities.getTransferPair("activity-123");

if (pair) {
  const { transferOut, transferIn } = pair;
}
```

#### `findTransferMatchCandidates(request: TransferMatchCandidateRequest): Promise<TransferMatchCandidate[]>`

Find candidate activities that could be the opposite leg of a transfer.

```typescript
const candidates = await ctx.api.activities.findTransferMatchCandidates({
  activityId: "activity-123",
  windowDays: 7,
});
```

#### `saveTransferPair(request: InternalTransferPairRequest): Promise<InternalTransferPairResponse>`

Create or update an internal transfer pair, linking two activities via a shared
source group.

Omit both leg ids to create a pair:

```typescript
const pair = await ctx.api.activities.saveTransferPair({
  fromAccountId: "account-123",
  toAccountId: "account-456",
  activityDate: "2026-01-01",
  sourceAmount: 500,
  destinationAmount: 500,
  sourceCurrency: "USD",
  destinationCurrency: "USD",
});
```

Pass both to update an existing one:

```typescript
const updated = await ctx.api.activities.saveTransferPair({
  transferOutId: pair.transferOut.id,
  transferInId: pair.transferIn.id,
  fromAccountId: "account-123",
  toAccountId: "account-456",
  activityDate: "2026-01-02",
  sourceAmount: 750,
  destinationAmount: 750,
  sourceCurrency: "USD",
  destinationCurrency: "USD",
});
```

Pass both leg ids or neither. Passing only one is a type error.

#### `linkTransfer(activityAId: string, activityBId: string): Promise<[Activity, Activity]>`

Link two existing activities together as a transfer pair.

```typescript
const [a, b] = await ctx.api.activities.linkTransfer(
  "activity-123",
  "activity-456",
);
```

#### `unlinkTransfer(activityAId: string, activityBId: string): Promise<[Activity, Activity]>`

Unlink two activities that were previously paired as a transfer.

```typescript
const [a, b] = await ctx.api.activities.unlinkTransfer(
  "activity-123",
  "activity-456",
);
```

---

## Error Handling

Host API failures reject their promise with an error. Handle failures at the
user action boundary and show a useful message without exposing financial data.

```typescript
try {
  const accounts = await ctx.api.accounts.getAll();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  ctx.api.logger.error(`Unable to load accounts: ${message}`);
  ctx.api.toast.error("Unable to load accounts");
}
```

---

## Advanced Usage

### Batch Operations

```typescript
// Efficient batch processing
const activities = await Promise.all([
  ctx.api.activities.getAll("account-1"),
  ctx.api.activities.getAll("account-2"),
  ctx.api.activities.getAll("account-3"),
]);

// You can also scope results to a single account by passing its ID as a string.
// The host normalizes this for both desktop (Tauri) and web modes—no need to
// wrap the value in an array.

// Activity search accepts single values or arrays for filters.
const { data, meta } = await ctx.api.activities.search(
  0,
  50,
  {
    accountIds: "account-1", // single string or string[] both work
    activityTypes: ["BUY", "DIVIDEND"],
    symbol: "AAPL", // optional exact symbol filter
  },
  "", // optional search keyword
  { id: "date", desc: true },
);

console.log(meta.totalRowCount);

// Batch create
const result = await ctx.api.activities.saveMany({
  creates: [
    {
      accountId: "account-1",
      activityType: "DEPOSIT",
      activityDate: "2026-09-04",
      amount: 1000,
      currency: "USD",
    },
  ],
});
```

### Real-time Updates

```typescript
export default async function enable(ctx: AddonContext) {
  // Listen for multiple events
  const unsubscribers = [
    await ctx.api.events.portfolio.onUpdateComplete(() => refreshData()),
    await ctx.api.events.market.onSyncComplete(() => updatePrices()),
    await ctx.api.events.import.onDrop((event) => handleImport(event)),
  ];

  // Clean up all listeners
  ctx.onDisable(() => {
    unsubscribers.forEach((unsub) => unsub());
  });
}
```

### Caching Strategies

```typescript
// Simple in-memory cache
const cache = new Map();

async function getCachedAccounts() {
  if (cache.has("accounts")) {
    return cache.get("accounts");
  }

  const accounts = await ctx.api.accounts.getAll();
  cache.set("accounts", accounts);

  // Invalidate cache on updates
  const unlisten = await ctx.api.events.portfolio.onUpdateComplete(() => {
    cache.delete("accounts");
  });

  return accounts;
}
```

---

## TypeScript Support

Full TypeScript definitions are provided for all APIs:

```typescript
import type {
  AddonContext,
  Account,
  Activity,
  Holding,
  PerformanceResult,
  PerformanceSummary,
  // ... and many more
} from "@wealthfolio/addon-sdk";

// Type-safe API usage
const accounts: Account[] = await ctx.api.accounts.getAll();
const holdings: Holding[] = await ctx.api.portfolio.getHoldings(accounts[0].id);
```

## Performance Tips

1. **Use batch operations** when possible
2. **Implement caching** for expensive operations
3. **Listen to relevant events only**
4. **Clean up resources** in disable function
5. **Use React.memo** for expensive components
6. **Debounce user inputs** for search/filter

---

**Ready to build?** Check out the
[official addon examples](https://github.com/wealthfolio/wealthfolio-addons/tree/main/official)
to see these APIs in action.

---

## Performance API

Calculate portfolio and account performance metrics with historical analysis.
`returns.irr` is the selected-period money-weighted return.
`returns.annualizedIrr` is the annualized XIRR on the same dated cash flows.

### Methods

#### `calculateHistory(itemType: 'account' | 'symbol', itemId: string, startDate?: string, endDate?: string): Promise<PerformanceResult>`

Calculates detailed performance history for charts and analysis.

```typescript
const history = await ctx.api.performance.calculateHistory(
  "account",
  "account-123",
  "2024-01-01",
  "2024-12-31",
);
console.log(history.returns.twr, history.returns.irr, history.series);
```

#### `calculateSummary(args: { itemType: 'account' | 'symbol'; itemId: string; startDate?: string | null; endDate?: string | null; }): Promise<PerformanceResult>`

Calculates comprehensive performance summary with key metrics.

```typescript
const summary = await ctx.api.performance.calculateSummary({
  itemType: "account",
  itemId: "account-123",
  startDate: "2024-01-01",
  endDate: "2024-12-31",
});
console.log(
  summary.returns.twr ?? summary.returns.valueReturn,
  summary.returns.irr,
  summary.risk.maxDrawdown,
);
```

#### `calculateAccountsSimple(accountIds: string[]): Promise<SimplePerformanceResult[]>`

Calculates simple performance metrics for multiple accounts efficiently.

```typescript
const performance = await ctx.api.performance.calculateAccountsSimple([
  "account-123",
  "account-456",
]);
```

---

## Exchange Rates API

Manage currency exchange rates for multi-currency portfolios.

### Methods

#### `getAll(): Promise<ExchangeRate[]>`

Gets all exchange rates.

```typescript
const rates = await ctx.api.exchangeRates.getAll();
```

#### `update(updatedRate: ExchangeRate): Promise<ExchangeRate>`

Updates an existing exchange rate.

```typescript
const updatedRate = await ctx.api.exchangeRates.update({
  id: "rate-123",
  fromCurrency: "USD",
  toCurrency: "EUR",
  rate: 0.85,
  source: "MANUAL",
  timestamp: "2024-12-01T00:00:00Z",
});
```

#### `add(newRate: Omit<ExchangeRate, 'id'>): Promise<ExchangeRate>`

Adds a new exchange rate.

```typescript
const newRate = await ctx.api.exchangeRates.add({
  fromCurrency: "USD",
  toCurrency: "GBP",
  rate: 0.75,
  source: "MANUAL",
  timestamp: "2024-12-01T00:00:00Z",
});
```

#### `getRatesForDates(pairs: ExchangeRateDateQuery[]): Promise<ExchangeRateDateResult[]>`

Gets one resolved exchange rate for each requested currency pair and date. Dates
must use `YYYY-MM-DD`. Resolution follows Wealthfolio's standard FX rules,
including currency normalization, inverse and triangulated rates, nearest-date
lookup, and latest-rate fallback. The returned rate is therefore not guaranteed
to come from an exact quote on the requested date.

Results preserve the input order. A pair that cannot be resolved returns
`rate: null` and an `error` without failing the rest of the batch.

This method requires Wealthfolio 3.8 or newer. Addons using it must set
`minWealthfolioVersion` to `3.8.0` or newer.

```typescript
const results = await ctx.api.exchangeRates.getRatesForDates([
  { fromCurrency: "USD", toCurrency: "EUR", date: "2024-01-15" },
  { fromCurrency: "CAD", toCurrency: "JPY", date: "2024-01-15" },
]);

for (const result of results) {
  if (result.rate !== null) {
    console.log(result.fromCurrency, result.toCurrency, result.rate);
  } else {
    console.error(result.error);
  }
}
```

---

## Spend Categorization API

Classify activities (e.g. `WITHDRAWAL`s) into the user's existing spend-category
taxonomy via Wealthfolio's categorization-rules engine, instead of a one-off
per-activity tag. A rule is reusable — it keeps applying to future matching
imports, not just the activities that exist when it's created.

This API requires Wealthfolio 3.8 or newer and the medium-risk `spending`
permission. Declare only the methods your addon calls from `isEnabled`,
`getCategories`, `getRules`, `saveRule`, `deleteRule`, and `rerunRules`.

`kind` selects which of Wealthfolio's three fixed activity-scope taxonomies a
category or rule belongs to: `"expense"`, `"income"`, or `"saving"`. Asset
classification taxonomies aren't reachable through this API.

### Methods

#### `isEnabled(): Promise<boolean>`

Whether the user has Spending enabled. Categories and rules still work when it's
off, but `rerunRules()` is a no-op until the user opts an account in — check
this to explain a result of `0`.

```typescript
if (!(await ctx.api.spending.isEnabled())) {
  // Nudge the user to enable Spending before offering categorization.
}
```

#### `getCategories(kind?: SpendCategoryKind): Promise<SpendCategory[]>`

Lists selectable spend categories, flattened with a display path. Omit `kind` to
load all three taxonomies at once.

```typescript
const categories = await ctx.api.spending.getCategories("expense");
// [{ kind: "expense", taxonomyId: "spending_categories", categoryId: "cat_groceries",
//    key: "groceries", name: "Groceries", path: "Food & Dining / Groceries" }, ...]
```

#### `getRules(): Promise<CategorizationRule[]>`

Lists this addon's own categorization rules — the ones created via `saveRule`.
Use this to reconcile after a user deletes one of your rules from Wealthfolio's
own Settings → Spending → Rules UI.

```typescript
const rules = await ctx.api.spending.getRules();
```

#### `saveRule(rule: CategorizationRuleInput): Promise<CategorizationRule>`

Creates or updates a categorization rule identified by `rule.ruleKey`. Calling
this again with the same `ruleKey` (typically a stable id you already persist in
your own addon settings) updates the existing rule in place instead of creating
a duplicate — safe to call on every settings save.

```typescript
const saved = await ctx.api.spending.saveRule({
  ruleKey: "my-addon-rule-1", // a stable key you choose and reuse
  name: "Groceries via MyBank",
  pattern: "MYBANK GROCERY",
  matchType: "contains", // "contains" | "starts_with" | "exact" | "regex"
  kind: "expense",
  categoryId: "cat_groceries",
  activityType: "WITHDRAWAL", // omit to match any activity type
  accountId: "account-123", // omit for a rule that applies to all accounts
});
```

#### `deleteRule(ruleKey: string): Promise<void>`

Deletes the rule previously created with this `ruleKey`. No-op if no matching
rule exists.

```typescript
await ctx.api.spending.deleteRule("my-addon-rule-1");
```

#### `rerunRules(onlyUncategorized?: boolean): Promise<number>`

Re-runs all categorization rules and returns the number of activities matched by
a rule. Defaults to `true`, which only fills in currently uncategorized
activities. Pass `false` to also overwrite existing rule/AI/history/import-
assigned categories. Manual assignments are always preserved. Call this after an
import so newly created activities pick up matching rules, since a rule only
recategorizes existing activities at the moment it's created or updated.

```typescript
const matched = await ctx.api.spending.rerunRules();
```

---

## Contribution Limits API

Manage investment contribution limits and calculations.

### Methods

#### `getAll(): Promise<ContributionLimit[]>`

Gets all contribution limits.

```typescript
const limits = await ctx.api.contributionLimits.getAll();
```

#### `create(newLimit: NewContributionLimit): Promise<ContributionLimit>`

Creates a new contribution limit.

```typescript
const limit = await ctx.api.contributionLimits.create({
  groupName: "RRSP",
  contributionYear: 2024,
  limitAmount: 30000,
});
```

#### `update(id: string, updatedLimit: NewContributionLimit): Promise<ContributionLimit>`

Updates an existing contribution limit.

```typescript
const updatedLimit = await ctx.api.contributionLimits.update("limit-123", {
  groupName: "RRSP",
  contributionYear: 2024,
  limitAmount: 31000,
});
```

#### `calculateDeposits(limitId: string): Promise<DepositsCalculation>`

Calculates deposits for a specific contribution limit.

```typescript
const deposits =
  await ctx.api.contributionLimits.calculateDeposits("limit-123");
```

---

## Goals API

Manage financial goals and allocations.

### Methods

#### `getAll(): Promise<Goal[]>`

Gets all goals.

```typescript
const goals = await ctx.api.goals.getAll();
```

#### `create(goal: unknown): Promise<Goal>`

Creates a new goal.

```typescript
const goal = await ctx.api.goals.create({
  goalType: "retirement",
  title: "Retirement Fund",
  targetAmount: 500000,
  targetDate: "2040-01-01",
});
```

#### `update(goal: Goal): Promise<Goal>`

Updates an existing goal.

```typescript
const updatedGoal = await ctx.api.goals.update({
  ...existingGoal,
  targetAmount: 600000,
});
```

#### `getFunding(goalId: string): Promise<GoalAllocation[]>`

Gets funding rules for a goal.

```typescript
const allocations = await ctx.api.goals.getFunding("goal-123");
```

#### `saveFunding(goalId: string, rules: GoalAllocation[]): Promise<GoalAllocation[]>`

Saves funding rules for a goal.

```typescript
await ctx.api.goals.saveFunding("goal-123", [
  {
    id: "allocation-123",
    goalId: "goal-123",
    accountId: "account-456",
    sharePercent: 50,
  },
]);
```

#### `updateAllocations(allocations: GoalAllocation[]): Promise<void>`

Updates goal allocations.

Deprecated: use `saveFunding(goalId, allocations)` instead.

```typescript
await ctx.api.goals.updateAllocations([
  {
    id: "allocation-123",
    goalId: "goal-123",
    accountId: "account-456",
    sharePercent: 50,
  },
  // ... other allocations
]);
```

#### `getAllocations(): Promise<GoalAllocation[]>`

Gets goal allocations.

Deprecated: use `getAll()` and `getFunding(goalId)` instead.

```typescript
const allocations = await ctx.api.goals.getAllocations();
```

---

## Settings API

Manage application settings and configuration.

### Methods

#### `get(): Promise<Settings>`

Gets application settings.

```typescript
const settings = await ctx.api.settings.get();
```

#### `update(settingsUpdate: Partial<Settings>): Promise<Settings>`

Updates application settings.

```typescript
const updatedSettings = await ctx.api.settings.update({
  baseCurrency: "EUR",
});
```

#### `backupDatabase(): Promise<{ filename: string }>`

Creates a database backup.

```typescript
const backup = await ctx.api.settings.backupDatabase();
```

---

## Files API

Handle file operations and dialogs.

### Methods

#### `openCsvDialog(): Promise<null | string | string[]>`

Opens a CSV file selection dialog.

```typescript
const files = await ctx.api.files.openCsvDialog();
if (files) {
  // Process selected files
}
```

#### `openSaveDialog(fileContent: Uint8Array | Blob | string, fileName: string): Promise<unknown>`

Opens a file save dialog.

```typescript
const result = await ctx.api.files.openSaveDialog(fileContent, "export.csv");
```

---

## Storage API

Durable, per-addon key/value storage. This is a **baseline capability** (no
permission declaration needed) and the correct replacement for `localStorage`,
which throws inside the sandbox. Values survive addon updates, are cleared on
uninstall, and replicate across paired devices.

### Methods

#### `get(key: string): Promise<string | null>`

Reads a stored value, or `null` if the key is unset.

```typescript
const raw = await ctx.api.storage.get("prefs");
const prefs = raw ? JSON.parse(raw) : defaults;
```

#### `set(key: string, value: string): Promise<void>`

Writes a value. Keys are ≤128 chars from the charset `[A-Za-z0-9_.:-]`; values
are ≤1 MiB. Serialize objects yourself (e.g. with `JSON.stringify`).

```typescript
await ctx.api.storage.set("prefs", JSON.stringify(prefs));
```

#### `delete(key: string): Promise<void>`

Removes a stored value.

```typescript
await ctx.api.storage.delete("prefs");
```

> **Info** **Storage vs. Secrets**: use `storage` for ordinary addon preferences
> and state; use `secrets` (below) for sensitive tokens and API keys, which are
> encrypted at rest.

---

## Secrets API

Securely store and retrieve sensitive data like API keys and tokens. All data is
scoped to your addon for security.

### Methods

#### `set(key: string, value: string): Promise<void>`

Stores a secret value encrypted and scoped to your addon.

```typescript
// Store API key securely
await ctx.api.secrets.set("api-key", "your-secret-api-key");

// Store user credentials
await ctx.api.secrets.set("auth-token", userAuthToken);
```

#### `get(key: string): Promise<string | null>`

Retrieves a secret value (returns null if not found).

```typescript
const apiKey = await ctx.api.secrets.get("api-key");
if (apiKey) {
  const response = await ctx.api.network.request({
    url: "https://api.example.com/data",
    auth: { type: "bearer", secretKey: "api-key" },
  });
}
```

Prefer brokered `ctx.api.network.request()` over reading a secret into addon
JavaScript. The request host must be declared in `network.allowedHosts` and its
response body is text, not a binary transport.

#### `delete(key: string): Promise<void>`

Permanently deletes a secret.

```typescript
await ctx.api.secrets.delete("old-api-key");
```

> **Info** **Security Note**: Secrets are encrypted at rest and scoped to your
> addon. Other addons cannot access your secrets, and you cannot access theirs.

---

## Logger API

Provides logging functionality with automatic addon prefix.

### Methods

#### `error(message: string): void`

Logs an error message.

```typescript
ctx.api.logger.error("Failed to fetch data from API");
```

#### `info(message: string): void`

Logs an informational message.

```typescript
ctx.api.logger.info("Data sync completed successfully");
```

#### `warn(message: string): void`

Logs a warning message.

```typescript
ctx.api.logger.warn("API rate limit approaching");
```

#### `debug(message: string): void`

Logs a debug message.

```typescript
ctx.api.logger.debug("Processing 100 activities");
```

#### `trace(message: string): void`

Logs a trace message for detailed debugging.

```typescript
ctx.api.logger.trace("Entering function processActivity");
```

---

## Event System

Listen to real-time events for responsive addon behavior.

### Portfolio Events

#### `onUpdateStart(callback: EventCallback): Promise<UnlistenFn>`

Fires when portfolio update starts.

```typescript
const unlistenStart = await ctx.api.events.portfolio.onUpdateStart((event) => {
  console.log("Portfolio update started");
  showLoadingIndicator();
});
```

#### `onUpdateComplete(callback: EventCallback): Promise<UnlistenFn>`

Fires when portfolio calculations are updated.

```typescript
const unlistenPortfolio = await ctx.api.events.portfolio.onUpdateComplete(
  (event) => {
    console.log("Portfolio updated:", event.payload);
    // Refresh your addon's data
    refreshPortfolioData();
  },
);

// Clean up on disable
ctx.onDisable(() => {
  unlistenPortfolio();
});
```

#### `onUpdateError(callback: EventCallback): Promise<UnlistenFn>`

Fires when portfolio update encounters an error.

```typescript
const unlistenError = await ctx.api.events.portfolio.onUpdateError((event) => {
  console.error("Portfolio update failed:", event.payload);
  showErrorMessage();
});
```

### Market Events

#### `onSyncStart(callback: EventCallback): Promise<UnlistenFn>`

Fires when market data sync starts.

```typescript
const unlistenSyncStart = await ctx.api.events.market.onSyncStart(() => {
  console.log("Market sync started");
  showSyncIndicator();
});
```

#### `onSyncComplete(callback: EventCallback): Promise<UnlistenFn>`

Fires when market data sync is completed.

```typescript
const unlistenMarket = await ctx.api.events.market.onSyncComplete(() => {
  console.log("Market data updated!");
  // Update price displays
  updatePriceDisplays();
});
```
