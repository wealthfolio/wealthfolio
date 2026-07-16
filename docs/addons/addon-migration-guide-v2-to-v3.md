# Migration Guide: Wealthfolio Addons v2 to v3

This guide covers all changes needed to migrate your Wealthfolio addon from v2
to v3.

> **Targeting Wealthfolio 3.6 or later?** The addon runtime moved to an isolated
> sandbox iframe in 3.6, which changed route registration (`component` →
> `render`), React access, and bundling. After finishing this v2 → v3 migration,
> follow the
> [v3.5 → v3.6 migration guide](./addon-migration-guide-v3.5-to-v3.6.md). The
> `component: React.lazy(...)` examples below are the pre-3.6 form and no longer
> work on 3.6+.

## Overview

| Aspect        | v2        | v3         |
| ------------- | --------- | ---------- |
| SDK Version   | `2.0.0`   | `3.0.0`    |
| React Version | `19.1.1`  | `19.2.4`   |
| Route Prefix  | `/addon/` | `/addons/` |

---

## 1. Update manifest.json

Change the `sdkVersion` in your manifest:

```json
// v2
{
  "sdkVersion": "2.0.0"
}

// v3
{
  "sdkVersion": "3.0.0"
}
```

Also update your addon version:

```json
{
  "version": "2.0.0"
}
```

---

## 2. Update package.json

Update the `@wealthfolio/addon-sdk` dependency and devDependencies:

### 2.1 Peer Dependencies

```json
// v2
{
  "peerDependencies": {
    "react": "^19.1.1",
    "react-dom": "^19.1.1"
  }
}

// v3
{
  "peerDependencies": {
    "react": "^19.2.4",
    "react-dom": "^19.2.4"
  }
}
```

### 2.2 Dev Dependencies

```json
// v2
{
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.13",
    "@types/node": "^20.0.0",
    "@types/react": "^19.1.1",
    "@types/react-dom": "^19.1.1",
    "rollup-plugin-external-globals": "^0.13.0",
    "tailwindcss": "^4.1.13",
    "typescript": "^5.9.2",
    "vite": "^7.1.5"
  }
}

// v3
{
  "devDependencies": {
    "@tailwindcss/vite": "^4.1.18",
    "@types/node": "^20.19.33",
    "@types/react": "^19.2.13",
    "@types/react-dom": "^19.2.3",
    "@vitejs/plugin-react": "^4.3.4",
    "rollup-plugin-external-globals": "^0.13.0",
    "tailwindcss": "^4.1.18",
    "typescript": "^5.9.3",
    "vite": "^7.3.1",
    "clsx": "^2.1.1",
    "tailwind-merge": "^3.4.0"
  }
}
```

Key changes:

- Updated Tailwind CSS from `^4.1.13` to `^4.1.18`
- Added `@vitejs/plugin-react` (required for React support)
- Added `clsx` and `tailwind-merge` (commonly used utilities)
- Updated all `@types/react*` versions
- Updated Vite to `^7.3.1`

---

## 3. Tailwind CSS v4 Changes

Wealthfolio v3 uses Tailwind CSS v4. While the addon system uses the host app's
Tailwind configuration, there are some important considerations:

### 3.1 CSS Import Syntax

v4 uses the new `@import` syntax:

```css
/* v2/v3 - Use this syntax */
@import "tailwindcss";
```

### 3.2 No Configuration File Needed

In Tailwind v4, you don't need a `tailwind.config.js` file. The configuration is
done via CSS:

```css
/* globals.css in the host app */
@theme {
  --color-primary: #your-color;
  --font-sans: "Inter", sans-serif;
}
```

### 3.3 Custom Variants for Dark Mode

v4 uses a new dark mode variant syntax:

```css
/* v4 syntax */
@custom-variant dark (&:where(.dark, .dark *));
```

### 3.4 Custom Utilities

In v4, custom utilities are defined using `@utility`:

```css
@utility scrollbar-hide {
  scrollbar-width: none;
  -ms-overflow-style: none;
  &::-webkit-scrollbar {
    display: none;
  }
}
```

### 3.5 Using @wealthfolio/ui

Addons should use the `@wealthfolio/ui` package which provides pre-built
components styled with the host app's theme. The UI package exports components
that automatically inherit the host app's:

- Color palette (semantic colors like `primary`, `secondary`, etc.)
- Typography
- Spacing
- Border radius

```typescript
// Your addon can use UI components directly
import { Button, Card, Page } from "@wealthfolio/ui";
```

### 3.6 Using Tailwind Classes

Addons can use all standard Tailwind utility classes. The host app provides a
custom theme via CSS variables that your addon classes will automatically
inherit:

```typescript
// These classes will automatically use the host app's theme
function MyComponent() {
  return (
    <div className="bg-background text-foreground p-4 rounded-lg border-border">
      <h1 className="text-primary font-semibold">Title</h1>
    </div>
  );
}
```

---

## 4. API Changes

### 3.1 Market API

The `sync` function now uses `assetIds` instead of `symbols`:

```typescript
// v2
await ctx.api.market.sync(["AAPL", "MSFT"], true);

// v3
await ctx.api.market.sync(["asset-id-1", "asset-id-2"], true);
// or with recent days refetch
await ctx.api.market.sync(["asset-id-1"], true, 7);
```

The return type changed from `QuoteSummary[]` to `SymbolSearchResult[]`:

```typescript
// v2
const results = await ctx.api.market.searchTicker("AAPL");
// QuoteSummary[]

// v3
const results = await ctx.api.market.searchTicker("AAPL");
// SymbolSearchResult[] - has additional fields: exchangeMic, currency, assetKind, isExisting, existingAssetId
```

### 3.2 Assets API

`updateDataSource` replaced with `updateQuoteMode`:

```typescript
// v2
await ctx.api.assets.updateDataSource("AAPL", "MANUAL");

// v3
await ctx.api.assets.updateQuoteMode("asset-id", "MANUAL");
```

### 3.3 Quotes API

Methods now use `assetId` instead of `symbol`:

```typescript
// v2
await ctx.api.quotes.update('AAPL', { close: 150.00, ... });
const history = await ctx.api.quotes.getHistory('AAPL');

// v3
await ctx.api.quotes.update('asset-id', { close: 150.00, ... });
const history = await ctx.api.quotes.getHistory('asset-id');
```

---

## 4. Data Type Changes

### 4.1 ActivityType

The activity types now include additional types and use string values for
quantities:

```typescript
// v2 - 13 types
const ActivityType = {
  BUY: "BUY",
  SELL: "SELL",
  DIVIDEND: "DIVIDEND",
  INTEREST: "INTEREST",
  DEPOSIT: "DEPOSIT",
  WITHDRAWAL: "WITHDRAWAL",
  ADD_HOLDING: "ADD_HOLDING",
  REMOVE_HOLDING: "REMOVE_HOLDING",
  TRANSFER_IN: "TRANSFER_IN",
  TRANSFER_OUT: "TRANSFER_OUT",
  FEE: "FEE",
  TAX: "TAX",
  SPLIT: "SPLIT",
};

// v3 - 15 types (added CREDIT, ADJUSTMENT, UNKNOWN)
const ActivityType = {
  BUY: "BUY",
  SELL: "SELL",
  SPLIT: "SPLIT",
  DIVIDEND: "DIVIDEND",
  INTEREST: "INTEREST",
  DEPOSIT: "DEPOSIT",
  WITHDRAWAL: "WITHDRAWAL",
  TRANSFER_IN: "TRANSFER_IN",
  TRANSFER_OUT: "TRANSFER_OUT",
  FEE: "FEE",
  TAX: "TAX",
  CREDIT: "CREDIT",
  ADJUSTMENT: "ADJUSTMENT",
  UNKNOWN: "UNKNOWN",
};
```

### 4.2 Activity Interface

Key changes to the Activity interface:

```typescript
// v2
interface Activity {
  id: string;
  type: ActivityType;
  date: Date | string;
  quantity: number;
  unitPrice: number;
  currency: string;
  fee: number;
  isDraft: boolean;
  comment?: string;
  accountId?: string | null;
  symbolProfileId: string;
}

// v3 - uses strings for precision, has activityType + activityTypeOverride
interface Activity {
  id: string;
  accountId: string;
  assetId?: string; // NOW OPTIONAL for pure cash events

  activityType: string; // Canonical type (closed set of 15)
  activityTypeOverride?: string; // User override
  sourceType?: string; // Raw provider label
  subtype?: string; // Semantic variation (DRIP, STAKING_REWARD, etc.)
  status: ActivityStatus;

  activityDate: string; // ISO timestamp (UTC)

  quantity?: string; // STRING to preserve precision
  unitPrice?: string;
  amount?: string;
  fee?: string;
  currency: string;
  fxRate?: string;

  isUserModified: boolean;
  needsReview: boolean;
  // ... more fields
}
```

### 4.3 Asset Interface

The Asset interface has been redesigned around identity:

```typescript
// v2 - uses symbol as primary identity
interface Asset {
  id: string;
  symbol: string;
  name?: string;
  assetType?: string;
  // ...
}

// v3 - identity is opaque (UUID), classification via kind and instrumentType
interface Asset {
  id: string;

  // Classification
  kind: AssetKind; // INVESTMENT, PROPERTY, VEHICLE, COLLECTIBLE, etc.
  name?: string;
  displayCode?: string; // User-visible ticker/label

  // Valuation
  quoteMode: QuoteMode; // MARKET or MANUAL
  quoteCcy: string;

  // Instrument identity (null for non-market assets)
  instrumentType?: string; // EQUITY, CRYPTO, FX, OPTION, METAL
  instrumentSymbol?: string; // Canonical symbol (AAPL, BTC, EUR)
  instrumentExchangeMic?: string;
  // ...
}
```

### 4.4 Holding Interface

```typescript
// v3 - adds assetKind
interface Holding {
  id: string;
  holdingType: HoldingType;
  accountId: string;
  instrument?: Instrument | null;
  assetKind?: AssetKind | null; // NEW in v3
  // ... rest same
}
```

### 4.5 New Types in v3

v3 introduces several new types:

```typescript
// AssetKind - how the asset behaves
const AssetKind = {
  INVESTMENT: "INVESTMENT",
  PROPERTY: "PROPERTY",
  VEHICLE: "VEHICLE",
  COLLECTIBLE: "COLLECTIBLE",
  PRECIOUS_METAL: "PRECIOUS_METAL",
  PRIVATE_EQUITY: "PRIVATE_EQUITY",
  LIABILITY: "LIABILITY",
  OTHER: "OTHER",
  FX: "FX",
};

// QuoteMode - how price is determined
const QuoteMode = {
  MARKET: "MARKET",
  MANUAL: "MANUAL",
};

// ActivityStatus
const ActivityStatus = {
  POSTED: "POSTED",
  PENDING: "PENDING",
  DRAFT: "DRAFT",
  VOID: "VOID",
};

// ActivitySubtypes
const ACTIVITY_SUBTYPES = {
  DRIP: "DRIP",
  QUALIFIED: "QUALIFIED",
  ORDINARY: "ORDINARY",
  STAKING_REWARD: "STAKING_REWARD",
  LENDING_INTEREST: "LENDING_INTEREST",
  COUPON: "COUPON",
  // ... more subtypes
};
```

---

## 6. Route Changes

Routes now use `/addons/` prefix instead of `/addon/`:

```typescript
// v2
ctx.router.add({
  path: "/addon/my-addon",
  component: React.lazy(() => import("./MyPage")),
});

// v3
ctx.router.add({
  path: "/addons/my-addon",
  component: React.lazy(() => import("./MyPage")),
});
```

> **3.6+:** `component` was replaced by a `render` callback that mounts into a
> sandbox-provided DOM node. See
> [Route registration](./addon-migration-guide-v3.5-to-v3.6.md#1-route-registration-component--render).

---

## 7. Permission Changes

The permission categories may have changed. Review your addon permissions and
ensure they still match the v3 categories. The general structure remains the
same:

```json
{
  "permissions": [
    {
      "category": "activities",
      "functions": ["search", "create", "update"],
      "purpose": "Access and manage trading activities"
    }
  ]
}
```

---

## 8. Example Migration

Here's a complete example of migrating an addon from v2 to v3:

### Before (v2):

```typescript
// src/addon.tsx
import { type AddonContext } from "@wealthfolio/addon-sdk";

export default function enable(ctx: AddonContext) {
  ctx.api.logger.info("My addon enabled!");

  // Add sidebar
  const sidebarItem = ctx.sidebar.addItem({
    id: "my-addon",
    label: "My Addon",
    route: "/addon/my-addon", // old route prefix
    order: 150,
  });

  // Register route
  ctx.router.add({
    path: "/addon/my-addon",
    component: React.lazy(() => import("./pages/MainPage")),
  });

  // Fetch holdings (v2 style)
  const holdings = await ctx.api.portfolio.getHoldings(accountId);

  // Update quote (v2 style)
  await ctx.api.quotes.update(symbol, { close: 150.0 });

  ctx.onDisable(() => {
    sidebarItem.remove();
  });
}
```

### After (v3):

```typescript
// src/addon.tsx
import { type AddonContext } from "@wealthfolio/addon-sdk";

export default function enable(ctx: AddonContext) {
  ctx.api.logger.info("My addon enabled!");

  // Add sidebar
  const sidebarItem = ctx.sidebar.addItem({
    id: "my-addon",
    label: "My Addon",
    route: "/addons/my-addon", // new route prefix
    order: 150,
  });

  // Register route
  ctx.router.add({
    path: "/addons/my-addon",
    component: React.lazy(() => import("./pages/MainPage")),
  });

  // Fetch holdings - same API
  const holdings = await ctx.api.portfolio.getHoldings(accountId);

  // Update quote (v3 style - uses assetId)
  await ctx.api.quotes.update(assetId, { close: 150.0 });

  ctx.onDisable(() => {
    sidebarItem.remove();
  });
}
```

> **3.6+:** the `component: React.lazy(...)` route above must become a `render`
> callback, and `React`/`ReactDOM` are no longer SDK exports. See the
> [v3.5 → v3.6 guide](./addon-migration-guide-v3.5-to-v3.6.md) for the updated
> `enable()` shape.

---

## 9. Testing Your Migration

1. **Build the addon**: Ensure the TypeScript compiles without errors
2. **Test in development mode**: Run with wealthfolio with
   `VITE_ENABLE_ADDON_DEV_MODE=true pnpm tauri dev`
3. cd to the addon dir and run your addons with `pnpm dev:server`
4. **Verify routes**: Check that navigation works with the new `/addons/` prefix
5. **Test data fetching**: Ensure all API calls work with the new assetId-based
   APIs

---

## 10. Common Issues

### Issue: Type errors with Activity fields

**Solution**: Use string types for quantity fields (`quantity?: string`) and
check for `activityTypeOverride`

### Issue: Routes not showing

**Solution**: Verify route uses `/addons/` prefix instead of `/addon/`

### Issue: Asset lookup failing

**Solution**: Use `assetId` instead of `symbol` for quotes and market data
operations

---

## 11. Need Help

- Check the [API Reference](./addon-api-reference.md)
- Review the [Architecture Guide](./addon-architecture.md)
- See official addon examples in the
  [wealthfolio-addons repository](https://github.com/wealthfolio/wealthfolio-addons/tree/main/official)
