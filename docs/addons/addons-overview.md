Wealthfolio addons are TypeScript modules that extend the application's
functionality. This guide covers how to build, test, and distribute addons.

**New to addon development?** Start with our
[Quick Start Guide](/docs/addons/getting-started) to create your first addon.

## What are Wealthfolio Addons?

Addons are TypeScript/React-based extensions that provide access to
Wealthfolio's financial data and UI system.

**Technical Foundation** Each addon is a JavaScript function that receives an
`AddonContext` object with access to APIs, UI components, and event system.

**Integration Capabilities** Addons can register new navigation items, routes,
and components that integrate directly into Wealthfolio's interface.

**Development Environment** Built with TypeScript, React, and modern web APIs.
Includes hot-reload development server and comprehensive type definitions.

## Architecture Overview

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

## Basic Addon Structure

Every addon exports an enable function that receives a context object. The
sidebar entry and route are **declared in `manifest.json`**
(`contributes.routes` + `contributes.links`), so the host renders navigation
without booting the addon; `enable` only registers the route's component and any
event listeners:

```typescript
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AddonContext, AddonEnableFunction } from '@wealthfolio/addon-sdk';
import { MyComponent } from './MyComponent';

// The host owns a single React root per addon and mounts the route `component`
// itself (with no ctx). Capture the context at enable time so the wrapper can
// hand it down. Do NOT call createRoot yourself — the host manages the root.
let addonCtx: AddonContext | undefined;

const MyRoute = () => (
  <QueryClientProvider client={addonCtx!.api.query.getClient() as QueryClient}>
    <MyComponent ctx={addonCtx!} />
  </QueryClientProvider>
);

const enable: AddonEnableFunction = (ctx) => {
  addonCtx = ctx;

  // The route `id` MUST match `contributes.routes[].id` in the manifest.
  ctx.router.add({
    id: 'my-addon',
    path: '/addons/my-addon',
    component: MyRoute,
  });

  // Listen to events
  const unlisten = ctx.api.events.portfolio.onUpdateComplete(() => {
    // Handle portfolio updates
  });

  // Cleanup: the host owns the React root, so there is nothing to unmount.
  ctx.onDisable(() => {
    addonCtx = undefined;
    unlisten();
  });
};

export default enable;
```

## Permission System

Addons operate under a permission-based security model with three stages:

#### 1. Static Analysis

During installation, addon code is scanned for API usage patterns:

```typescript
// This pattern is detected:
const accounts = await ctx.api.accounts.getAll();
// Detected permission: accounts.getAll
```

#### 2. Permission Categories

| Category      | Risk Level | Functions                                   |
| ------------- | ---------- | ------------------------------------------- |
| `accounts`    | High       | getAll, create                              |
| `portfolio`   | High       | getHoldings, update, recalculate            |
| `activities`  | High       | getAll, search, create, update, import      |
| `market-data` | Low        | searchTicker, sync, getProviders            |
| `assets`      | Medium     | getProfile, updateProfile, updateDataSource |
| `quotes`      | Low        | update, getHistory                          |
| `performance` | Medium     | calculateHistory, calculateSummary          |
| `goals`       | Medium     | getAll, create, update, updateAllocations   |
| `settings`    | Medium     | get, update, backupDatabase                 |
| `files`       | Medium     | openCsvDialog, openSaveDialog               |
| `events`      | Low        | onDrop, onUpdateComplete, onSyncStart       |
| `secrets`     | High       | set, get, delete                            |
| `network`     | High       | request (brokered fetch to declared hosts)  |

> **Baseline capabilities are not permissions.** `ui`, `query`, `toast`,
> `logger`, and `storage` are granted to every addon and must **not** appear in
> `manifest.json` `permissions`. Only data categories plus `files`, `network`,
> `secrets`, `events`, `snapshots`, and `settings` require declaration and
> consent.

#### 3. User Approval

During installation, users see both declared and detected permissions, then
approve or reject the addon installation.

## Available APIs

The addon context provides access to domain-specific data APIs plus a set of
**baseline capabilities** (`query`, `storage`, `toast`, `logger`) that every
addon gets without declaring a permission:

```typescript
interface AddonContext {
  sidebar: SidebarAPI;
  router: RouterAPI;
  onDisable: (callback: () => void) => void;
  api: {
    // Baseline capabilities — no permission declaration required
    query: QueryAPI; // shared QueryClient (getClient, invalidate, refetch)
    storage: StorageAPI; // durable, per-addon key/value store
    toast: ToastAPI; // user-facing notifications
    logger: LoggerAPI; // scoped logging
    // Domain data APIs — declared in manifest `permissions`
    accounts: AccountsAPI;
    portfolio: PortfolioAPI;
    activities: ActivitiesAPI;
    market: MarketAPI;
    assets: AssetsAPI;
    quotes: QuotesAPI;
    performance: PerformanceAPI;
    exchangeRates: ExchangeRatesAPI;
    goals: GoalsAPI;
    contributionLimits: ContributionLimitsAPI;
    settings: SettingsAPI;
    files: FilesAPI;
    events: EventsAPI;
    secrets: SecretsAPI;
  };
}
```

## Development Setup

### Required Packages

```bash
npm install @wealthfolio/addon-sdk @wealthfolio/ui react react-dom
npm install -D @wealthfolio/addon-dev-tools typescript vite
```

### Core Dependencies

- **@wealthfolio/addon-sdk**: TypeScript types and API definitions
- **@wealthfolio/ui**: UI components based on shadcn/ui and Tailwind CSS
- **@wealthfolio/addon-dev-tools**: CLI and development server

### Development Server

The development tools include a hot-reload server:

```bash
# Start development server
npm run dev:server

# Available on localhost:3001-3003
# Auto-discovered by Wealthfolio
```

```
Development Server Structure:
├─ /health          # Health check
├─ /status          # Build status
├─ /manifest.json   # Addon manifest
└─ /addon.js        # Built addon code
```

## Project Structure

```
hello-world-addon/
├── src/
│   ├── addon.tsx           # Main addon entry point
│   ├── components/         # React components
│   ├── hooks/              # React hooks
│   ├── pages/              # Addon pages
│   ├── utils/              # Utility functions
│   └── types/              # Type definitions
├── assets/                 # Static assets (optional)
├── dist/                   # Built files (generated)
├── manifest.json           # Addon metadata and permissions
├── package.json            # NPM package configuration
├── vite.config.ts          # Build configuration
├── tsconfig.json           # TypeScript configuration
└── README.md               # Documentation
```

### Manifest File

```json
{
  "id": "my-addon",
  "name": "My Addon",
  "version": "1.0.0",
  "main": "dist/addon.js",
  "description": "Addon description",
  "author": "Your Name",
  "sdkVersion": "3.6.1",
  "minWealthfolioVersion": "3.6.1",
  "enabled": true,
  "contributes": {
    "routes": [{ "id": "my-addon" }],
    "links": {
      "sidebar": [
        {
          "id": "my-addon",
          "route": "my-addon",
          "label": "My Addon",
          "icon": "squares-four",
          "order": 100
        }
      ]
    }
  },
  "permissions": [
    {
      "category": "accounts",
      "functions": ["getAll"],
      "purpose": "List accounts"
    },
    {
      "category": "portfolio",
      "functions": ["getHoldings"],
      "purpose": "Read holdings"
    }
  ]
}
```

The host mounts that route at `/addons/my-addon`, derived from the manifest
`id`. Omit `path` for the root, or use a relative suffix such as
`"path": "reports/:year"` for a nested page.

## Lifecycle Management

### Installation Process

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

Addons that declare `contributes.routes` **boot lazily**: the host reads the
manifest into a ContributionRegistry and renders the addon's sidebar entries and
routes _without executing any addon code_. The addon's `enable` function runs
only on the first visit to one of its routes — not eagerly at startup. Addons
**without** `contributes` stay eager and run at load time. This keeps startup
fast and lets the host draw navigation for addons that have never been opened.

### Context Isolation

Each addon receives an isolated context with scoped secret storage:

```typescript
// Addon "my-addon" accessing secrets
await ctx.api.secrets.set("api-key", "value");
// Stored as: "addon_my-addon_api-key"
```

## UI Components

Addons have access to Wealthfolio's UI component library:

```typescript
import { Button, Card, Dialog, Input, Table } from '@wealthfolio/ui';
import { AmountDisplay, GainAmount, CurrencyInput } from '@wealthfolio/ui/financial';
import { TrendingUp, DollarSign } from 'lucide-react';

function MyComponent() {
  return (
    <Card className="p-6">
      <div className="flex items-center space-x-2">
        <TrendingUp className="h-4 w-4" />
        <span>Portfolio Growth</span>
      </div>

      <div className="mt-4">
        <AmountDisplay value={1234.56} currency="USD" />
        <GainAmount value={123.45} percentage={5.2} />
      </div>
    </Card>
  );
}
```

Available libraries:

- All Radix UI components
- **Financial components** (`components/financial`) for amounts, gains, and
  currency inputs
- Lucide React icons
- Tailwind CSS utilities
- Recharts for data visualization
- React Query for data fetching
- date-fns for date manipulation

## Build and Distribution

### Build Configuration

Standard Vite configuration externalizes host-provided dependencies as ESM:

```typescript
// vite.config.ts
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const hostProvidedDependencies = [
  "@tanstack/react-query",
  "@wealthfolio/addon-sdk",
  "@wealthfolio/addon-sdk/host-api",
  "@wealthfolio/addon-sdk/host-dependencies",
  "@wealthfolio/addon-sdk/manifest",
  "@wealthfolio/addon-sdk/permissions",
  "@wealthfolio/addon-sdk/types",
  "@wealthfolio/addon-sdk/utils",
  "@wealthfolio/ui",
  "@wealthfolio/ui/chart",
  "date-fns",
  "lucide-react",
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-dev-runtime",
  "react/jsx-runtime",
  "recharts",
];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    lib: {
      entry: "src/addon.tsx",
      fileName: () => "addon.js",
      formats: ["es"],
    },
    outDir: "dist",
    minify: true,
    sourcemap: false,
    rollupOptions: {
      external: hostProvidedDependencies,
    },
  },
});
```

### Package Scripts

```json
{
  "scripts": {
    "build": "vite build",
    "dev": "vite build --watch",
    "dev:server": "wealthfolio dev",
    "clean": "rm -rf dist",
    "package": "mkdir -p dist && zip -r dist/$npm_package_name-$npm_package_version.zip manifest.json dist/ assets/ README.md",
    "bundle": "pnpm clean && pnpm build && pnpm package",
    "lint": "tsc --noEmit",
    "type-check": "tsc --noEmit"
  }
}
```

## Error Handling

### Addon Failures

- Errors are logged but don't affect other addons
- Host application continues normally
- Users see error notifications

### Sandbox Error Classification

Because each addon runs in an isolated sandbox, the host classifies common
failure modes and surfaces them as a toast plus an inline panel in the addon
frame:

- **Blocked storage** — a `localStorage`/`sessionStorage` call (which throws in
  the sandbox). Use `ctx.api.storage` instead.
- **Unknown API** — calling a method the host doesn't expose.
- **Unavailable route surface** — a route whose runtime `router.add({ id })`
  doesn't match a declared `contributes.routes[].id`.

### Permission Violations

- `PermissionError` thrown for unauthorized API calls
- API calls are blocked
- Errors are logged for debugging

## Security Model

- Each addon runs in isolated context
- Secrets are scoped by addon ID
- No cross-addon communication
- Runtime permission validation
- Static code analysis during installation

## Publishing

Users can install addons directly from ZIP files. To publish your addon in the
Wealthfolio Store, contact **support@wealthfolio.app**.

## Quick Start

<div class="grid grid-cols-1 md:grid-cols-2 gap-4 mt-8">
  <Card href="/docs/addons/getting-started">
    <h3 class="text-lg font-semibold mb-2">🏃‍♂️ Quick Start</h3>
    <p class="text-muted-foreground mb-4">Create your first addon</p>
    <span class="text-primary">Get Started →</span>
  </Card>

  <Card href="/docs/addons/api-reference">
    <h3 class="text-lg font-semibold mb-2">📖 API Reference</h3>
    <p class="text-muted-foreground mb-4">Explore available APIs</p>
    <span class="text-primary">Browse APIs →</span>
  </Card>

  <Card href="https://github.com/wealthfolio/wealthfolio-addons/tree/main/official">
    <h3 class="text-lg font-semibold mb-2">💡 Examples</h3>
    <p class="text-muted-foreground mb-4">See real addon implementations</p>
    <span class="text-primary">Browse Examples →</span>
  </Card>

  <Card href="https://wealthfolio.app/addons">
    <h3 class="text-lg font-semibold mb-2">🏪 Addon Store</h3>
    <p class="text-muted-foreground mb-4">Explore available addons</p>
    <span class="text-primary">Visit Store →</span>
  </Card>
</div>
