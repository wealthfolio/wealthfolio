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

Every addon exports an enable function that receives a context object:

```typescript
import type { AddonContext } from '@wealthfolio/addon-sdk';
import { Icons } from '@wealthfolio/ui';

export default function enable(ctx: AddonContext) {
  // Access financial data
  const accounts = await ctx.api.accounts.getAll();

  // Add navigation item
  const sidebarItem = ctx.sidebar.addItem({
    id: 'my-addon',
    icon: <Icons.Blocks className="h-5 w-5" />,
    label: 'My Tool',
    route: '/my-addon'
  });

  // Register route
  ctx.router.add({
    path: '/my-addon',
    component: MyComponent
  });

  // Listen to events
  const unlisten = ctx.api.events.portfolio.onUpdateComplete(() => {
    // Handle portfolio updates
  });

  // Cleanup function
  return {
    disable() {
      sidebarItem.remove();
      unlisten();
    }
  };
}
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

#### 3. User Approval

During installation, users see both declared and detected permissions, then
approve or reject the addon installation.

## Available APIs

The addon context provides access to 14 domain-specific APIs:

```typescript
interface AddonContext {
  sidebar: SidebarAPI;
  router: RouterAPI;
  onDisable: (callback: () => void) => void;
  api: {
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
  "permissions": ["accounts.getAll", "portfolio.getHoldings"],
  "sdkVersion": "1.0.0"
}
```

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

Standard Vite configuration externalizes React:

```typescript
// vite.config.ts
export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: "src/addon.tsx",
      fileName: () => "addon.js",
      formats: ["es"],
    },
    rollupOptions: {
      external: ["react", "react-dom"],
      plugins: [
        externalGlobals({
          react: "React",
          "react-dom": "ReactDOM",
        }),
      ],
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
