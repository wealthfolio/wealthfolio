# @wealthfolio/addon-sdk

[![Version](https://img.shields.io/npm/v/@wealthfolio/addon-sdk?style=flat-square)](https://www.npmjs.com/package/@wealthfolio/addon-sdk)
[![Downloads](https://img.shields.io/npm/dm/@wealthfolio/addon-sdk?style=flat-square)](https://www.npmjs.com/package/@wealthfolio/addon-sdk)
[![License](https://img.shields.io/npm/l/@wealthfolio/addon-sdk?style=flat-square)](https://github.com/wealthfolio/wealthfolio/blob/main/LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue?style=flat-square)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/node/v/@wealthfolio/addon-sdk?style=flat-square)](https://nodejs.org/)

A comprehensive TypeScript SDK for building secure, feature-rich addons for
Wealthfolio. Extend your portfolio management experience with custom analytics,
integrations, and visualizations.

## 📚 Table of Contents

- [Features](#-features)
- [Installation](#-installation)
- [Project Structure](#-project-structure)
- [Manifest Configuration](#-manifest-configuration)
- [Development Guide](#-development-guide)
- [Security & Permissions](#-security--permissions)
- [Build Configuration](#-build-configuration)
- [Building and Packaging](#-building-and-packaging)
- [Installation & Testing](#-installation--testing)
- [API Reference](#-api-reference)
- [Migration Guide](#-migration-guide)
- [Contributing](#-contributing)
- [NPM Registry Information](#-npm-registry-information)
- [Troubleshooting](#-troubleshooting)
- [License](#-license)
- [Links](#-links)
- [Support](#-support)

## 🚀 Features

- **Type-Safe Development**: Full TypeScript support with comprehensive type
  definitions
- **Security-First**: Built-in permission system with granular risk assessment
- **Modular Architecture**: Clean separation of concerns with well-defined APIs
- **React Integration**: Seamless integration with React components and hooks
- **Hot Reloading**: Development-friendly with automatic reload capabilities
- **ZIP Packaging**: Simple distribution model with manifest-based configuration
- **ESM Support**: Modern ECMAScript modules with tree-shaking support
- **Comprehensive Logging**: Built-in logging system with multiple levels
- **Event System**: Subscribe to application events and state changes
- **Performance Optimized**: Lightweight bundle with minimal overhead
- **Developer Tools**: Built-in debugging and development utilities
- **Backwards Compatible**: Stable API with semantic versioning

## ⚡ Quick Start

Get up and running with your first addon in minutes:

```bash
# 1. Create a new project
mkdir my-portfolio-addon && cd my-portfolio-addon

# 2. Initialize and install dependencies
npm init -y
npm install @wealthfolio/addon-sdk react react-dom
npm install -D typescript @types/react vite @vitejs/plugin-react

# 3. Create basic files
echo '{"id": "my-addon", "name": "My Portfolio Addon", "version": "1.0.0"}' > manifest.json
mkdir src && touch src/index.ts

# 4. Start building your addon!
```

### Minimal Addon Example

```typescript
// src/index.ts
import { createRoot, type Root } from 'react-dom/client';
import { getAddonContext, type AddonContext } from '@wealthfolio/addon-sdk';
import { MyComponent } from './MyComponent';

export default function enable(context: AddonContext) {
  let root: Root | null = null;

  // Add navigation item
  const navItem = context.sidebar.addItem({
    id: 'my-addon',
    label: 'My Addon',
    icon: 'chart-line',
    route: '/addons/my-addon',
  });

  // Register route
  context.router.add({
    path: '/addons/my-addon',
    render: ({ root: routeRoot }) => {
      root ??= createRoot(routeRoot);
      root.render(<MyComponent ctx={context} />);
    },
  });

  // Log activation
  context.api.logger.info('My addon activated!');

  // Cleanup on disable
  context.onDisable(() => {
    root?.unmount();
    root = null;
    navItem.remove();
    context.api.logger.info('My addon deactivated');
  });
}
```

## 📦 Installation

```bash
# Using npm
npm install @wealthfolio/addon-sdk @tanstack/react-query

# Using yarn
yarn add @wealthfolio/addon-sdk @tanstack/react-query

# Using pnpm
pnpm add @wealthfolio/addon-sdk @tanstack/react-query
```

### Requirements

- **Node.js**: >= 18.0.0
- **React**: ^18.0.0 (peer dependency)
- **TypeScript**: ^5.0.0 (recommended for development)
- **React Query**: ^4.0.0 or ^5.0.0 (for data fetching)

### Package Information

- **Package Name**: `@wealthfolio/addon-sdk`
- **Current Version**: 1.0.0
- **Bundle Format**: ESM (ECMAScript Modules)
- **Type Definitions**: Included (TypeScript ready)
- **License**: MIT
- **Bundle Size**: ~15KB (minified + gzipped)
- **Tree Shakeable**: Yes
- **Side Effects**: No

### Import Methods

The SDK supports multiple import patterns:

```typescript
// Default import (recommended)
import { getAddonContext } from '@wealthfolio/addon-sdk';

// Named imports
import { AddonContext, PermissionLevel } from '@wealthfolio/addon-sdk';

// Type-only imports
import type { AddonManifest, Permission } from '@wealthfolio/addon-sdk';

// Subpath imports
import type { PortfolioHolding } from '@wealthfolio/addon-sdk/types';
import { PERMISSION_CATEGORIES } from '@wealthfolio/addon-sdk/permissions';
```

## 🏗️ Project Structure

Create your addon with the following recommended structure:

```
my-portfolio-addon/
├── manifest.json          # Addon metadata and permissions
├── src/
│   ├── index.ts           # Main entry point
│   ├── components/        # React components
│   │   └── Dashboard.tsx
│   ├── hooks/            # Custom hooks
│   ├── types/            # TypeScript types
│   └── utils/            # Utility functions
├── dist/                 # Built output
│   └── addon.js
├── assets/               # Static assets
├── package.json
├── tsconfig.json
└── vite.config.ts        # Build configuration
```

## 📋 Manifest Configuration

Create a `manifest.json` file in your addon root:

```json
{
  "id": "investment-fees-tracker",
  "name": "Investment Fees Tracker",
  "version": "1.0.0",
  "description": "Track and analyze investment fees across your portfolio",
  "author": "Your Name",
  "homepage": "https://github.com/yourname/investment-fees-tracker",
  "license": "MIT",
  "main": "dist/addon.js",
  "sdkVersion": "1.0.0",
  "minWealthfolioVersion": "1.0.0",
  "keywords": ["portfolio", "fees", "tracking", "analytics"],
  "icon": "data:image/svg+xml;base64,...",
  "permissions": [
    {
      "category": "portfolio",
      "functions": ["getHoldings"],
      "purpose": "Access portfolio data to calculate fee analytics"
    },
    {
      "category": "activities",
      "functions": ["getAll"],
      "purpose": "Analyze transaction history for fee calculations"
    }
  ]
}
```

### Required Fields

| Field     | Type     | Description                                    |
| --------- | -------- | ---------------------------------------------- |
| `id`      | `string` | Unique identifier (lowercase, hyphens allowed) |
| `name`    | `string` | Human-readable addon name                      |
| `version` | `string` | Semantic version (e.g., "1.0.0")               |

### Optional Fields

| Field                   | Type           | Description                            |
| ----------------------- | -------------- | -------------------------------------- |
| `description`           | `string`       | Brief description of functionality     |
| `author`                | `string`       | Author name or organization            |
| `homepage`              | `string`       | Project homepage URL                   |
| `license`               | `string`       | License identifier                     |
| `main`                  | `string`       | Entry point file (default: "addon.js") |
| `sdkVersion`            | `string`       | Compatible SDK version                 |
| `permissions`           | `Permission[]` | Security permissions required          |
| `minWealthfolioVersion` | `string`       | Minimum Wealthfolio version required   |
| `keywords`              | `string[]`     | Keywords for discoverability           |
| `icon`                  | `string`       | Addon icon (base64 or relative path)   |

## 🔨 Development Guide

### Modern Addon Example

Based on the current SDK architecture, here's a complete real-world addon
example:

```typescript
// src/addon.tsx
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import type { AddonContext, AddonEnableFunction } from '@wealthfolio/addon-sdk';
import FeesPage from './pages/fees-page';

// Main addon component
function InvestmentFeesTrackerAddon({ ctx }: { ctx: AddonContext }) {
  return (
    <div className="investment-fees-tracker-addon">
      <FeesPage ctx={ctx} />
    </div>
  );
}

// Addon enable function - called when the addon is loaded
const enable: AddonEnableFunction = (context) => {
  context.api.logger.info('💰 Investment Fees Tracker addon is being enabled!');

  // Store references to items for cleanup
  const addedItems: Array<{ remove: () => void }> = [];
  let root: Root | null = null;

  try {
    // Add sidebar navigation item with a host-supported icon token
    const sidebarItem = context.sidebar.addItem({
      id: 'investment-fees-tracker',
      label: 'Fee Tracker',
      icon: 'receipt',
      route: '/addons/investment-fees-tracker',
      order: 200
    });
    addedItems.push(sidebarItem);

    context.api.logger.debug('Sidebar navigation item added successfully');

    // Create wrapper component with shared QueryClient
    const InvestmentFeesTrackerWrapper = () => {
      const sharedQueryClient = context.api.query.getClient();
      return (
        <QueryClientProvider client={sharedQueryClient}>
          <InvestmentFeesTrackerAddon ctx={context} />
        </QueryClientProvider>
      );
    };

    // Register route
    context.router.add({
      path: '/addons/investment-fees-tracker',
      render: ({ root: routeRoot }) => {
        root ??= createRoot(routeRoot);
        root.render(<InvestmentFeesTrackerWrapper />);
      },
    });

    context.api.logger.debug('Route registered successfully');
    context.api.logger.info('Investment Fees Tracker addon enabled successfully');

  } catch (error) {
    context.api.logger.error('Failed to initialize addon: ' + (error as Error).message);
    throw error; // Re-throw so addon system can handle it
  }

  // Register cleanup callback
  context.onDisable(() => {
    context.api.logger.info('🛑 Investment Fees Tracker addon is being disabled');

    // Unmount the addon's React root
    root?.unmount();
    root = null;

    // Remove all sidebar items
    addedItems.forEach(item => {
      try {
        item.remove();
      } catch (error) {
        context.api.logger.error('Error removing sidebar item: ' + (error as Error).message);
      }
    });

    context.api.logger.info('Investment Fees Tracker addon disabled successfully');
  });
};

// Export the enable function as default
export default enable;
```

### Key Features Demonstrated

1. **Shared Query Client**: Uses `context.api.query.getClient()` for consistent
   data fetching
2. **UI Icons**: Leverages `@wealthfolio/ui` for consistent iconography
3. **Error Handling**: Comprehensive error handling with logging
4. **Resource Management**: Proper cleanup of sidebar items and event listeners
5. **TypeScript**: Full type safety with proper imports
6. **Sandbox Rendering**: Mounts into the route root with `createRoot` and
   unmounts on disable

````

### Advanced Component Example

```typescript
// components/FeesPage.tsx
import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { Holding, Account, Activity } from '@wealthfolio/addon-sdk/types';

interface FeesPageProps {
  ctx: AddonContext;
}

export function FeesPage({ ctx }: FeesPageProps) {
  // Use React Query for data fetching with the shared client
  const { data: accounts, isLoading: accountsLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => ctx.api.accounts.getAll()
  });

  const { data: holdings, isLoading: holdingsLoading } = useQuery({
    queryKey: ['holdings'],
    queryFn: async () => {
      if (!accounts || accounts.length === 0) return [];
      // Get holdings for all accounts
      const allHoldings = await Promise.all(
        accounts.map(account => ctx.api.portfolio.getHoldings(account.id))
      );
      return allHoldings.flat();
    },
    enabled: !!accounts && accounts.length > 0
  });

  const { data: activities, isLoading: activitiesLoading } = useQuery({
    queryKey: ['activities'],
    queryFn: () => ctx.api.activities.getAll()
  });

  const isLoading = accountsLoading || holdingsLoading || activitiesLoading;

  // Calculate total fees from activities
  const totalFees = React.useMemo(() => {
    if (!activities?.data) return 0;

    return activities.data.reduce((total, activity) => {
      // Look for fee-related activities or transaction costs
      const fee = activity.fee || 0;
      return total + fee;
    }, 0);
  }, [activities]);

  useEffect(() => {
    if (!isLoading) {
      ctx.api.logger.info('Fees data loaded successfully', {
        accountsCount: accounts?.length,
        holdingsCount: holdings?.length,
        activitiesCount: activities?.data?.length,
        totalFees
      });
    }
  }, [isLoading, accounts, holdings, activities, totalFees, ctx.api.logger]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p>Loading fees data...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">Investment Fees Tracker</h1>
        <p className="text-gray-600">Track and analyze fees across your investment portfolio</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        <div className="bg-white p-6 rounded-lg shadow border">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Total Fees Paid</h3>
          <p className="text-3xl font-bold text-red-600">
            ${totalFees.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </p>
        </div>

        <div className="bg-white p-6 rounded-lg shadow border">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Accounts Tracked</h3>
          <p className="text-3xl font-bold text-blue-600">{accounts?.length || 0}</p>
        </div>

        <div className="bg-white p-6 rounded-lg shadow border">
          <h3 className="text-lg font-semibold text-gray-900 mb-2">Holdings</h3>
          <p className="text-3xl font-bold text-green-600">{holdings?.length || 0}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white p-6 rounded-lg shadow border">
          <h2 className="text-xl font-semibold mb-4">Recent Fee Activities</h2>
          <div className="space-y-3">
            {activities?.data?.slice(0, 5).map((activity) => (
              <div key={activity.id} className="flex justify-between items-center py-2 border-b">
                <div>
                  <p className="font-medium">{activity.activityType}</p>
                  <p className="text-sm text-gray-600">{activity.date}</p>
                </div>
                <span className="text-red-600 font-medium">
                  ${(activity.fee || 0).toFixed(2)}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white p-6 rounded-lg shadow border">
          <h2 className="text-xl font-semibold mb-4">Account Summary</h2>
          <div className="space-y-3">
            {accounts?.map((account) => (
              <div key={account.id} className="flex justify-between items-center py-2 border-b">
                <div>
                  <p className="font-medium">{account.name}</p>
                  <p className="text-sm text-gray-600">{account.accountType}</p>
                </div>
                <span className="text-gray-900 font-medium">
                  ${account.balance?.toLocaleString('en-US', { minimumFractionDigits: 2 }) || '0.00'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default FeesPage;
          <h2 className="text-lg font-semibold mb-4">Holdings Overview</h2>
          <p>Total holdings: {holdings.length}</p>
          {/* Add your custom analytics here */}
        </div>

        <div className="bg-white p-4 rounded-lg shadow">
          <h2 className="text-lg font-semibold mb-4">Account Summary</h2>
          <p>Total accounts: {accounts.length}</p>
          {/* Add account analytics here */}
        </div>
      </div>
    </div>
  );
}

export default AnalyticsDashboard;
````

### Using Hooks and State Management

```typescript
// hooks/usePortfolioData.ts
import { useState, useEffect } from 'react';
import { getAddonContext } from '@wealthfolio/addon-sdk';
import type { Holding, PerformanceResult } from '@wealthfolio/addon-sdk/types';

export function usePortfolioData(accountId?: string) {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [performance, setPerformance] = useState<PerformanceResult | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setLoading(true);
        setError(null);

        const ctx = getAddonContext();

        const holdingsData = await ctx.api.portfolio.getHoldings(
          accountId || '',
        );
        setHoldings(holdingsData);

        if (accountId) {
          const performanceData =
            await ctx.api.portfolio.calculatePerformanceSummary({
              itemType: 'account',
              itemId: accountId,
            });
          console.log(
            performanceData.returns.twr,
            performanceData.returns.irr,
            performanceData.risk.maxDrawdown,
          );
          setPerformance(performanceData);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [accountId]);

  return { holdings, performance, loading, error };
}
```

`performanceData.returns.irr` is the selected-period money-weighted return.
`performanceData.returns.annualizedIrr` is the annualized XIRR on the same dated
cash flows.

## 🔐 Security & Permissions

### Permission Categories

| Category             | Risk Level | Description                     |
| -------------------- | ---------- | ------------------------------- |
| `ui`                 | Low        | Add navigation items and routes |
| `market-data`        | Low        | Access market prices and quotes |
| `events`             | Low        | Listen to application events    |
| `currency`           | Low        | Access exchange rates           |
| `portfolio`          | Medium     | Access holdings and valuations  |
| `files`              | Medium     | File dialog operations          |
| `financial-planning` | Medium     | Goals and contribution limits   |
| `activities`         | High       | Transaction history access      |
| `accounts`           | High       | Account management              |
| `settings`           | High       | Application configuration       |

### Declaring Permissions

```json
{
  "permissions": [
    {
      "category": "portfolio",
      "functions": ["getHoldings", "getHolding", "calculatePerformanceSummary"],
      "purpose": "Display detailed portfolio analytics and performance metrics"
    },
    {
      "category": "activities",
      "functions": ["getAll", "create"],
      "purpose": "Access transaction history for fee calculations and analysis"
    },
    {
      "category": "market-data",
      "functions": ["searchTicker", "getQuoteHistory"],
      "purpose": "Show price charts and enable ticker search functionality"
    }
  ]
}
```

## 🛠️ Build Configuration

### Vite Configuration

Create a `vite.config.ts` for optimal bundling:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'MyPortfolioAddon',
      fileName: 'addon',
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        '@tanstack/react-query',
        '@wealthfolio/addon-sdk',
        '@wealthfolio/ui',
        'date-fns',
        'lucide-react',
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'recharts',
      ],
    },
    outDir: 'dist',
    minify: 'terser',
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
```

### TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

## 📦 Building and Packaging

### Build Your Addon

```bash
# Install dependencies
npm install

# Build for production
npm run build

# The built addon will be in dist/addon.js
```

### Create Distribution Package

```bash
# Create a ZIP package with all necessary files
zip -r my-portfolio-addon.zip \
  manifest.json \
  dist/ \
  assets/ \
  README.md
```

### Package Structure

Your final package should contain:

- `manifest.json` - Addon metadata
- `dist/addon.js` - Compiled addon code
- `assets/` - Static assets (optional)
- `README.md` - Documentation (optional)

## 🚀 Installation & Testing

### Install in Wealthfolio

1. Open Wealthfolio
2. Navigate to Settings → Addons
3. Click "Install Addon"
4. Select your ZIP package
5. Review permissions and approve
6. Restart Wealthfolio to activate

### Development Testing

For development, you can test addons locally:

```bash
# Build in watch mode
npm run dev

# Your changes will be reflected after reloading addons in Wealthfolio
```

## 📚 API Reference

### Context Methods

#### `sidebar.addItem(config)`

Add an item to the application sidebar.

**Parameters:**

- `config.id` (string): Unique identifier
- `config.label` (string): Display text
- `config.icon` (string): Host-supported icon token, such as `receipt`,
  `chart-bar`, or `calendar-dots`
- `config.route` (string): Navigation route
- `config.order` (number): Display order (optional)
- `config.onClick` (function): Click handler (optional)

**Returns:** `SidebarItemHandle` with `remove()` method

#### `router.add(route)`

Register a new route in the application.

**Parameters:**

- `route.path` (string): Route path pattern
- `route.render` (function): `({ root, location }) => void` — mount your React
  root into the provided `root` element

#### `onDisable(callback)`

Register cleanup callback for addon disable.

**Parameters:**

- `callback` (function): Cleanup function

### Data Access APIs

All data access is performed through the context's `api` property:

```typescript
const ctx = getAddonContext();

// Portfolio data
const holdings = await ctx.api.portfolio.getHoldings(accountId);
const accounts = await ctx.api.accounts.getAll();

// Market data
const quotes = await ctx.api.marketData.getQuoteHistory(symbol);
const profile = await ctx.api.marketData.getAssetProfile(assetId);

// Financial planning
const goals = await ctx.api.goals.getAll();
const limits = await ctx.api.financialPlanning.getContributionLimit();

// Settings
const settings = await ctx.api.getSettings();

// Logging and debugging
ctx.api.logger.info('Operation completed successfully');
ctx.api.logger.error('Error occurred:', error);
ctx.api.logger.debug('Debug info:', debugData);
```

### Available API Methods

| Method                                          | Description                                               | Permission Required  |
| ----------------------------------------------- | --------------------------------------------------------- | -------------------- |
| `portfolio.getHoldings(accountId)`              | Get portfolio holdings for account                        | `portfolio`          |
| `portfolio.getHolding(accountId, assetId)`      | Get specific holding                                      | `portfolio`          |
| `portfolio.calculatePerformanceSummary(params)` | Calculate performance metrics                             | `portfolio`          |
| `portfolio.getIncomeSummary()`                  | Get income summary data                                   | `portfolio`          |
| `accounts.getAll()`                             | Get all account information                               | `accounts`           |
| `accounts.create(account)`                      | Create new account                                        | `accounts`           |
| `activities.getAll(accountId?)`                 | Get activity history (optionally filtered to one account) | `activities`         |
| `activities.create(activity)`                   | Create new activity                                       | `activities`         |
| `marketData.getQuoteHistory(symbol)`            | Get historical quotes                                     | `market-data`        |
| `marketData.getAssetProfile(assetId)`           | Get asset profile                                         | `market-data`        |
| `marketData.searchTicker(query)`                | Search for tickers                                        | `market-data`        |
| `goals.getAll()`                                | Get financial goals                                       | `financial-planning` |
| `goals.getFunding(goalId)`                      | Get funding rules for a goal                              | `financial-planning` |
| `goals.saveFunding(goalId, rules)`              | Save funding rules for a goal                             | `financial-planning` |
| `settings.get()`                                | Get app settings                                          | `settings`           |
| `query.getClient()`                             | Get shared QueryClient instance                           | None                 |

> Tip: `activities.getAll` accepts an optional account ID string to scope
> results to a single account. The SDK normalizes this for both desktop (Tauri)
> and web runtimes—no need to wrap it in an array.

### Activity search filters

`activities.search` accepts either a single value or an array for `accountIds`
and `activityTypes`. The host normalizes these inputs for both desktop and web
runtime paths and will also accept an explicit `symbol` filter when you want to
target a single ticker without a free-form search query. Sorting takes a single
sort object and defaults to `{ id: "date", desc: true }` when none is provided.
The first two parameters are pagination controls: `page` is a zero-based index
(use `0` for the first page) and `pageSize` is the number of rows to return. For
exports you can pass a large `pageSize` (for example, 1000) alongside `page` = 0
to fetch a wide slice in one call.

```typescript
const response = await ctx.api.activities.search(
  0,
  50,
  {
    accountIds: 'account-1', // single string or string[] both work
    activityTypes: ['BUY', 'DIVIDEND'],
    symbol: 'AAPL',
  },
  '', // optional keyword search (ignored when empty)
  { id: 'date', desc: true },
);
```

### Logger API

The SDK provides a comprehensive logging system:

```typescript
const ctx = getAddonContext();

// Log levels: 'error', 'warn', 'info', 'debug'
ctx.api.logger.error('Critical error occurred', { error, context });
ctx.api.logger.warn('Warning message', additionalData);
ctx.api.logger.info('Information message');
ctx.api.logger.debug('Debug information', debugObject);

// Set log level (for development)
ctx.api.logger.setLevel('debug');

// Check if logging level is enabled
if (ctx.api.logger.isLevelEnabled('debug')) {
  ctx.api.logger.debug('Expensive debug operation', expensiveData);
}
```

### Shared QueryClient Integration

The SDK provides access to Wealthfolio's shared React Query client for
consistent data fetching and caching:

```typescript
// Access the shared QueryClient instance
const sharedQueryClient = context.api.query.getClient();

// Wrap your components with QueryClientProvider
const MyAddonWrapper = () => {
  return (
    <QueryClientProvider client={sharedQueryClient}>
      <MyAddonComponent />
    </QueryClientProvider>
  );
};

// Use React Query hooks in your components
function MyAddonComponent() {
  const { data: accounts, isLoading } = useQuery({
    queryKey: ['accounts'],
    queryFn: () => ctx.api.accounts.getAll()
  });

  const { data: holdings } = useQuery({
    queryKey: ['holdings', selectedAccountId],
    queryFn: () => ctx.api.portfolio.getHoldings(selectedAccountId),
    enabled: !!selectedAccountId
  });

  // Your component logic here
}
```

**Benefits of Shared QueryClient:**

- **Consistent Caching**: Share cache with the main application
- **Performance**: Avoid duplicate API calls across addons
- **Synchronization**: Real-time updates when data changes
- **Memory Efficiency**: Single cache instance for all data

## 🔄 Migration Guide

### From v1.0.0 to v1.1.0

#### Context Access

```typescript
// Before
import ctx from '@wealthfolio/addon-sdk';

// After (recommended)
import { getAddonContext } from '@wealthfolio/addon-sdk';
const ctx = getAddonContext();
```

#### Type Imports

```typescript
// Before
import type { AddonContext, AddonManifest } from '@wealthfolio/addon-sdk';

// After (more specific)
import type { AddonContext } from '@wealthfolio/addon-sdk';
import type { AddonManifest } from '@wealthfolio/addon-sdk/manifest';
```

## 👩‍💻 Development Guide

### Setting Up Development Environment

#### 1. Create New Addon Project

```bash
# Create a new directory for your addon
mkdir my-portfolio-addon
cd my-portfolio-addon

# Initialize package.json
npm init -y

# Install the SDK and peer dependencies
npm install @wealthfolio/addon-sdk
npm install --save-dev typescript @types/react vite @vitejs/plugin-react

# Install React (peer dependency)
npm install react react-dom
npm install --save-dev @types/react-dom
```

#### 2. Project Setup

Create the essential configuration files:

**tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

**vite.config.ts**

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'MyPortfolioAddon',
      fileName: 'addon',
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        '@tanstack/react-query',
        '@wealthfolio/addon-sdk',
        '@wealthfolio/ui',
        'date-fns',
        'lucide-react',
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'recharts',
      ],
    },
    outDir: 'dist',
    minify: 'terser',
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
});
```

**package.json scripts**

```json
{
  "scripts": {
    "dev": "vite build --watch",
    "build": "vite build",
    "type-check": "tsc --noEmit",
    "package": "npm run build && zip -r addon.zip manifest.json dist/ assets/ README.md"
  }
}
```

#### 3. Development Workflow

```bash
# Start development mode (watches for changes)
npm run dev

# Type checking
npm run type-check

# Build for production
npm run build

# Create distribution package
npm run package
```

### SDK Development (Contributing to the SDK)

If you want to contribute to the SDK itself:

#### 1. Clone and Setup

```bash
# Clone the Wealthfolio repository
git clone https://github.com/wealthfolio/wealthfolio.git
cd wealthfolio/packages/addon-sdk

# Install dependencies
pnpm install

# Build the SDK
pnpm build

# Watch for changes during development
pnpm dev
```

#### 2. SDK Build Process

The SDK uses `tsup` for building with the following configuration:

```typescript
// tsup.config.ts
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    types: 'src/types.ts',
    permissions: 'src/permissions.ts',
  },
  format: ['esm'],
  dts: true, // Generate TypeScript declarations
  clean: true, // Clean dist folder before build
  sourcemap: true, // Generate source maps
  minify: false, // Keep code readable for debugging
  target: 'es2020',
  external: ['react'], // Don't bundle React
});
```

#### 3. Testing Your Changes

```bash
# Build the SDK
pnpm build

# Link for local testing
npm link

# In your addon project
npm link @wealthfolio/addon-sdk

# Test your changes
npm run dev
```

#### 4. Publishing to NPM

The SDK is published to the npm registry. For maintainers:

```bash
# Ensure you're logged in to npm
npm login

# Update version in package.json
npm version patch  # or minor/major

# Build and publish
npm run build
npm publish

# Or for beta releases
npm publish --tag beta
```

### Debugging Tips

#### 1. Enable Debug Logging

```typescript
// In your addon
const ctx = getAddonContext();
ctx.api.logger.setLevel('debug');
ctx.api.logger.debug('Debug information:', data);
```

#### 2. Development Console

Access the browser's developer console for debugging:

- Open Wealthfolio
- Press F12 or right-click → Inspect
- Check Console tab for addon logs
- Use Network tab to monitor API calls

#### 3. Hot Reloading

During development, enable hot reloading:

```typescript
// Add to your addon's main file
if (process.env.NODE_ENV === 'development') {
  // Enable hot module replacement
  if (module.hot) {
    module.hot.accept();
  }
}
```

### Common Development Patterns

#### 1. Error Handling

```typescript
import { getAddonContext } from '@wealthfolio/addon-sdk';

async function fetchPortfolioData() {
  const ctx = getAddonContext();

  try {
    // Get all accounts first, then holdings for each
    const accounts = await ctx.api.accounts.getAll();
    const holdings = await Promise.all(
      accounts.map((account) => ctx.api.portfolio.getHoldings(account.id)),
    ).then((results) => results.flat());
    return holdings;
  } catch (error) {
    ctx.api.logger.error('Failed to fetch holdings:', error);

    // Handle different error types
    if (error.code === 'PERMISSION_DENIED') {
      // Show permission error to user
    } else if (error.code === 'NETWORK_ERROR') {
      // Handle network issues
    }

    throw error;
  }
}
```

#### 2. Resource Cleanup

```typescript
export default function enable(context: AddonContext) {
  const subscriptions: (() => void)[] = [];

  // Add event listeners
  const unsubscribe = context.events.subscribe('portfolio.updated', handler);
  subscriptions.push(unsubscribe);

  // Cleanup on disable
  context.onDisable(() => {
    subscriptions.forEach((unsub) => unsub());
    context.api.logger.info('Addon cleaned up successfully');
  });
}
```

#### 3. State Management

```typescript
// Use React state for component-level state
const [loading, setLoading] = useState(false);
const [data, setData] = useState<PortfolioData | null>(null);

// Use context API for global addon state
const AddonStateContext = createContext<AddonState | null>(null);

export function AddonProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AddonState>(initialState);

  return (
    <AddonStateContext.Provider value={{ state, setState }}>
      {children}
    </AddonStateContext.Provider>
  );
}
```

### Performance Best Practices

#### 1. Lazy Loading

```typescript
// Lazy load heavy components
const HeavyChart = lazy(() => import('./components/HeavyChart'));

// Use React.Suspense
<Suspense fallback={<div>Loading chart...</div>}>
  <HeavyChart data={chartData} />
</Suspense>
```

#### 2. Efficient Data Fetching

```typescript
// Use React Query or SWR for caching
import { useQuery } from 'react-query';

function usePortfolioData(accountId: string) {
  return useQuery(
    ['portfolio', accountId],
    () => ctx.api.portfolio.getHoldings(accountId),
    {
      staleTime: 5 * 60 * 1000, // 5 minutes
      cacheTime: 10 * 60 * 1000, // 10 minutes
    },
  );
}
```

#### 3. Bundle Optimization

```typescript
// vite.config.ts - optimize chunks
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          charts: ['chart.js', 'd3'],
        },
      },
    },
  },
});
```

## 🤝 Contributing

We welcome contributions to improve the addon SDK!

### Development Setup

1. **Fork and Clone**

   ```bash
   git clone https://github.com/yourusername/wealthfolio.git
   cd wealthfolio/packages/addon-sdk
   ```

2. **Install Dependencies**

   ```bash
   pnpm install
   ```

3. **Make Changes**

   ```bash
   # Start development mode
   pnpm dev

   # Run type checking
   pnpm lint

   # Build for testing
   pnpm build
   ```

4. **Testing Your Changes**

   ```bash
   # Link the SDK locally for testing
   npm link

   # In your test addon project
   npm link @wealthfolio/addon-sdk
   ```

5. **Submit Changes**
   - Create a feature branch
   - Make your changes with tests
   - Update documentation
   - Submit a pull request

### Contribution Guidelines

- **Code Style**: Follow TypeScript best practices
- **Testing**: Add tests for new features
- **Documentation**: Update README and JSDoc comments
- **Versioning**: Follow semantic versioning
- **Backwards Compatibility**: Maintain API compatibility when possible

## 📋 NPM Registry Information

### Package Details

| Field            | Value                                                             |
| ---------------- | ----------------------------------------------------------------- |
| **Package Name** | `@wealthfolio/addon-sdk`                                          |
| **Scope**        | `@wealthfolio`                                                    |
| **Registry**     | [npmjs.com](https://www.npmjs.com/package/@wealthfolio/addon-sdk) |
| **License**      | MIT                                                               |
| **Repository**   | [GitHub](https://github.com/wealthfolio/wealthfolio)              |

### Version History

We follow [Semantic Versioning](https://semver.org/) (SemVer):

- **MAJOR**: Breaking changes to public API
- **MINOR**: New features, backwards compatible
- **PATCH**: Bug fixes, backwards compatible

#### Version Compatibility

| SDK Version | Wealthfolio Version | Node.js   | React   |
| ----------- | ------------------- | --------- | ------- |
| 1.0.x       | >= 1.0.0            | >= 18.0.0 | ^18.0.0 |
| 0.9.x       | >= 0.9.0            | >= 16.0.0 | ^17.0.0 |

### Installation from Registry

#### Stable Release

```bash
# Latest stable version
npm install @wealthfolio/addon-sdk

# Specific version
npm install @wealthfolio/addon-sdk@1.0.0

# Version range
npm install @wealthfolio/addon-sdk@^1.0.0
```

#### Beta/Preview Releases

```bash
# Latest beta version
npm install @wealthfolio/addon-sdk@beta

# Specific beta version
npm install @wealthfolio/addon-sdk@1.1.0-beta.1
```

#### Development Version

```bash
# Install directly from GitHub
npm install github:wealthfolio/wealthfolio#main

# Or from a specific Wealthfolio commit
npm install github:wealthfolio/wealthfolio#COMMIT_SHA
```

### Package Information Commands

```bash
# View package information
npm info @wealthfolio/addon-sdk

# View all available versions
npm view @wealthfolio/addon-sdk versions --json

# View latest version
npm view @wealthfolio/addon-sdk version

# View package dependencies
npm view @wealthfolio/addon-sdk dependencies

# Check for outdated packages
npm outdated @wealthfolio/addon-sdk
```

### Publishing Information (For Maintainers)

#### Prerequisites

```bash
# Login to npm (maintainers only)
npm login

# Verify login
npm whoami

# Check publishing permissions
npm access list packages @wealthfolio
```

#### Release Process

```bash
# 1. Update version
npm version patch  # or minor/major

# 2. Build the package
npm run build

# 3. Test the build
npm pack
tar -tf wealthfolio-addon-sdk-*.tgz

# 4. Publish to npm
npm publish

# 5. For beta releases
npm publish --tag beta

# 6. Tag the release
git tag v$(node -p "require('./package.json').version")
git push --tags
```

#### Distribution Tags

| Tag      | Purpose            | Command                   |
| -------- | ------------------ | ------------------------- |
| `latest` | Stable releases    | `npm publish`             |
| `beta`   | Beta releases      | `npm publish --tag beta`  |
| `alpha`  | Alpha releases     | `npm publish --tag alpha` |
| `next`   | Next major version | `npm publish --tag next`  |

#### Package Metrics

View package statistics:

- **Downloads**:
  [npm-stat.com](https://npm-stat.com/charts.html?package=@wealthfolio/addon-sdk)
- **Bundle Size**:
  [bundlephobia.com](https://bundlephobia.com/package/@wealthfolio/addon-sdk)
- **Dependencies**:
  [npm.anvaka.com](https://npm.anvaka.com/#/view/2d/@wealthfolio/addon-sdk)

### Security

#### Vulnerability Scanning

```bash
# Check for vulnerabilities
npm audit

# Fix vulnerabilities
npm audit fix

# View security advisories
npm audit --audit-level=moderate
```

#### Package Integrity

```bash
# Verify package integrity
npm pack --dry-run

# Check package contents
npm pack && tar -tf *.tgz
```

### Support and Maintenance

#### Package Support Policy

- **Latest Major Version**: Full support with new features and bug fixes
- **Previous Major Version**: Security fixes and critical bug fixes for 12
  months
- **Older Versions**: Community support only

#### Maintenance Schedule

- **Regular Updates**: Monthly minor releases
- **Security Patches**: As needed (within 48 hours for critical issues)
- **Major Releases**: Quarterly or as needed for breaking changes

#### Getting Help

1. **Documentation**: Check this README and
   [docs](https://docs.wealthfolio.app/addons)
2. **Issues**:
   [GitHub Issues](https://github.com/wealthfolio/wealthfolio/issues)
3. **Discussions**:
   [GitHub Discussions](https://github.com/wealthfolio/wealthfolio/discussions)
4. **Discord**: [Community Discord](https://discord.gg/wealthfolio)
5. **Email**: [support@wealthfolio.app](mailto:support@wealthfolio.app)

## 📄 License

MIT - see [LICENSE](LICENSE) for details.

## 🔗 Links

- [Wealthfolio Homepage](https://wealthfolio.app)
- [Addon Gallery](https://wealthfolio.app/addons)
- [Documentation](https://docs.wealthfolio.app/addons)
- [GitHub Repository](https://github.com/wealthfolio/wealthfolio)
- [Issue Tracker](https://github.com/wealthfolio/wealthfolio/issues)

## 💬 Support

- [Discord Community](https://discord.gg/wealthfolio)
- [GitHub Discussions](https://github.com/wealthfolio/wealthfolio/discussions)
- [Email Support](mailto:support@wealthfolio.app)

## 🔧 Troubleshooting

### Common Issues

#### 1. Module Resolution Errors

**Error**: `Cannot resolve module '@wealthfolio/addon-sdk'`

**Solutions**:

```bash
# Clear npm cache
npm cache clean --force

# Delete node_modules and reinstall
rm -rf node_modules package-lock.json
npm install

# Check Node.js version (requires >= 18.0.0)
node --version
```

#### 2. TypeScript Compilation Errors

**Error**: `Cannot find type definitions`

**Solutions**:

```typescript
// Ensure proper TypeScript configuration
{
  "compilerOptions": {
    "moduleResolution": "bundler", // or "node"
    "allowSyntheticDefaultImports": true,
    "esModuleInterop": true
  }
}

// Use explicit type imports
import type { AddonContext } from '@wealthfolio/addon-sdk';
```

#### 3. React Peer Dependency Warnings

**Error**: `React version mismatch`

**Solutions**:

```bash
# Install correct React version
npm install react@^18.0.0 react-dom@^18.0.0

# Check installed versions
npm list react react-dom
```

#### 4. Build Errors

**Error**: `Vite build fails with external dependencies`

**Solutions**:

```typescript
// vite.config.ts
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['react', 'react-dom', '@wealthfolio/addon-sdk'],
    },
  },
});
```

#### 5. Permission Denied Errors

**Error**: `Permission denied for API call`

**Solutions**:

```json
// Add required permissions to manifest.json
{
  "permissions": [
    {
      "category": "portfolio",
      "functions": ["holdings"],
      "purpose": "Access portfolio data for analytics"
    }
  ]
}
```

#### 6. Context Not Available

**Error**: `getAddonContext() returns undefined`

**Solutions**:

```typescript
// Ensure you're calling it within addon context
function MyComponent() {
  useEffect(() => {
    // Call context inside useEffect or event handlers
    const ctx = getAddonContext();
    // ... use context
  }, []);
}

// Don't call at module level
// const ctx = getAddonContext(); // ❌ Wrong
```

### Development Environment Issues

#### 1. Hot Reload Not Working

```bash
# Ensure dev mode is enabled
npm run dev

# Check if files are being watched
ls -la dist/  # Should update when you save files
```

#### 2. Addon Not Loading in Wealthfolio

1. Check the addon package structure:

   ```
   addon.zip
   ├── manifest.json ✓
   ├── dist/
   │   └── addon.js ✓
   └── assets/ (optional)
   ```

2. Validate manifest.json:

   ```bash
   # Check JSON syntax
   cat manifest.json | jq .
   ```

3. Check Wealthfolio logs:
   - Open Developer Tools (F12)
   - Look for addon-related errors
   - Check Network tab for failed requests

#### 3. API Calls Failing

```typescript
// Add error handling and logging
try {
  const accounts = await ctx.api.accounts.getAll();
  const data = await ctx.api.portfolio.getHoldings(accounts[0]?.id);
  ctx.api.logger.info('Data loaded successfully', { count: data.length });
} catch (error) {
  ctx.api.logger.error('API call failed', {
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString(),
  });
}
```

### Performance Issues

#### 1. Slow Addon Loading

```typescript
// Use code splitting and lazy loading
const HeavyComponent = lazy(() => import('./HeavyComponent'));

// Reduce bundle size
// vite.config.ts
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          utils: ['lodash', 'date-fns'],
        },
      },
    },
  },
});
```

#### 2. Memory Leaks

```typescript
// Proper cleanup in useEffect
useEffect(() => {
  const subscription = ctx.events.subscribe('update', handler);

  return () => {
    subscription.unsubscribe(); // ✓ Clean up
  };
}, []);

// Cleanup on addon disable
context.onDisable(() => {
  // Clean up all resources
  clearInterval(intervalId);
  subscription.unsubscribe();
});
```

### Getting Help

If you're still experiencing issues:

1. **Check Version Compatibility**:

   ```bash
   npm list @wealthfolio/addon-sdk
   ```

2. **Create Minimal Reproduction**:
   - Create a simple addon that reproduces the issue
   - Share the code and error logs

3. **Search Existing Issues**:
   - Check [GitHub Issues](https://github.com/wealthfolio/wealthfolio/issues)
   - Look for similar problems and solutions

4. **Provide Complete Information**:
   - SDK version
   - Node.js version
   - Operating system
   - Error messages with stack traces
   - Minimal reproduction steps
