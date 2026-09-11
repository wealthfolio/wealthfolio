# Wealthfolio Addon Architecture

A straightforward explanation of how Wealthfolio's addon system works.

## What Are Wealthfolio Addons?

Addons are TypeScript modules that extend Wealthfolio's functionality. Each
addon is a JavaScript function that receives an `AddonContext` object and can
register UI components, add navigation items, and access financial data through
APIs.

## Basic Structure

```
┌─────────────────────────────────────────────────────────────────┐
│                    Wealthfolio Host Application                 │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │  Addon Runtime  │  │  Permission     │  │   API Bridge    │  │
│  │                 │  │   System        │  │                 │  │
│  │ • Load/Unload   │  │ • Detection     │  │ • Type Bridge   │  │
│  │ • Lifecycle     │  │ • Validation    │  │ • Domain APIs   │  │
│  │ • Context Mgmt  │  │ • Enforcement   │  │ • Scoped Access │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│                        Individual Addons                        │
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ │
│ │   Addon A   │ │   Addon B   │ │   Addon C   │ │   Addon D   │ │
│ │             │ │             │ │             │ │             │ │
│ │ enable()    │ │ enable()    │ │ enable()    │ │ enable()    │ │
│ │ disable()   │ │ disable()   │ │ disable()   │ │ disable()   │ │
│ │ UI/Routes   │ │ UI/Routes   │ │ UI/Routes   │ │ UI/Routes   │ │
│ │ API Calls   │ │ API Calls   │ │ API Calls   │ │ API Calls   │ │
│ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

The system has two main parts:

- **Host Application**: Manages addon lifecycle, enforces permissions, provides
  APIs
- **Addons**: JavaScript functions that receive context and register
  functionality

## Addon Lifecycle

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│             │    │             │    │             │    │             │
│  ZIP File   │───▶│   Extract   │───▶│  Validate   │───▶│  Analyze    │
│             │    │             │    │             │    │ Permissions │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
                                                                   │
┌─────────────┐    ┌─────────────┐    ┌─────────────┐              │
│             │    │             │    │             │              │
│   Running   │◀───│   Enable    │◀───│    Load     │◀─────────────┘
│             │    │             │    │             │
└─────────────┘    └─────────────┘    └─────────────┘
```

1. **Extract**: Unzip addon package and read files
2. **Validate**: Check manifest.json structure and compatibility
3. **Analyze Permissions**: Scan code for API usage patterns
4. **Load**: Create isolated context with scoped APIs
5. **Enable**: Call addon's enable function
6. **Running**: Addon functionality is active

### Lazy Activation

Addons that declare `contributes.routes` do **not** run at startup. The host
reads their manifests into a **ContributionRegistry** and renders their sidebar
entries and routes without executing any addon code. Step 5 (**Enable**) is
deferred until the user first navigates to one of the addon's routes. Addons
**without** `contributes` remain eager and run at load time. This keeps startup
fast and lets the host draw navigation for addons that have never been opened.

## Addon Context

Each addon receives an isolated context:

```typescript
interface AddonContext {
  ui: { root: HTMLElement };
  sidebar: {
    addItem(config: SidebarItemConfig): SidebarItemHandle;
  };
  router: {
    add(route: RouteConfig): void;
  };
  assets: AddonAssets;
  onDisable(callback: () => void): void;
  api: HostAPI; // Financial data and operations
}
```

The context provides:

- **Sidebar**: Add navigation items
- **Router**: Register new routes/pages
- **UI**: Access the sandbox-owned root element
- **Assets**: Lazily load private files packaged under `assets/` or
  `dist/assets/`
- **onDisable**: Register cleanup functions
- **API**: Access to financial data and operations

## Permission System

### Permission Detection

The system scans addon code during installation to detect API usage:

```typescript
// This code pattern would be detected:
const accounts = await ctx.api.accounts.getAll();
// Detected: accounts.getAll
```

The Rust backend scans for patterns like:

- `ctx.api.accounts.getAll(`
- `api.accounts.getAll(`
- `.api.accounts.getAll(`

### Permission Flow

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│                 │    │                 │    │                 │
│ Static Analysis │───▶│ Declaration     │───▶│ Runtime         │
│                 │    │ Matching        │    │ Validation      │
│ • Scan code     │    │                 │    │                 │
│ • Detect APIs   │    │ • Compare with  │    │ • Check perms   │
│ • Build list    │    │   manifest      │    │ • Allow/Block   │
│                 │    │ • Show dialog   │    │ • Log calls     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### Permission Categories

Based on the actual code, these are the permission categories:

| Category              | Risk Level | Common Functions                                                     |
| --------------------- | ---------- | -------------------------------------------------------------------- |
| `accounts`            | High       | getAll, create                                                       |
| `portfolio`           | High       | getHoldings, getHolding, update, recalculate                         |
| `activities`          | High       | getAll, search, create, update, saveMany, import, linkTransfer       |
| `market-data`         | Low        | searchTicker, syncHistory, sync, getProviders, fetchDividends        |
| `assets`              | Medium     | getProfile, updateProfile, updateQuoteMode                           |
| `quotes`              | Low        | update, getHistory                                                   |
| `performance`         | Medium     | calculateHistory, calculateSummary, calculateAccountsSimple          |
| `currency`            | Low        | getAll, update, add, getRatesForDates                                |
| `spending`            | Medium     | isEnabled, getCategories, getRules, saveRule, deleteRule, rerunRules |
| `financial-planning`  | Medium     | getAll, create, update, getFunding, saveFunding                      |
| `contribution-limits` | Medium     | getAll, create, update, calculateDeposits                            |
| `settings`            | Medium     | get, update, backupDatabase                                          |
| `files`               | Medium     | openCsvDialog, openSaveDialog                                        |
| `snapshots`           | High       | getAll, getByDate, save, checkImport, importSnapshots                |
| `events`              | Low        | onDrop, onUpdateComplete, onSyncComplete                             |
| `network`             | High       | request                                                              |
| `secrets`             | High       | set, get, use, delete                                                |

> **Baseline capabilities are not permissions.** `ui`, `navigation`, packaged
> `assets`, `query`, `toast`, `logger`, and `storage` are granted to every addon
> and are **not** declared in `manifest.json`. Only data categories plus
> `files`, `network`, `secrets`, `events`, `snapshots`, and `settings` require
> declaration and consent.

### Permission Enforcement

The permission system works in three stages:

1. **Static Analysis**: Code is scanned for API patterns during installation
2. **Declaration Matching**: Detected usage is compared with manifest
   declarations
3. **Runtime Validation**: API calls are checked against approved permissions

### Secrets Scoping

Each addon gets isolated secret storage:

```typescript
// Addon "my-addon" accessing secrets
await ctx.api.secrets.set("api-key", "value");
// Stored as: "addon_my-addon_api-key"
```

```
┌─────────────────────────────────────────────────────────────────┐
│                      Secret Storage                              │
├─────────────────────────────────────────────────────────────────┤
│ addon_analytics_api-key    = "sk-1234..."                       │
│ addon_analytics_token      = "token-5678..."                    │
├─────────────────────────────────────────────────────────────────┤
│ addon_importer_database    = "postgres://..."                   │
│ addon_importer_username    = "user123"                          │
├─────────────────────────────────────────────────────────────────┤
│ addon_tracker_webhook      = "https://..."                      │
│ addon_tracker_secret       = "secret-key"                       │
└─────────────────────────────────────────────────────────────────┘
```

The scoping prevents addons from accessing each other's secrets.

## API Architecture

The API is organized by financial domain:

```
┌─────────────────────────────────────────────────────────────────┐
│                         HostAPI                                 │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ │
│ │  accounts   │ │ portfolio   │ │ activities  │ │   market    │ │
│ │             │ │             │ │             │ │             │ │
│ │ • getAll    │ │ • holdings  │ │ • getAll    │ │ • search    │ │
│ │ • create    │ │ • update    │ │ • create    │ │ • sync      │ │
│ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ │
│ │   assets    │ │   quotes    │ │performance  │ │exchangeRates│ │
│ │             │ │             │ │             │ │             │ │
│ │ • profile   │ │ • update    │ │ • calculate │ │ • getAll    │ │
│ │ • update    │ │ • history   │ │ • summary   │ │ • update    │ │
│ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ │
│ │    goals    │ │contribution │ │  settings   │ │    files    │ │
│ │             │ │   Limits    │ │             │ │             │ │
│ │ • getAll    │ │ • getAll    │ │ • get       │ │ • openCsv   │ │
│ │ • create    │ │ • calculate │ │ • update    │ │ • openSave  │ │
│ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────┐ ┌─────────────┐                                 │
│ │   events    │ │   secrets   │                                 │
│ │             │ │             │                                 │
│ │ • onDrop    │ │ • set       │                                 │
│ │ • onUpdate  │ │ • get       │                                 │
│ │ • onSync    │ │ • delete    │                                 │
│ └─────────────┘ └─────────────┘                                 │
└─────────────────────────────────────────────────────────────────┘
```

```typescript
interface HostAPI {
  // Baseline capabilities — available without a permission declaration
  query: QueryAPI;
  storage: StorageAPI;
  toast: ToastAPI;
  logger: LoggerAPI;
  navigation: NavigationAPI;
  // Domain data APIs — gated by manifest permissions
  accounts: AccountsAPI;
  portfolio: PortfolioAPI;
  activities: ActivitiesAPI;
  market: MarketDataAPI;
  assets: AssetsAPI;
  quotes: QuotesAPI;
  performance: PerformanceAPI;
  exchangeRates: ExchangeRatesAPI;
  spending: SpendingAPI;
  goals: GoalsAPI;
  contributionLimits: ContributionLimitsAPI;
  settings: SettingsAPI;
  files: FilesAPI;
  snapshots: SnapshotsAPI;
  events: EventsAPI;
  secrets: SecretsAPI;
  network: NetworkAPI;
}
```

### Type Bridge

The system uses a type bridge to convert between internal types and SDK types:

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│                 │    │                 │    │                 │
│ Internal Types  │───▶│   Type Bridge   │───▶│   SDK Types     │
│                 │    │                 │    │                 │
│ getHoldings(id) │    │ • Convert args  │    │ api.portfolio.  │
│ → Holding[]     │    │ • Map returns   │    │   getHoldings() │
│                 │    │ • Type safety   │    │ → Holding[]     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

```typescript
// Internal command function
getHoldings(accountId: string): Promise<Holding[]>

// SDK API method
api.portfolio.getHoldings(accountId: string): Promise<Holding[]>
```

This allows the internal implementation to change without breaking addon
compatibility.

## Development Architecture

### Hot Reload System

Development addons run from local servers:

```
┌─────────────────────────────────────────────────────────────────┐
│              Development Environment                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────┐              ┌─────────────────┐           │
│  │ Wealthfolio App │◀─ discover ─▶│ Dev Server      │           │
│  │                 │              │ localhost:3001  │           │
│  │ • Auto-discover │              │                 │           │
│  │ • Load addons   │              │ /health    ✓    │           │
│  │ • Hot reload    │              │ /status    ✓    │           │
│  └─────────────────┘              │ /runtime-package│          │
│           │                       │ /runtime-assets │           │
│           │                       └─────────────────┘           │
│           │                                                     │
│  ┌─────────────────┐              ┌─────────────────┐           │
│  │ Runtime package │              │ Asset snapshots │           │
│  │                 │              │                 │           │
│  │ • Generation ID │              │ • Lazy bytes    │           │
│  │ • File metadata │              │ • Same build    │           │
│  │ • Asset metadata│              │ • Opaque IDs    │           │
│  └─────────────────┘              └─────────────────┘           │
└─────────────────────────────────────────────────────────────────┘
```

```
Development Server (localhost:3001)
├─ /health                         # Health check
├─ /status                         # Build status and generation
├─ /runtime-package                # Coherent manifest/files/asset metadata
├─ /runtime-files                  # Runtime JavaScript and CSS
└─ /runtime-assets/:id?generation= # Lazy asset bytes from that snapshot
```

The host application discovers the development server on port 3001. Wealthfolio
3.7 requires `@wealthfolio/addon-dev-tools` 3.7 or newer because earlier servers
do not publish `/runtime-package`.

### Build Process

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│             │    │             │    │             │    │             │
│ Source Code │───▶│ TypeScript  │───▶│ Vite Bundle │───▶│ Single File │
│             │    │ Compiler    │    │             │    │             │
│ .tsx/.ts    │    │             │    │             │    │ addon.js    │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
```

The addon is bundled into a single JavaScript file that exports an enable
function.

## Loading Process

### Module Resolution

The addon loader tries multiple export patterns:

```typescript
// 1. ES module default export is the function
export default function enable(ctx) { ... }

// 2. ES module default export object with enable
export default { enable: function(ctx) { ... } }

// 3. Named export
export function enable(ctx) { ... }

// 4. UMD/Constructor pattern
export function AddonNameAddon(ctx) { ... }
```

### Context Creation

Each addon gets its own isolated context:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Context Creation                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│ createAddonContext(addonId) ──┐                                 │
│                               │                                 │
│    ┌──────────────────────────▼──────────────────────────────┐  │
│    │              AddonContext                              │  │
│    ├─────────────────────────────────────────────────────────┤  │
│    │ sidebar: { addItem: ... }                              │  │
│    │ router:  { add: ... }                                  │  │
│    │ onDisable: (cb) => callbacks.add(cb)                   │  │
│    │ api: createScopedAPI(addonId) ─┐                       │  │
│    └─────────────────────────────────┼───────────────────────┘  │
│                                     │                          │
│    ┌────────────────────────────────▼──────────────────────┐    │
│    │              Scoped API                              │    │
│    ├─────────────────────────────────────────────────────────┤    │
│    │ accounts: AccountsAPI                                │    │
│    │ portfolio: PortfolioAPI                              │    │
│    │ ...                                                  │    │
│    │ secrets: createAddonScopedSecrets(addonId)           │    │
│    └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

```typescript
function createAddonContext(addonId: string): AddonContext {
  return {
    sidebar: { addItem: ... },
    router: { add: ... },
    onDisable: (cb) => callbacks.add(cb),
    api: createScopedAPI(addonId)
  };
}
```

The API is scoped to the addon ID for secret storage isolation.

## Error Handling

### Addon Failures

If an addon fails to load or crashes:

1. Error is logged
2. Host application continues normally
3. Other addons are unaffected
4. User sees error notification

### Permission Violations

If an addon tries to call an unauthorized API:

1. `PermissionError` is thrown
2. API call is blocked
3. Error is logged
4. Addon can handle the error gracefully

## Security Model

### Isolation

```
┌─────────────────────────────────────────────────────────────────┐
│                    Security Boundaries                          │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ │
│ │   Addon A   │ │   Addon B   │ │   Addon C   │ │   Addon D   │ │
│ │             │ │             │ │             │ │             │ │
│ │ Context A   │ │ Context B   │ │ Context C   │ │ Context D   │ │
│ │ Secrets A   │ │ Secrets B   │ │ Secrets C   │ │ Secrets D   │ │
│ │             │ │             │ │             │ │             │ │
│ │   ┌─────┐   │ │   ┌─────┐   │ │   ┌─────┐   │ │   ┌─────┐   │ │
│ │   │ API │   │ │   │ API │   │ │   │ API │   │ │   │ API │   │ │
│ │   │ Perms│   │ │   │ Perms│   │ │   │ Perms│   │ │   │ Perms│   │ │
│ │   └─────┘   │ │   └─────┘   │ │   └─────┘   │ │   └─────┘   │ │
│ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘ │
│       │               │               │               │         │
│       └───────────────┼───────────────┼───────────────┘         │
│                       │               │                         │
│             ┌─────────▼───────────────▼─────────┐               │
│             │      Permission Validator        │               │
│             │      Runtime Enforcement         │               │
│             └─────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────────┘
```

- Each addon runs in its own context
- Secrets are scoped by addon ID
- No cross-addon communication
- No access to host application internals

### Permission Validation

- Code is analyzed during installation
- User approves detected permissions
- Runtime validation on every API call
- Detailed audit logging

### Risk Assessment

Permissions are categorized by risk:

- **High**: Can modify financial data (accounts, activities)
- **Medium**: Can read sensitive data (portfolio, goals)
- **Low**: Read-only market data and UI operations

## Implementation Details

### Addon Enable Function

Every addon exports an enable function. Navigation is declared in the manifest
(`contributes.routes` + `contributes.links`), and the host owns the React root —
so `enable` only registers the route's component:

```typescript
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AddonContext, AddonEnableFunction } from "@wealthfolio/addon-sdk";
import { MyComponent } from "./MyComponent";

// The host mounts the route component itself with no ctx, so capture it here.
let addonCtx: AddonContext | undefined;

const MyRoute = () => (
  <QueryClientProvider client={addonCtx!.api.query.getClient() as QueryClient}>
    <MyComponent ctx={addonCtx!} />
  </QueryClientProvider>
);

const enable: AddonEnableFunction = (ctx) => {
  addonCtx = ctx;

  // `id` MUST match the declared `contributes.routes[].id`.
  ctx.router.add({
    id: "my-feature",
    path: "/addons/my-feature",
    component: MyRoute,
  });

  // The host owns the React root, so there is nothing to unmount.
  ctx.onDisable(() => {
    addonCtx = undefined;
  });
};

export default enable;
```

> Do **not** call `createRoot` yourself — the host mounts your `component` into
> its managed root. A per-route `createRoot` orphans the React tree and its
> re-renders never reach the DOM (the "buttons do nothing" bug). `render`
> remains a legacy imperative escape hatch, but `component` is preferred.

### Dynamic Loading

Each addon module is loaded and executed inside an **isolated sandbox iframe**
(`sandbox="allow-scripts"`, opaque origin) rather than in the host's main
runtime. The parent delivers the host-provided dependency runtime and addon
package as Blobs. React is provided at a pinned version; each addon owns a local
QueryClient whose invalidations/refetches are bridged back to the host. See the
[v3.5 → v3.6 migration guide](./addon-migration-guide-v3.5-to-v3.6.md) for the
sandbox model and the
[v3.6 → v3.7 guide](./addon-migration-guide-v3.6-to-v3.7.md) for assets. Within
the sandbox the loader resolves rewritten modules via dynamic `import()`:

```typescript
// Create blob URL from addon code
const blob = new Blob([addonCode], { type: "text/javascript" });
const blobUrl = URL.createObjectURL(blob);

// Dynamic import
const mod = await import(blobUrl);
const enableFunction = mod.default || mod.enable;

// Execute with isolated context
const result = enableFunction(createAddonContext(addonId));
```

### Cleanup

When addons are disabled:

1. Their disable function is called
2. UI elements are removed
3. Event listeners are unregistered
4. Packaged asset Blob URLs are revoked and cached bytes are released
5. The addon QueryClient and context are destroyed

## Manifest Structure

Each addon includes a manifest.json file:

```json
{
  "id": "my-addon",
  "name": "My Addon",
  "version": "1.0.0",
  "description": "Does something useful",
  "main": "dist/addon.js",
  "sdkVersion": "3.8.0",
  "minWealthfolioVersion": "3.8.0",
  "contributes": {
    "routes": [{ "id": "my-addon" }],
    "links": {
      "sidebar": [
        {
          "id": "my-addon",
          "route": "my-addon",
          "label": "My Addon",
          "icon": "chart-line",
          "order": 100
        }
      ]
    }
  },
  "permissions": [
    {
      "category": "portfolio",
      "functions": ["getHoldings"],
      "purpose": "Read holdings"
    },
    {
      "category": "market-data",
      "functions": ["sync"],
      "purpose": "Refresh quotes"
    }
  ]
}
```

Required fields:

- `id`: Unique identifier
- `name`: Display name
- `version`: Semantic version
- `main`: Entry point file

Optional fields:

- `description`: What the addon does
- `author`: Creator information
- `contributes`: Declared `routes` and `links` (sidebar navigation) the host can
  render before booting the addon
- `permissions`: Declared data access (array of
  `{ category, functions, purpose }`)
- `sdkVersion`: SDK version the addon targets (`"3.8.0"`)
- `minWealthfolioVersion`: Minimum host version required to load the addon

The host mounts every contributed route below `/addons/<manifest.id>`. Omit
`path` for that root page, or set a relative suffix such as `reports/:year` for
a nested page; manifests cannot choose an absolute route namespace.

## File Structure

```
addon-package.zip
├─ manifest.json       # Addon metadata
├─ dist/
│  ├─ addon.js         # Main entry point
│  └─ assets/          # Generated assets, chunks, and CSS
└─ assets/             # Optional hand-authored private assets
   └─ icon.png
```

For development:

```
my-addon/
├─ src/
│  └─ addon.tsx     # Source code
├─ dist/            # Built files
├─ manifest.json    # Metadata
├─ package.json     # Dependencies
├─ vite.config.ts   # Build config
└─ tsconfig.json    # TypeScript config
```

### Package Structure Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     Addon Package                               │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────────┐                                             │
│ │ manifest.json   │  ← Metadata, permissions, entry point      │
│ │                 │                                             │
│ │ {               │                                             │
│ │   "id": "...",  │                                             │
│ │   "name": "...",│                                             │
│ │   "main": "..." │                                             │
│ │ }               │                                             │
│ └─────────────────┘                                             │
│                                                                 │
│ ┌─────────────────┐                                             │
│ │ addon.js        │  ← Bundled JavaScript with enable()        │
│ │                 │                                             │
│ │ export default  │                                             │
│ │ function enable │                                             │
│ │ (ctx) { ... }   │                                             │
│ └─────────────────┘                                             │
│                                                                 │
│ ┌─────────────────┐                                             │
│ │ assets/         │  ← Optional static assets                   │
│ │ ├─ icon.png     │                                             │
│ │ ├─ logo.svg     │                                             │
│ │ └─ styles.css   │                                             │
│ └─────────────────┘                                             │
└─────────────────────────────────────────────────────────────────┘
```

No manifest asset list is needed. The host indexes `assets/**` and
`dist/assets/**`, keeps host paths private, and sends metadata to the sandbox.
Bytes are requested later by opaque identity and exposed to addon code only as
verified `Blob` objects or lifecycle-scoped Blob URLs. JavaScript and CSS stay
in the runtime file set so code splitting and styles continue to work.
