# @wealthfolio/ui

Wealthfolio's shared UI component library built on top of shadcn/ui and Tailwind
CSS.

## Overview

The `@wealthfolio/ui` package provides a complete design system for Wealthfolio
addons, ensuring consistent styling and user experience across all extensions.

## Features

- 🎨 **Complete shadcn/ui components** - All essential UI primitives
- 💰 **Wealthfolio-specific components** - Financial data display components
- 🎭 **Consistent theming** - Dark/light mode support with CSS variables
- 📦 **Tree-shakeable** - Import only what you need
- 🔧 **TypeScript ready** - Full type safety

## Installation

For addons:

```bash
npm install @wealthfolio/ui
```

## Package Structure

```
packages/ui/
├── src/
│   ├── components/
│   │   ├── ui/           # All shadcn/ui components
│   │   ├── icons.tsx     # Wealthfolio icons
│   │   ├── amount-display.tsx
│   │   └── ...           # Financial components
│   ├── lib/
│   │   └── utils.ts      # Utility functions (cn, etc.)
│   └── index.ts          # Main exports
├── components.json       # Shadcn CLI config
├── tailwind.config.js    # Tailwind config
└── package.json
```

## Usage

### Basic Components

```tsx
import { Button, Card, CardContent } from "@wealthfolio/ui";

function MyComponent() {
  return (
    <Card>
      <CardContent>
        <Button>Click me</Button>
      </CardContent>
    </Card>
  );
}
```

### Financial Components

```tsx
import { AmountDisplay, GainAmount, GainPercent } from "@wealthfolio/ui";

function FinancialData() {
  return (
    <div>
      <AmountDisplay amount={1234.56} currency="USD" />
      <GainAmount gain={123.45} />
      <GainPercent percentage={5.67} />
    </div>
  );
}
```

### Complete Addon Example

```tsx
// Import components
import { Button, Card, CardContent, AmountDisplay } from "@wealthfolio/ui";

function MyAddon() {
  return (
    <Card>
      <CardContent>
        <Button>Click me</Button>
        <AmountDisplay amount={1234.56} currency="USD" />
      </CardContent>
    </Card>
  );
}
```

### Benefits for Addon Developers

- ✅ **Automatic theming** - Inherits light/dark mode from main app
- ✅ **Consistent styling** - Same look and feel as main app
- ✅ **Financial components** - Ready-to-use components for financial data
- ✅ **Tree-shakeable** - Only bundles what you use
- ✅ **TypeScript support** - Full type safety

### Styling

Wealthfolio loads its stylesheet into the addon sandbox. Addons using
`@wealthfolio/ui` do not need to import `@wealthfolio/ui/styles`; doing so can
bundle Tailwind CSS a second time. The package CSS export is not used by the
addon runtime, so do not add a CSS copy step to the package build solely for
addon styling.

## Components

### Core UI (shadcn/ui)

All standard shadcn/ui components with Wealthfolio's Flexoki theme applied:

- `Button` - Various button styles and sizes
- `Card` - Container component with header/content/footer
- `Input` - Form input with validation styles
- `Label` - Accessible form labels
- `Badge` - Status indicators
- `Dialog` - Modal dialogs
- `Dropdown` - Dropdown menus
- `Table` - Data tables
- `Tabs` - Tab navigation
- And many more...

### Financial Components

- `AmountDisplay` - Formatted currency display
- `GainAmount` - Gain/loss amount with color coding
- `GainPercent` - Percentage change display
- `Icons` - Financial and general purpose icons

### Utility Functions

- `cn()` - Class name utility with tailwind-merge
- Theme utilities and helpers

## Theming

The components use CSS variables for theming. The main app provides the theme
context, so addons automatically inherit the current theme (light/dark mode).

The host theme is defined in `apps/frontend/src/globals.css` and is loaded into
the addon sandbox by `apps/frontend/src/addons/iframe/addon-sandbox-entry.tsx`.

## Development

### Basic Commands

```bash
# Build the package
pnpm build

# Watch for changes
pnpm dev

# Type check
pnpm lint
```

### For Main App Development

#### Adding new components to UI package:

```bash
cd packages/ui
npx shadcn-ui@latest add button
```

#### Adding components to main app (legacy):

```bash
npx shadcn-ui@latest add button
```

#### Updating Components

When updating shared components:

1. Edit in `packages/ui/src/components/`
2. Build the package: `cd packages/ui && npm run build`
3. Components automatically available to addons

### Development Workflow

#### Adding New Component

1. `cd packages/ui`
2. `npx shadcn-ui@latest add [component]`
3. Customize if needed for Wealthfolio
4. Export in `src/index.ts`
5. Build and test with addons

#### Updating Existing Component

1. Edit in `packages/ui/src/components/`
2. `npm run build`
3. Test with addons
4. Update version if breaking changes

## Best Practices

### For Addon Developers

1. Always import from `@wealthfolio/ui` instead of creating custom components
2. Import styles once in your main addon file
3. Use provided utility functions for consistent styling
4. Leverage financial components for data display

### For Core Development

1. Add new components to UI package, not main app
2. Use semantic versioning for UI package updates
3. Test changes against official addons
4. Document new components in README

## Updating Components

```bash
cd packages/ui
npx shadcn-ui@latest add [component]
npx shadcn@latest add accordion alert-dialog alert avatar badge button calendar checkbox collapsible command  dialog dropdown-menu form hover-card  input label popover progress radio-group scroll-area select separator sheet skeleton switch table tabs textarea toggle-group toggle tooltip
npm run build
```

This strategy ensures consistent UI/UX across the entire Wealthfolio ecosystem
while maintaining developer efficiency and user experience.

### Dialog and sheet safe areas

`DialogContent`, `AlertDialogContent`, and `SheetContent` now render inside a
shared viewport that excludes system bars and display cutouts. This includes
physical right/left and logical inline-start/inline-end sheets. The popup keeps
its own padding and flex/grid layout: `p-0` and custom footers remain supported.
Portaled and nested dialogs each get their own safe viewport.

Mobile dialogs fit their content by default, up to `90dvh` or the usable safe
viewport, whichever is smaller. For forms with persistent actions, use a flex
column with `shrink-0` header/footer and a `min-h-0 flex-auto overflow-y-auto`
body. Set a maximum through `--overlay-max-height`; an explicit viewport height
is appropriate for a workspace that needs it. Side drawers retain their
full-height layout.

Migration from per-screen safe-area padding:

- Remove system-bar padding from the popup and its footer. Keep ordinary design
  spacing such as `pb-4`; the shared viewport reserves the system space once.
- Use `[--overlay-max-height:85dvh]` for a preferred maximum height, rather than
  `max-h-[85dvh]`. Existing addon `max-h-*` classes retain their previous
  behavior; migrating to the variable also constrains them to the safe viewport.
  The shared maximum caps that preference to the usable viewport. A numeric or
  CSS `style.maxHeight` is also capped, including Base UI state-dependent style
  callbacks.
- Remove manual status-bar padding from side-sheet headers and close buttons.
- Intentionally full-screen surfaces can pass `safeArea={false}` to
  `DialogContent` or `SheetContent`; they then own their own inset handling.

Hosts can supply physical `--inset-top`, `--inset-right`, `--inset-bottom`, and
`--inset-left` CSS variables. Each falls back to the matching browser
`env(safe-area-inset-*, 0px)` value. Host CSS variables do not cross iframe
documents; an addon remains bounded by its host-provided iframe viewport. The
optional `--keyboard-inset-bottom` reserves keyboard coverage using the larger
of the keyboard and system-bar insets. Android's existing bridge reports only
the keyboard portion covering the WebView, so a host that already resizes it
does not reserve the keyboard twice. Keyboard coverage changes overlay bounds
without resizing the application's WebView or moving the main navigation.
Android 10 and earlier use resize mode to enable compatible IME reporting;
Android 11 and later retain the existing window input mode. Mobile dialogs now
forward popup attributes, focus options and inline styles to their sheet popup,
matching desktop dialogs. Popups scroll by default when height-constrained;
compositions with their own scrolling body can still use `overflow-hidden`.
Overlay surfaces intentionally stop at safe bounds, with the backdrop visible in
the system-bar strips; they do not extend header gradients under those bars. The
same normalized Android edge variables also supply shell/page top and side
clearance, including navigation bars that move to a side in landscape. The
shared frame also follows vertical `visualViewport` resize and scroll events.
This keeps actions above the iOS keyboard when WKWebView leaves the layout
viewport unchanged; visual and native keyboard coverage use the larger value.

Button sizes keep a 44px minimum target on coarse-pointer devices and in compact
layouts below 1024px. The viewport fallback covers older WebViews that report a
mouse despite having a touchscreen. Calendar controls retain their cell-size
bounds so seven columns still fit. Custom icon controls outside `Button` should
provide the same touch clearance.
