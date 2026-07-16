## Prerequisites

```bash
# Check Node.js version (requires 20+)
node --version

# Check pnpm
pnpm --version

# Install pnpm if needed
npm install -g pnpm
```

Requirements:

- Node.js 20+ and pnpm
- Wealthfolio desktop app (optional but recommended: running in development mode
  for live reload and testing)
- Basic TypeScript and React knowledge
- Code editor (VS Code recommended)

## Start Wealthfolio (Recommended)

For the best development experience with live reload and testing, start
Wealthfolio in addon development mode:

```bash
# Clone Wealthfolio repository (if not already done)
git clone https://github.com/wealthfolio/wealthfolio.git
cd wealthfolio

# Install dependencies
pnpm install

# Start in addon development mode
VITE_ENABLE_ADDON_DEV_MODE=true pnpm tauri dev
```

This enables:

- Live addon reload when files change
- Better error messages and debugging
- Automatic addon discovery
- Console logging for development

> **Note:** For browser-only development (without Tauri), you can use
> `pnpm dev:addons` instead.

## Create New Addon

```bash
# Navigate to development directory
cd ~/Documents/WealthfolioAddons

# Create addon using CLI
npx @wealthfolio/addon-dev-tools create hello-world-addon

# Navigate and install
cd hello-world-addon
pnpm install
```

This will scaffold a new addon project with the following structure:

```
hello-world-addon/
├── src/
│   ├── addon.tsx           # Main addon entry point
│   ├── components/         # React components
│   ├── hooks/              # React hooks
│   ├── pages/              # Addon pages
│   ├── utils/              # Utility functions
│   └── types/              # Type definitions
├── dist/                   # Built files (generated)
├── manifest.json           # Addon metadata and permissions
├── package.json            # NPM package configuration
├── vite.config.ts          # Build configuration
├── tsconfig.json           # TypeScript configuration
└── README.md               # Documentation
```

## Manifest File

`manifest.json` defines metadata, the pages your addon contributes, and any data
permissions it needs:

```json
{
  "id": "hello-world-addon",
  "name": "Hello World Addon",
  "version": "1.0.0",
  "description": "My first Wealthfolio addon",
  "author": "Your Name",
  "main": "dist/addon.js",
  "sdkVersion": "3.6.1",
  "minWealthfolioVersion": "3.6.1",
  "enabled": true,
  "contributes": {
    "routes": [{ "id": "hello-world" }],
    "links": {
      "sidebar": [
        {
          "id": "hello-world",
          "route": "hello-world",
          "label": "Hello World",
          "icon": "puzzle-piece",
          "order": 100
        }
      ]
    }
  },
  "permissions": []
}
```

Navigation is **declarative**: the host reads `contributes.routes` and
`contributes.links` from the manifest and renders your sidebar entry _without_
running your addon (this is what enables lazy activation). A **route** is a
durable addon page; a **link** places a route into a host slot (only `"sidebar"`
is consumed today) and references a declared route by `id`. The runtime
`router.add({ id })` in the next section MUST use the same id as the declared
route.

The host derives the route URL from the manifest `id`, so this root page is
mounted at `/addons/hello-world-addon`. Omit `path` for the root; nested pages
use a relative suffix such as `"path": "reports/:year"`.

> **Permissions:** `ui`, `query`, `toast`, `logger`, and `storage` are implicit
> **baseline capabilities** — you do not declare them. Only data categories
> (`accounts`, `portfolio`, `activities`, …) plus `files`, `network`, `secrets`,
> `events`, `snapshots`, and `settings` require a permission entry and user
> consent.

## Main Addon File

`src/addon.tsx` contains the addon logic:

```typescript
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AddonContext, AddonEnableFunction } from '@wealthfolio/addon-sdk';

function HelloWorldPage() {
  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-4xl font-bold mb-4">Hello Wealthfolio</h1>
      <p className="text-xl mb-8">Your first addon is working.</p>

      <div className="border rounded-lg p-6">
        <h2 className="text-lg font-semibold mb-2">Success</h2>
        <p>You've successfully created and loaded your first addon.</p>
      </div>
    </div>
  );
}

// The host owns a single React root per addon and mounts the route `component`
// itself (with no ctx), so capture the context at enable time for the route
// wrapper to hand down. Do NOT call createRoot yourself.
let addonCtx: AddonContext | undefined;

const HelloWorldRoute = () => (
  <QueryClientProvider client={addonCtx!.api.query.getClient() as QueryClient}>
    <HelloWorldPage />
  </QueryClientProvider>
);

const enable: AddonEnableFunction = (ctx) => {
  addonCtx = ctx;

  // The route `id` MUST match `contributes.routes[].id` in manifest.json.
  // The sidebar entry is declared in the manifest, so there is no
  // ctx.sidebar.addItem call here.
  ctx.router.add({
    id: 'hello-world',
    path: '/addons/hello-world-addon',
    component: HelloWorldRoute,
  });

  ctx.api.logger.info('Hello World addon loaded');

  // The host owns the React root, so there is nothing to unmount here.
  ctx.onDisable(() => {
    addonCtx = undefined;
    ctx.api.logger.info('Hello World addon disabled');
  });
};

export default enable;
```

> **Do not call `createRoot` yourself.** The host owns the single React root and
> mounts your `component` into it. A per-route `createRoot` leaves an orphaned
> React tree whose re-renders never reach the DOM — the classic "buttons do
> nothing" bug. The component receives a `{ location }` prop (an
> `AddonRouteLocation`), and the sandbox has **no** react-router provider, so do
> not call `useLocation()` / `useParams()`. `render` still exists as a legacy
> imperative escape hatch, but `component` is preferred.

## Start Development

```bash
# Start development server (recommended)
pnpm dev:server
```

Output:

```
Wealthfolio Addon Development Server
Addon: hello-world-addon
Server: http://localhost:3001
Watching for changes...
```

### Hot Reload Features

- File watching in `src/` directory
- Fast rebuilds with Vite
- Hot Module Replacement for component updates
- Auto-discovery by Wealthfolio
- Error recovery with overlay messages

### Available Commands

```bash
pnpm dev:server   # Start development server (recommended)
pnpm build        # Production build
pnpm type-check   # Run TypeScript checks
pnpm lint         # Run ESLint
pnpm format       # Run Prettier
pnpm bundle       # Bundle addon for distribution
```

Verify in Wealthfolio:

1. Open Wealthfolio in addon development mode with
   `VITE_ENABLE_ADDON_DEV_MODE=true pnpm tauri dev`
2. Check sidebar for "Hello World"
3. Click to load addon page
4. Check console for log message

## Add Data Access

For data access, it's recommended to use
[TanStack Query](https://tanstack.com/query/latest).

First, install TanStack Query in your addon:

```bash
pnpm add @tanstack/react-query@^5.90.0
```

Update `src/addon.tsx` to access portfolio data using TanStack Query:

```typescript
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import type {
  Account,
  AddonContext,
  AddonEnableFunction,
} from '@wealthfolio/addon-sdk';

function HelloWorldPage({ ctx }: { ctx: AddonContext }) {
  const {
    data: accounts = [],
    isLoading,
    isError,
    error,
    refetch
  } = useQuery<Account[]>({
    queryKey: ['accounts'],
    queryFn: () => ctx.api.accounts.getAll(),
    onError: (error) => {
      ctx.api.logger.error('Failed to load accounts:', error);
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
  });

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <h1 className="text-3xl font-bold mb-6">Hello Wealthfolio</h1>

      <div className="border rounded-lg p-6 mb-8">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold">Portfolio Summary</h2>
          <button
            onClick={() => refetch()}
            disabled={isLoading}
            className="px-3 py-1 text-sm border rounded hover:bg-gray-50 disabled:opacity-50"
          >
            {isLoading ? 'Loading...' : 'Refresh'}
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center space-x-2">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-900"></div>
            <span>Loading accounts...</span>
          </div>
        ) : isError ? (
          <div className="text-red-600">
            <p>Failed to load accounts: {error?.message}</p>
            <button
              onClick={() => refetch()}
              className="mt-2 px-3 py-1 text-sm bg-red-100 text-red-700 rounded hover:bg-red-200"
            >
              Try Again
            </button>
          </div>
        ) : (
          <div>
            <p className="mb-4">
              You have {accounts.length} account{accounts.length !== 1 ? 's' : ''}:
            </p>

            {accounts.length > 0 ? (
              <div className="grid gap-3">
                {accounts.map((account) => (
                  <div key={account.id} className="border rounded-lg p-4">
                    <div className="flex justify-between items-center">
                      <div>
                        <h3 className="font-semibold">{account.name}</h3>
                        <p className="text-sm text-muted-foreground">
                          {account.currency} • {account.isActive ? 'Active' : 'Inactive'}
                        </p>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-semibold">
                          {account.totalValue?.toLocaleString() || 'N/A'}
                        </div>
                        <div className="text-sm text-muted-foreground">Total Value</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground">
                No accounts found. Add an account in Wealthfolio to see data.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// The host mounts this route component itself with no ctx, so the wrapper
// pulls the captured context and shares one QueryClient across navigations.
let addonCtx: AddonContext | undefined;

const HelloWorldRoute = () => (
  <QueryClientProvider client={addonCtx!.api.query.getClient() as QueryClient}>
    <HelloWorldPage ctx={addonCtx!} />
  </QueryClientProvider>
);

const enable: AddonEnableFunction = (ctx) => {
  addonCtx = ctx;

  ctx.router.add({
    id: 'hello-world',
    path: '/addons/hello-world-addon',
    component: HelloWorldRoute,
  });

  ctx.onDisable(() => {
    addonCtx = undefined;
  });
};

export default enable;
```

## Update Permissions

Update `manifest.json` to include account access. Each permission is an object
declaring a data `category`, the `functions` you call, and a human-readable
`purpose` shown to the user at install time:

```json
{
  "id": "hello-world-addon",
  "name": "Hello World Addon",
  "version": "1.0.0",
  "description": "My first Wealthfolio addon",
  "author": "Your Name",
  "main": "dist/addon.js",
  "sdkVersion": "3.6.1",
  "minWealthfolioVersion": "3.6.1",
  "enabled": true,
  "contributes": {
    "routes": [{ "id": "hello-world" }],
    "links": {
      "sidebar": [
        {
          "id": "hello-world",
          "route": "hello-world",
          "label": "Hello World",
          "icon": "puzzle-piece",
          "order": 100
        }
      ]
    }
  },
  "permissions": [
    {
      "category": "accounts",
      "functions": ["getAll"],
      "purpose": "Display account summary"
    }
  ]
}
```

There is no `ui` permission — reading portfolio/UI navigation is part of the
baseline. Only the `accounts` data access needs declaring here.

## Build and Package

```bash
# Build for production
pnpm build

# Package for distribution
pnpm bundle
```

Creates `dist/hello-world-addon.zip` for installation.

## Debugging and Development Tools

### Browser Developer Tools

Access full debugging capabilities:

```typescript
// Use console for debugging
ctx.api.logger.info("Debug message");
ctx.api.logger.error("Error message");

// Access React DevTools
// Components will show up in React DevTools extension
```

### Error Handling

```typescript
const enable: AddonEnableFunction = (ctx) => {
  try {
    // Your addon code
  } catch (error) {
    ctx.api.logger.error("Addon error: " + (error as Error).message);
    // Handle gracefully
  }
};
```

> **Sandbox error surfaces.** Because addons run in an isolated sandbox, the
> host classifies common failures and surfaces them both as a toast and as an
> inline panel in the addon frame: **blocked storage** (a `localStorage` call —
> use `ctx.api.storage` instead), an **unknown API** (calling a method the host
> doesn't expose), or an **unavailable route surface** (navigating to a route
> whose runtime `router.add({ id })` doesn't match a declared
> `contributes.routes[].id`). Watch for these when a page renders blank or a
> control does nothing.

### Development Server Features

- Port: `http://localhost:3001`
- CORS configured for Wealthfolio
- Source maps for debugging
- Real-time TypeScript checking
- Hot Module Replacement

## IDE Setup

### VS Code (Recommended)

Recommended extensions:

- TypeScript and JavaScript Language Features
- ES7+ React/Redux/React-Native snippets
- Tailwind CSS IntelliSense
- Auto Rename Tag
- Error Lens

Create `.vscode/settings.json`:

```json
{
  "typescript.preferences.importModuleSpecifier": "relative",
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode"
}
```

## Code Quality and Testing

### Manual Testing

1. Start development server
2. Open Wealthfolio
3. Navigate to your addon
4. Test all features
5. Check console for errors

### Code Quality Commands

```bash
# Type checking
pnpm type-check

# Linting
pnpm lint

# Formatting
pnpm format
```

## Configuration Files

### Package.json Scripts

```json
{
  "scripts": {
    "dev:server": "wealthfolio dev",
    "build": "vite build",
    "type-check": "tsc --noEmit",
    "lint": "eslint src --ext .ts,.tsx",
    "format": "prettier --write \"src/**/*.{ts,tsx}\"",
    "bundle": "pnpm build && zip -r addon.zip manifest.json dist/"
  }
}
```

### TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2020",
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
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"],
  "references": [{ "path": "./tsconfig.node.json" }]
}
```

### Vite Build Configuration

```typescript
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Host-provided dependencies are marked `external` so they are NOT bundled —
// the sandbox provides the real instances at runtime (one shared React, one
// shared QueryClient). Keep this list aligned with `hostDependencies` in
// manifest.json.
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
      formats: ["es"],
      fileName: () => "addon.js",
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

## Next Steps

You now understand:

- Project structure and development workflow
- Permission system and security model
- Hot reload development
- API integration for portfolio data
- UI integration with navigation

Continue with:

- [API Reference](/docs/addons/api-reference) - All available APIs
- [Examples](https://github.com/wealthfolio/wealthfolio-addons/tree/main/official) -
  Real addon implementations
