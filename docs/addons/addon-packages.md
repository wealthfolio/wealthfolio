# Addon Development Packages

A comprehensive guide to the packages available for developing Wealthfolio
addons.

## Core Packages

### @wealthfolio/addon-sdk

The main SDK for addon development that provides TypeScript types and APIs.

```bash
npm install @wealthfolio/addon-sdk
```

**What it provides:**

- `AddonContext` interface and types
- `HostAPI` interface for all financial APIs
- Permission system types and utilities
- Data type definitions (Account, Holding, Activity, etc.)
- Event system types

**Key exports:**

```typescript
import type {
  AddonContext,
  AddonEnableFunction,
  HostAPI,
  Permission,
  RiskLevel,
} from "@wealthfolio/addon-sdk";
```

**Version:** 1.0.0 **Peer Dependencies:** React ^18.0.0

### @wealthfolio/ui

UI component library based on shadcn/ui and Tailwind CSS.

```bash
npm install @wealthfolio/ui
```

**What it provides:**

- Pre-built UI components consistent with Wealthfolio's design
- Radix UI primitives
- Tailwind CSS utilities
- Financial-specific components

**Key components:**

```typescript
import {
  Button,
  Card,
  Dialog,
  Input,
  Table,
  Badge,
  Progress,
  Tabs,
} from "@wealthfolio/ui";
```

**Included libraries:**

- All Radix UI components
- Lucide React icons
- React Query integration
- Recharts for data visualization
- Date picker components

## Development Tools

### @wealthfolio/addon-dev-tools

Development CLI and hot-reload server for addon development.

```bash
npm install -D @wealthfolio/addon-dev-tools
```

**What it provides:**

- `wealthfolio` CLI command
- Hot-reload development server
- Project scaffolding templates
- Build and package utilities

**CLI commands:**

```bash
# Create new addon
wealthfolio create my-addon

# Start development server
wealthfolio dev

# Build addon
wealthfolio build

# Package for distribution
wealthfolio package
```

## Required Dependencies

### React Ecosystem

All addons must use React 18:

```json
{
  "dependencies": {
    "react": "^19.1.1",
    "react-dom": "^19.1.1"
  }
}
```

**Note:** React and ReactDOM are externalized during build and provided by the
host application.

### Build Tools

Standard Vite-based build setup:

```json
{
  "devDependencies": {
    "@vitejs/plugin-react": "^4.4.1",
    "vite": "^6.2.7"
  }
}
```

### TypeScript

TypeScript support with proper types:

```json
{
  "devDependencies": {
    "typescript": "^5.8.3",
    "@types/node": "^22.14.0",
    "@types/react": "^19.1.11",
    "@types/react-dom": "^18.3.0"
  }
}
```

## Available UI Libraries

### Radix UI Components

All Radix UI components are available through `@wealthfolio/ui`:

```typescript
// Dialog components
import { Dialog, DialogContent, DialogTrigger } from "@wealthfolio/ui";

// Form components
import { Input, Label, Checkbox, Select } from "@wealthfolio/ui";

// Navigation
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@wealthfolio/ui";

// Feedback
import { Alert, AlertDescription, Toast } from "@wealthfolio/ui";
```

### Icons

Lucide React icons are included:

```typescript
import { TrendingUp, DollarSign, PieChart, Settings } from 'lucide-react';

export default function MyAddon() {
  return (
    <div>
      <TrendingUp className="h-4 w-4" />
      <span>Portfolio Growth</span>
    </div>
  );
}
```

### Data Visualization

Recharts for charts and graphs:

```typescript
import { LineChart, Line, XAxis, YAxis, CartesianGrid } from 'recharts';

export default function PerformanceChart({ data }) {
  return (
    <LineChart width={400} height={300} data={data}>
      <CartesianGrid strokeDasharray="3 3" />
      <XAxis dataKey="date" />
      <YAxis />
      <Line type="monotone" dataKey="value" stroke="#8884d8" />
    </LineChart>
  );
}
```

## Data Fetching

### React Query

Available through `@wealthfolio/ui`:

```typescript
import { useQuery } from '@tanstack/react-query';

export default function enable(ctx: AddonContext) {
  const AccountsDisplay = () => {
    const { data: accounts } = useQuery({
      queryKey: ['accounts'],
      queryFn: () => ctx.api.accounts.getAll()
    });

    return <div>{/* render accounts */}</div>;
  };

  // Register component...
}
```

## Styling

### Tailwind CSS

All Tailwind classes are available:

```typescript
export default function MyComponent() {
  return (
    <div className="flex flex-col space-y-4 p-6 bg-white rounded-lg shadow-md">
      <h2 className="text-xl font-semibold text-gray-900">
        Portfolio Summary
      </h2>
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-green-50 p-4 rounded">
          <span className="text-green-600 font-medium">Total Value</span>
        </div>
      </div>
    </div>
  );
}
```

### CSS Utilities

Utility classes from included packages:

```typescript
import { cn } from '@wealthfolio/ui'; // clsx + tailwind-merge

export default function Card({ className, children }) {
  return (
    <div className={cn("rounded-lg border bg-card p-6", className)}>
      {children}
    </div>
  );
}
```

## Date and Time

### date-fns

Available through `@wealthfolio/ui`:

```typescript
import { format, parseISO, isAfter } from 'date-fns';

export default function ActivityList({ activities }) {
  return (
    <div>
      {activities.map(activity => (
        <div key={activity.id}>
          <span>{format(parseISO(activity.date), 'MMM dd, yyyy')}</span>
          <span>{activity.type}</span>
        </div>
      ))}
    </div>
  );
}
```

## External Dependencies

### Adding Custom Dependencies

You can add other npm packages to your addon:

```json
{
  "dependencies": {
    "@wealthfolio/addon-sdk": "1.0.0",
    "@wealthfolio/ui": "1.0.0",
    "react": "^19.1.1"
  }
}
```

**Important:** External dependencies are bundled with your addon, increasing
size.

## Package Configuration

### Standard package.json

Template for addon package.json:

```json
{
  "name": "my-addon",
  "version": "1.0.0",
  "description": "My Wealthfolio addon",
  "type": "module",
  "main": "dist/addon.js",
  "keywords": ["wealthfolio", "addon"],
  "license": "MIT",
  "scripts": {
    "build": "vite build",
    "dev": "vite build --watch",
    "dev:server": "wealthfolio dev",
    "clean": "rm -rf dist *.zip",
    "package": "zip -r my-addon.zip manifest.json dist/ README.md",
    "bundle": "npm run clean && npm run build && npm run package",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@wealthfolio/addon-sdk": "1.0.0",
    "@wealthfolio/ui": "1.0.0",
    "react": "^19.1.1",
    "react-dom": "^19.1.1"
  },
  "devDependencies": {
    "@wealthfolio/addon-dev-tools": "^1.0.0",
    "@types/node": "^22.14.0",
    "@types/react": "^19.1.11",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.4.1",
    "typescript": "^5.8.3",
    "vite": "^6.2.7"
  }
}
```

### Vite Configuration

Standard vite.config.ts:

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const hostProvidedDependencies = [
  "@tanstack/react-query",
  "@wealthfolio/addon-sdk",
  "@wealthfolio/ui",
  "date-fns",
  "lucide-react",
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  "recharts",
];

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    lib: {
      entry: "src/addon.tsx",
      fileName: () => "addon.js",
      formats: ["es"],
    },
    rollupOptions: {
      external: hostProvidedDependencies,
    },
    outDir: "dist",
    minify: false,
    sourcemap: true,
  },
});
```

## Version Compatibility

### SDK Versions

Always use compatible versions:

| SDK Version | Wealthfolio Version | React Version |
| ----------- | ------------------- | ------------- |
| 1.0.0       | 1.0.0+              | ^19.1.1       |

### Breaking Changes

Major version increments indicate breaking changes:

- **1.x.x**: Current stable API
- **2.x.x**: Future breaking changes (when available)

## Package Installation

### Quick Start

Create a new addon with all packages:

```bash
# Using CLI (recommended)
npx @wealthfolio/addon-dev-tools create my-addon

# Manual setup
mkdir my-addon && cd my-addon
npm init -y
npm install @wealthfolio/addon-sdk @wealthfolio/ui react react-dom
npm install -D @wealthfolio/addon-dev-tools @vitejs/plugin-react vite typescript
```

### Workspace Setup

For monorepo development:

```json
{
  "dependencies": {
    "@wealthfolio/addon-sdk": "workspace:*",
    "@wealthfolio/ui": "workspace:*",
    "@wealthfolio/addon-dev-tools": "workspace:*"
  }
}
```

## Development Server & Hot Reload

### @wealthfolio/addon-dev-tools Development Server

The addon development tools provide a built-in development server with hot
reload capabilities for seamless addon development.

#### Starting the Development Server

Using npm scripts (recommended):

```bash
npm run dev:server
```

Using CLI directly:

```bash
npx wealthfolio dev
# or if installed globally
wealthfolio dev
```

#### How Hot Reload Works

The development server automatically:

1. **Watches for file changes** in your addon source code
2. **Rebuilds the addon** when changes are detected
3. **Notifies Wealthfolio** to reload the addon
4. **Preserves application state** where possible

**Supported file types:**

- `.tsx`, `.ts` - TypeScript/React components
- `.json` - Manifest and configuration files
- `.css` - Stylesheets

#### Development Server Configuration

The development server runs on ports 3001-3003 by default:

```typescript
// Auto-discovery process
const DEVELOPMENT_PORTS = [3001, 3002, 3003];

// Server will bind to first available port
// Wealthfolio automatically discovers addons on these ports
```

#### Package.json Scripts

Standard development scripts setup:

```json
{
  "scripts": {
    "dev:server": "wealthfolio dev",
    "build": "vite build",
    "clean": "rm -rf dist",
    "bundle": "npm run build && wealthfolio package",
    "lint": "tsc --noEmit"
  }
}
```

#### Hot Reload Features

**Instant Feedback:**

- Component changes reflect immediately
- No need to manually reload Wealthfolio
- Preserves addon state when possible

**Error Handling:**

- Build errors shown in terminal
- Runtime errors displayed in Wealthfolio dev console
- Graceful fallback on reload failures

**Development Utilities:**

```javascript
// Available in browser console during development
__ADDON_DEV__.getStatus(); // Check development mode status
__ADDON_DEV__.reloadAddons(); // Manual addon reload
__ADDON_DEV__.discoverAddons(); // Force addon discovery
```

#### Development Workflow

1. **Start development server:**

   ```bash
   npm run dev:server
   ```

2. **Open Wealthfolio** - addons are auto-discovered

3. **Make changes** to your addon code

4. **See changes instantly** in Wealthfolio

5. **Check terminal** for build status and errors

#### Debug Information

The development server provides detailed logging:

```
🚀 Addon development server starting...
📁 Watching: /path/to/addon/src
🔧 Building addon...
✅ Build successful
🌐 Server running on http://localhost:3001
📡 Addon available at: http://localhost:3001/addon.js
```

#### Troubleshooting Development Server

**Server won't start:**

```bash
# Check if ports are available
lsof -i :3001
lsof -i :3002
lsof -i :3003

# Kill conflicting processes
kill -9 <PID>
```

**Hot reload not working:**

```bash
# Check Wealthfolio console for discovery logs
# Verify addon manifest is valid
cat manifest.json | jq .

# Manual reload
discoverAddons()  # In browser console
```

**Build errors:**

```bash
# Check TypeScript errors
npm run lint

# Clean rebuild
npm run clean && npm run build
```

#### Production vs Development

| Feature       | Development | Production  |
| ------------- | ----------- | ----------- |
| Source Maps   | ✅ Enabled  | ❌ Disabled |
| Minification  | ❌ Disabled | ✅ Enabled  |
| Hot Reload    | ✅ Active   | ❌ N/A      |
| File Watching | ✅ Active   | ❌ N/A      |
| Dev Server    | ✅ Required | ❌ N/A      |
| Bundle Size   | Larger      | Optimized   |

#### Advanced Development Setup

**Multiple Addons:**

```bash
# Terminal 1
cd addon-1 && npm run dev:server

# Terminal 2
cd addon-2 && npm run dev:server

# Terminal 3
cd addon-3 && npm run dev:server
```

**Custom Port Configuration:**

```typescript
// vite.config.ts
export default defineConfig({
  server: {
    port: 3001, // Specify exact port
  },
  // ... rest of config
});
```

**Environment Variables:**

```bash
# .env.development
VITE_DEBUG=true
VITE_API_BASE_URL=http://localhost:8080
```

```typescript
// Access in addon code
const debug = import.meta.env.VITE_DEBUG;
```

## Troubleshooting

### Common Issues

**Version conflicts:**

```bash
npm ls react  # Check React version
npm install react@^19.1.1  # Fix version
```

**Missing peer dependencies:**

```bash
npm install --peer-deps  # Install peer dependencies
```

**Build errors:**

```bash
npm run clean && npm run build  # Clean rebuild
```

### Getting Help

- Check package versions match requirements
- Ensure TypeScript configuration is correct
- Verify Vite configuration externalizes React
- Review addon manifest permissions
