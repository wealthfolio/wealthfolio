# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.11.0] - 2026-10-22

### Added

- Theme tokens for components: `Button`, `Input`, `Textarea`, `Select`,
  `Toggle`, `Switch`, `Card`, `CardTitle`, `Badge`, `Dialog`, `AlertDialog`,
  `Sheet`, the popups (select, menu, popover, hover card, command, combobox) and
  `AnimatedToggleGroup` read their corners, field height, surfaces, borders and
  shadows from CSS variables (`--button-*`, `--control-*`, `--field-*`,
  `--switch-*`, `--card-*`, `--popup-*`, `--overlay-*`, `--dialog-radius`,
  `--sheet-bg`, `--badge-radius`, `--segmented-*`). The host's Classic theme
  sets them to the previous look. Classes an addon passes still win, in dark
  mode too: an outline `Button`'s own background or border is no longer replaced
  by the variant's dark colours. `Button` also sets `data-variant` and
  `data-size`, as shadcn's does.
- `AnimatedToggleGroup` items take an optional `aria-label`, for options whose
  visible label needs more context.
- `Button` variant `field`, for a button that opens a picker in a form: it takes
  `SelectTrigger`'s surface, border, radius, label weight and hover, so a picker
  matches the selects beside it.
- `cardSurfaceClassName`, exported with `Card`: the card's surface, border,
  radius and shadow as classes, for an element that must stay something else (a
  link, say) but look like a card.
- `IncomeSummary.unconvertedCurrencies`, the currencies whose income has no
  exchange rate to the summary's currency. Requires a Wealthfolio release that
  ships it (unreleased at the time of writing).
- Status surface colours for callouts, banners and pills: `--success-subtle`,
  `--warning-subtle`, `--destructive-subtle` and `--info-subtle`, each with
  `-foreground` (text) and `-border`. Text on a tint of a status colour
  (`--warning` at 10%) does not reach 4.5:1 contrast; these pairs do, in light
  and dark. `Alert`'s `destructive`, `warning` and `success` variants show them
  as a translucent surface with a hairline border; `error` is now the same as
  `destructive`. `statusSurfaceVariants({ status })` gives that surface (fill,
  hairline and top highlight, no text colour) for panels and cards that carry a
  status but hold other content.
- `Badge` variants `success-subtle`, `warning-subtle`, `destructive-subtle` and
  `info-subtle`: pale pills on the status surfaces, for confidences, changes and
  states.
- `DirectionProvider` and `useDirection` from `@wealthfolio/ui`. The addon
  sandbox now sets `<html dir>` and provides the host's reading direction, so
  `@wealthfolio/ui` menus, selects, tabs and sliders follow it. Read it with
  `useDirection()` to mirror an addon's own layout.
- `SheetContent` takes `side="inline-start"` and `side="inline-end"`, which
  follow the reading direction; `inline-end` is the new default. `left` and
  `right` stay physical, as in shadcn.
- `stripBidiControls(text)` from `@wealthfolio/ui` removes the invisible bidi
  marks formatted values carry in right-to-left pages, for code that measures or
  cuts them.

### Changed

- **Breaking:** `@wealthfolio/ui` components move from Radix to
  [Base UI](https://base-ui.com) and follow its API.
  - `asChild` is replaced by `render` on `Button`, `Badge`, `Item`,
    `DropdownMenuItem` and every trigger and close part:
    `<Badge render={<a href="…" />}>Docs</Badge>`. A link that looks like a
    button is the link itself with `buttonVariants()`, not a `Button`, which
    gives what it renders button semantics. `Button` renders `type="button"`;
    submit buttons need `type="submit"`.
  - State attributes are Base UI's instead of Radix's `data-state`:
    `data-checked`/`data-unchecked` (`Switch`, `Checkbox`, `RadioGroupItem`),
    `data-active` (`TabsTrigger`), `aria-pressed` (`Toggle`, `ToggleGroupItem`),
    `data-panel-open` (collapsible and accordion triggers), `data-popup-open`
    (popover, menu and select triggers), `data-open`/`data-closed` (panels,
    popups and overlays, with `--collapsible-panel-height` and
    `--accordion-panel-height`), and `data-disabled`. Popups use
    `--anchor-width`, `--available-height` and `--transform-origin` instead of
    the Radix variables, and keep 5px from the viewport edge.
  - `Checkbox` takes `indeterminate` instead of `checked="indeterminate"`;
    `ToggleGroup` takes `multiple` and array values instead of `type` and a
    string (the old form still works, deprecated), and `Accordion` likewise (no
    `collapsible`; single items always close); `AvatarFallback` takes `delay`
    instead of `delayMs`; `Tabs`, `RadioGroup` and `ToggleGroup` change
    callbacks receive `(value, eventDetails)`. Tabs still activate as arrow keys
    move focus; for manual activation, `<Tabs activationMode="manual">` becomes
    `<TabsList activateOnFocus={false}>`.
  - Single-select `ToggleGroup` items are toggle buttons (`aria-pressed`)
    instead of radios, and `Separator` is announced as a separator.
  - Tooltip and hover card delays are set on the trigger (`delay`, `closeDelay`)
    or, for tooltips, on `TooltipProvider` (`delay` instead of `delayDuration`);
    `HoverCard` no longer takes `openDelay`/`closeDelay`. Their content takes
    `side`, `align`, `sideOffset` and `alignOffset` (`TooltipContent` also
    `collisionPadding`), renders in a portal, and uses `--transform-origin`.
    `TooltipPortal` is removed.
  - Tooltips are visual labels: the content no longer has `role="tooltip"` and
    is not announced as the trigger's description, so give the trigger an
    accessible name.
  - Content focus and dismiss callbacks move: `onOpenAutoFocus` and
    `onCloseAutoFocus` become `initialFocus` and `finalFocus` on the content;
    `onEscapeKeyDown` and `onInteractOutside` become checks of
    `eventDetails.reason` in the root's `onOpenChange(open, eventDetails)`,
    calling `eventDetails.cancel()` to stay open, and `Dialog` and `Sheet` take
    `disablePointerDismissal`. `PopoverAnchor` is replaced by `anchor` on
    `PopoverContent`.
  - `DropdownMenuItem` takes `onClick` instead of `onSelect`, and
    `closeOnClick={false}` instead of `event.preventDefault()` to stay open
    (`onSelect` still works, deprecated). `DropdownMenuLabel` and `SelectLabel`
    must sit inside a group.
  - `Select` shows the selected item's label only when given `items` (an array
    of `{ value, label }` or a value-to-label record); `onValueChange` can
    receive `null`; `SelectContent` takes `alignItemWithTrigger` instead of
    `position`.
  - `ScrollArea` wraps its children in Base UI's scroll content; `ScrollBar`
    takes Base UI's scrollbar props and shows while the area is hovered or
    scrolled.
  - `AlertDialogAction` still closes the dialog; call
    `event.preventBaseUIHandler()` in `onClick` to keep it open. `ActionConfirm`
    and `DeleteConfirm` take a single element as `button`.
- `Alert` lays out as a grid: an icon placed first sits in a tinted circle,
  centred on the title and description at any padding or font size (set a
  compact alert's size on `Alert`, e.g. `text-xs`). With an `AlertTitle`, the
  title takes the status colour and `AlertDescription` the page's text colour;
  without one, the sentence keeps the status colour. `AlertAction` is a column
  after the text, so a text button never covers it. `AlertTitle` renders a `div`
  instead of an `h5`. The icon is no longer absolutely positioned, so
  `[&>svg]:absolute`-style overrides are not needed.
- `@wealthfolio/ui` controls show keyboard focus as a 2px outline in the
  `--ring` colour instead of a box-shadow ring, so it stays visible in
  forced-colors mode. To hide it on a control placed inside another focus
  indicator, pass `focus-visible:outline-none`; `focus-visible:ring-0` no longer
  hides it. `SelectTrigger` and the dialog and sheet close buttons show it on
  keyboard focus only (`:focus-visible`), not after a click.
- `Button`'s `destructive` variant is a pale red button (red text on
  `--destructive-subtle`, a deeper tint on hover) instead of solid red with
  white text. `AlertDialogAction` takes `variant`, so a dialog's destructive
  confirm is `<AlertDialogAction variant="destructive">` rather than
  `bg-destructive` overrides.
- Dialog, AlertDialog and Sheet backdrops are shadcn's light overlay: 10% black
  with a light blur instead of 50–80% black. `AlertDialogAction` and
  `AlertDialogCancel` take `size` as well as `variant`; `AlertDialogAction`
  still closes the dialog (shadcn's does not).
- `SelectContent` opens its list over the field (`alignItemWithTrigger` defaults
  to `true`, as in shadcn), with the selected tick on the right so the texts
  line up; pass `alignItemWithTrigger={false}` to open below it.
  `DropdownMenuItem variant="destructive"` highlights on the pale red status
  surface. `PopoverHeader`, `PopoverTitle` and `PopoverDescription` are added.
- `TooltipContent` is shadcn's dark bubble: `--foreground` fill, `--background`
  text, 12 px text, an arrow and a 20rem maximum width. Muted text inside a
  tooltip needs `text-background/70` rather than `text-muted-foreground`, which
  is unreadable on the dark fill. The arrow takes the bubble's colour, so a
  `bg-destructive` override keeps a matching arrow. The bubble's last child is
  now the arrow: use `flex flex-col gap-*` instead of `space-y-*` on
  `TooltipContent`, or the last line gains a bottom margin.
- `CommandDialog` takes `title` and `description`, rendered for screen readers
  only (defaults "Command Palette" and "Search for a command to run..."), and
  `showCloseButton` (default `true`). Pass your own title through `title` rather
  than rendering a `DialogTitle` inside it. Icons in a `CommandItem` keep a
  `size-*` class they set; others are still 16 px.
- Controls follow shadcn's Base UI sources on Wealthfolio's look. `Button` has a
  transparent 1 px border (outline and filled buttons share one box, so buttons
  are 2 px wider), nudges down 1 px while pressed, and keeps its hover fill
  while the menu, select or popover it opens is open (`aria-haspopup` and
  `aria-expanded`); a collapsible or accordion trigger stays unfilled.
  `Checkbox`, `RadioGroupItem` and `Switch` have a larger invisible hit area,
  and a label with `peer-data-disabled:` now dims next to a disabled radio.
  `Input` is Base UI's `Input`, so it works inside a Base UI `Field`. `Textarea`
  is a function component with `data-slot="textarea"`. `Switch` exposes `size`
  as a `data-size` attribute. `ToggleGroup` takes `spacing` (gap in spacing
  steps, default 1; 0 joins the items) and `orientation`. `TabsList` takes
  `variant="line"` (an underline instead of the pill), tabs support
  `orientation="vertical"`, and `tabsListVariants` is exported. Fields, select
  triggers, toggles and switches show `aria-invalid`.
- The remaining primitives carry shadcn's data-slots and parts. Added:
  `CardAction` (a header holding it becomes two columns with the action on the
  right), `AvatarBadge`, `AvatarGroup`, `AvatarGroupCount`, `Badge` variants
  `ghost` and `link`, and `Item` size `xs`. A `TableRow` keeps its hover fill
  while a menu or popover inside it is open. `Card`, `Table`, `Skeleton` and the
  `InputOTP` parts are function components (refs still pass through).
  `data-horizontal:` and `data-vertical:` variants match `data-orientation`, as
  in shadcn. A size set by a variant class overrides a call site's plain size
  class, so components keep sizes callers may override as plain classes.
- `DropdownMenuContent` and `DropdownMenuSubContent` take shadcn's rounded menu
  look: 16 px corners, a hairline ring and a large soft shadow instead of a
  border. Items, checkbox and radio items and sub-triggers have 12 px corners
  and roomier padding (`px-3 py-2`); `inset` indents to `pl-9.5`. Check and
  radio indicators stay on the left.
- `SelectContent`, `PopoverContent`, `HoverCardContent` and `Command` take the
  same rounded look as menus: 16 px corners, a hairline ring and a soft shadow
  instead of a border. Select and command rows have 12 px corners and `py-2`
  (command rows `px-3`); select rows keep `pl-2` so their text lines up with the
  field when the list opens over it.
- `PopoverContent` is at most as tall as the space beside its trigger
  (`--available-height`) and scrolls beyond it, as menus and select lists do, so
  a tall popover no longer runs off the screen.
- `DataTable` and `DataGrid` are drawn on a `Card` (its surface, border, radius
  and shadow). Their sticky header, footer and pinned cells paint the card
  surface, and the table's header row loses its muted tint. Pass `card={false}`
  to `DataTable` for a table already inside a card or dialog to keep the
  previous bordered frame.
- `Spinner`, shadcn's spinner on the Loader2 icon. It is decorative
  (`aria-hidden`) unless you pass a translated `aria-label`, which makes it a
  `status`. `ProgressIndicator` uses it and is now built on `DialogContent` (no
  close button), with a primary progress bar instead of a red-to-yellow
  gradient.
- `EmptyPlaceholder` is deprecated in favour of shadcn's `Empty` (it still
  renders, as a wrapper over `Empty`): `Empty` > `EmptyHeader` >
  `EmptyMedia variant="icon"` (the muted icon circle), `EmptyTitle`,
  `EmptyDescription`, then `EmptyContent` for actions.
  `<EmptyPlaceholder.Icon name="Wallet" />` becomes
  `<EmptyMedia variant="icon"><Icons.Wallet /></EmptyMedia>`.
- `Combobox` and its parts (`ComboboxInput`, `ComboboxContent`, `ComboboxList`,
  `ComboboxItem`, `ComboboxChips` and the rest) from shadcn, on Base UI's
  combobox. `SearchableSelect` keeps its props and is built on it: typing
  filters on the option labels, and arrow keys and Enter pick an option.
- **Breaking:** `Autocomplete` is removed; use `Combobox`.
- In dark mode `--success-subtle-foreground` is green-200, the step the other
  status text colours use, so success text reads green rather than near-white.
- `IncomeSummary` totals and breakdowns leave out income that has no exchange
  rate to the summary's currency, instead of counting it as if it were already
  in that currency. `byCurrency` still includes it.
- `IncomeSummary.yoyGrowth` is `null` for `YTD` and `LAST_YEAR` when the year
  before has no income to compare with, instead of `0`.
- `DateRangeSelector` and `IntervalSelector` carry `data-no-swipe-drag`, so on a
  page that switches views with a horizontal swipe, a sideways drag on them
  scrolls their presets instead. On phones `DateRangeSelector` uses the
  `compact` size, as `IntervalSelector` does.

### Deprecated

These keep addons built against earlier SDKs working on the Base UI components.
The app does not use them; they are removed in the next major SDK version.

- `EmptyPlaceholder` (props and compound forms), rendered with `Empty`. Without
  it, an addon that imports it fails to load.
- `DropdownMenuItem` `onSelect`: called on click; calling `preventDefault()` on
  its event keeps the menu open, as with Radix.
- `ToggleGroup` `type`: `type="single"` takes and returns a string (`""` when
  nothing is pressed) and `type="multiple"` maps to `multiple`.

## [3.9.0] - 2026-09-27

### Added

- `PortfolioAPI.getNetWorth(date?)` returns net worth as a balance sheet. It
  covers every account type, so it is where addons read credit card balances
  (`getLatestValuations()` covers holdings accounts only).

- `NetworkRequest.timeoutSecs` for longer-running addon HTTP requests. Defaults
  to 10 seconds; positive integer values are capped server-side at 120 seconds.
- `SpendingAPI.getReport()` and `SpendingAPI.searchCashActivities()` for
  read-only aggregate reports and categorized transaction searches. Transaction
  search requires the high-risk `activities.searchCashActivities` permission.
  Reports include `baseCurrency` to identify the currency of all monetary
  amounts.

## [3.8.0] - 2026-09-07

### Added

- Optional `ActivityImport.isExternal` boundary override for transfer and credit
  imports.
- `ExchangeRatesAPI.getRatesForDates(pairs)` for batched date-specific FX-rate
  lookups, with per-pair errors and Wealthfolio's standard FX resolution rules.
- `ctx.api.spending` (`SpendingAPI`) — `isEnabled()`, `getCategories()`,
  `getRules()`, `saveRule()`, `deleteRule()`, `rerunRules()`, letting addons
  classify activities into the user's existing spend-category taxonomy via
  Wealthfolio's categorization-rules engine. Requires a Wealthfolio release that
  ships this bridge (unreleased at the time of writing). See the
  [Spend Categorization API reference](../../docs/addons/addon-api-reference.md#spend-categorization-api).
- `registerTranslations()` and `useAddonTranslation()` for translating addon UI
  strings. Resources live on a dedicated i18next instance inside the addon
  sandbox, isolated from the host catalog; the language follows the host
  setting. Requires a Wealthfolio release that ships this sandbox runtime
  (unreleased at the time of writing). See the
  [Addon Localization guide](../../docs/addons/addon-localization.md).
- Optional `status` and `needsReview` fields on `ActivityCreate` and
  `ActivityUpdate`.

### Deprecated

- `Account.balance` is now optional and deprecated. The backend never populated
  it, so it was always `undefined` at runtime despite being typed `number`. Use
  `getLatestValuations()` or `getNetWorth()`.

### Changed

- `ActivityUpdate.asset` now has explicit patch semantics: omit it to preserve
  the current asset, or pass an empty object to clear the asset association.
- Host-provided `@wealthfolio/addon-sdk` and `@wealthfolio/ui` dependency ranges
  are now `^3.8.0`.

## [3.7.0] - 2026-08-10

Wealthfolio 3.7 adds private packaged assets while preserving the documented
v3.6 addon runtime contract. See the
[v3.6 → v3.7 migration guide](../../docs/addons/addon-migration-guide-v3.6-to-v3.7.md).

### Added

- `AddonContext.assets` (`AddonAssets`) with `list()`, `has()`, `getBlob()`, and
  lifecycle-scoped `getUrl()` methods.
- `AddonAsset` metadata and `ExtractedAddon.assets` for host/runtime package
  integration.
- Automatic indexing of `assets/**` and `dist/assets/**`, including local CSS
  `url(...)` rewriting for sandbox-safe Blob URLs.

### Changed

- Addon enable functions and returned disable callbacks may be asynchronous.
- Development loading uses coherent, generation-addressed runtime package
  snapshots. Wealthfolio 3.7 requires `@wealthfolio/addon-dev-tools` 3.7 or
  newer for live development.

### Compatibility

- Existing v3.6 bundles remain supported. Addons that use `ctx.assets` must set
  `minWealthfolioVersion` to `3.7.0` or newer.

## [3.6.1] - 2026-07-06

Follow-up to the v3.6 sandbox release: sidebar icons are now a typed, curated
set. See the
[v3.5 → v3.6 migration guide](../../docs/addons/addon-migration-guide-v3.5-to-v3.6.md).

### Breaking

- **`SidebarItemConfig.icon`** is now a typed `AddonIconName` (was `string`).
  Names outside the curated set fail type-checking; unknown or omitted names
  render a neutral `caret-right` fallback at runtime.

### Added

- `AddonIconName` type and `ADDON_ICON_NAMES` — the curated set of duotone
  Phosphor sidebar icon names, exported from the package entry point.

## [3.6.0] - 2026-07-04

Addons now run in an isolated sandbox iframe. This is a **breaking** release for
addons that register routes. See the
[v3.5 → v3.6 migration guide](../../docs/addons/addon-migration-guide-v3.5-to-v3.6.md).

### Breaking

- **Route registration**: `RouteConfig.component` (a lazy React component) is
  replaced by `RouteConfig.render(ctx)`, which mounts into a host-provided
  `ctx.root: HTMLElement`. New types: `AddonRouteRenderer`,
  `AddonRouteRenderContext`, `AddonRouteLocation`.
- **React exports removed**: the SDK no longer re-exports `React` / `ReactDOM`
  from host globals. Import from `react` / `react-dom/client`; mark them
  `external` in your build.
- **`SidebarItemConfig`**: `icon` is now a host-supported icon name (`string`)
  instead of a `React.ReactNode`, and the `onClick` handler was removed — use
  `route`.
- **React** guaranteed version bumped 19.1.1 → 19.2.4.

### Added

- `HOST_DEPENDENCIES` export — the versioned packages the sandbox provides
  (react, react-dom, @tanstack/react-query, @wealthfolio/ui, date-fns,
  lucide-react, recharts).
- Brokered networking: `ctx.api.network.request()` with manifest-declared
  `network.allowedHosts` and bearer auth resolved from scoped secret storage
  (`NetworkAPI`, `NetworkRequest`, `NetworkResponse`, `NetworkAuth`).
- Manifest fields: `minWealthfolioVersion`, `hostDependencies`, `network`,
  `sha256`. `AddonHostDependencies` type.
- Addon SDK tax fields on activity/data types (#1188).

## [3.5.1] - 2026-06-09

Also includes the unpublished 3.4.0 and 3.5.0.

### Added

- `PerformanceResult` — a comprehensive performance model replacing
  `PerformanceMetrics`, with supporting types `PerformanceScopeDescriptor`,
  `PerformancePeriod`, `ReturnMethod`, `PerformanceReturns`,
  `PerformanceAttribution`, `PerformanceRisk`, `PerformanceDataQuality`.
- Goal enrichment: `GoalType`, `GoalLifecycle`, `GoalHealth` types; `Goal` gains
  `goalType`, `statusHealth`, `priority`, `coverImageKey`, `currency`, dates,
  valuation summaries, and timestamps. `GoalProgress` gains `goalId`,
  `statusHealth`, `targetDate`.
- Asset resolution: `AssetResolutionInput` (`quoteCcy`, `instrumentType`,
  `providerId`, `providerSymbol`); an `asset` field on `ActivityCreate` /
  `ActivityUpdate`; `assetId` on `ActivityImport`.
- Provider-aware market data: `providerId` / `providerSymbol` plus canonical
  `canonicalSymbol` / `canonicalExchangeMic` on `SymbolSearchResult`;
  `DividendEvent` type and `FetchDividendsOptions`.
- `AccountType` gains `CREDIT_CARD`; `Settings.defaultReturnMetric`
  (`'twr' | 'irr' | 'valueReturn'`).
- Base-currency fields on `AccountValuation` (`totalValueBase`, `costBasisBase`,
  `netContributionBase`, …) and provider/quote fields on `SnapshotHoldingInput`
  / `SnapshotPositionInput`.

### Changed

- Performance API now returns the new `Result` types: `calculateHistory()` (with
  `startDate` / `endDate` now optional) and `calculateSummary()` return
  `PerformanceResult`; `calculateAccountsSimple()`, `AccountSummaryView`, and
  `AccountGroup` use `SimplePerformanceResult`.
- `fetchDividends()` accepts an optional `FetchDividendsOptions` and returns
  `DividendEvent[]` (was `YahooDividend[]`).
- `backupDatabase()` returns `{ filename: string }` (dropped the
  `data: Uint8Array` payload).

### Deprecated

- `PerformanceMetrics` / `SimplePerformanceMetrics` (aliases for their `Result`
  counterparts), `SymbolInput` (use `AssetResolutionInput`), and the `symbol`
  field on `ActivityCreate` / `ActivityUpdate` (use `asset`).

### Removed

- `YahooDividend` (replaced by `DividendEvent`); `dayGainLossAmount` and
  `dayReturnPercentModDietz` from `SimplePerformanceResult`.

## [3.3.0] - 2026-05-01

### Added

- `GoalsAPI.getFunding(goalId)` and `saveFunding(goalId, rules)`, with matching
  `getFunding` / `saveFunding` functions under the renamed `financial-planning`
  permission.
- `GoalAllocation.taxBucket`.

### Changed

- `Goal.isAchieved` replaced by `Goal.statusLifecycle`
  (`'active' | 'achieved' | 'archived'`).
- `GoalAllocation.percentAllocation` renamed to `sharePercent`.
- `goals` permission category renamed to `financial-planning`.

### Deprecated

- `GoalsAPI.updateAllocations()` (use `saveFunding`) and `getAllocations()` (use
  `getAll()` + `getFunding(goalId)`).

## [3.2.0] - 2026-04-02

### Changed

- `ActivitiesAPI.checkImport()` dropped its `accountId` parameter — now
  `checkImport(activities)`, a read-only preview.
- `ActivitiesAPI.getImportMapping()` accepts an optional `contextKind` (default
  `'ACTIVITY'`).
- `ImportMappingData.fieldMappings` widened to
  `Record<string, string | string[]>`.
- `PerformanceMetrics.periodReturn` is now nullable (`number | null`).

## [3.1.1] - 2026-03-14

A large release that overhauls the asset and activity data models (also includes
the unpublished 3.0.1–3.1.0). **Breaking** for addons that read or write assets,
activities, or quotes.

### Breaking

- **Asset model** is now keyed by an opaque UUID instead of a symbol. `Asset` is
  redesigned with `kind` (`AssetKind`), `displayCode`, `quoteMode`, `quoteCcy`,
  `instrumentType`, `instrumentSymbol`, `instrumentKey`, `providerConfig`, …;
  removed `symbol`, `isin`, `assetClass`, `countries`, `sectors`, `dataSource`,
  and more.
- **Activity model** redesigned: `type` → `activityType`, `date` →
  `activityDate`, `assetId` now optional, monetary/quantity fields are decimal
  strings; new lifecycle fields (`subtype`, `status`, `settlementDate`,
  `idempotencyKey`, `importRunId`, `metadata`, …). `ActivityType` is now a
  closed set of 14 (removed `ADD_HOLDING` / `REMOVE_HOLDING`; added `SPLIT`,
  `CREDIT`, `ADJUSTMENT`, `UNKNOWN`).
- **Quotes / assets APIs** now take `assetId` instead of `symbol`:
  `QuotesAPI.update()` / `getHistory()`, `Quote` / `QuoteUpdate`,
  `MarketDataAPI.sync(assetIds)`. `AssetsAPI.updateDataSource()` →
  `updateQuoteMode(assetId, quoteMode)`. `searchTicker()` returns
  `SymbolSearchResult` (renamed from `QuoteSummary`).
- `ActivitiesAPI.import()` returns `ImportActivitiesResult` (was
  `ActivityImport[]`); `SettingsAPI.update()` takes `Partial<Settings>`;
  `IncomeSummary.bySymbol` → `byAsset`.

### Added

- New APIs: `SnapshotsAPI` (holdings snapshots) and `ToastAPI` (`success` /
  `error` / `warning` / `info`), each with a matching permission category;
  `MarketDataAPI.fetchDividends(symbol)`.
- Activity taxonomy: `ActivityStatus`, `ACTIVITY_SUBTYPES` / `ActivitySubtype`,
  `AssetKind`, `QuoteMode` constants; helpers `getEffectiveType()` and
  `hasUserOverride()`.
- `calculateGoalProgress()` helper (new `goal-progress` module).
- Import/sync types (`ImportRun*`, `BrokerSyncState`, `SyncStatus`), snapshot
  types (`Snapshot*`), classification types (`AssetClassifications`,
  `TaxonomyCategory`, `CategoryWithWeight`), and `QueryKeys.SNAPSHOTS`.
- React peer dependency bumped to `^19.2.4`.

### Removed

- `AssetProfile`, `MarketData`, `Sector`, `Country`, `SettingsContextType`;
  `ActivityType` values `ADD_HOLDING` / `REMOVE_HOLDING`.

## [3.0.0] - 2026-02-24

### Breaking

- React peer dependency updated to 19 (`ReactVersion` `18.3.1` → `19.1.1`).
- `ActivitiesAPI.search()` now takes typed `ActivitySearchFilters` and
  `ActivitySort` (was `unknown`).
- `ActivitiesAPI.saveMany()` takes `ActivityBulkMutationRequest` and returns
  `ActivityBulkMutationResult` (was `ActivityUpdate[]` → `Activity[]`).

### Added

- Bulk-mutation types: `ActivityBulkMutationRequest`,
  `ActivityBulkMutationResult`, `ActivityBulkMutationError`,
  `ActivityBulkIdentifierMapping`; exported `ActivitySearchFilters` and
  `ActivitySort`.
- `Activity.assetDataSource`, `ActivityCreate.id` / `assetDataSource`,
  `UpdateAssetProfile.symbolMapping`.

### Changed

- Build now emits `.js` / `.d.ts` (was `.mjs` / `.d.mts`); the types entry moved
  to `dist/src/index.d.ts`.

## [2.0.0] - 2025-11-22

### Breaking

- Package now ships as an ES module (`"type": "module"`).

### Changed

- Tightened types: loose `any` parameters/returns replaced with `unknown` across
  `AccountsAPI.create()`, `ActivitiesAPI.search()`, `GoalsAPI.create()`,
  `FilesAPI.openSaveDialog()`, `QueryAPI.getClient()`, `isAddonManifest()`, and
  `RouteConfig.component`.
- `DateRange` and `TrackedItem` changed from type aliases to interfaces.

## [1.0.0] - 2024-12-19

### Added

- **Initial Release** - Complete TypeScript SDK for building Wealthfolio addons
- **Core Types**: AddonContext, SidebarManager, RouterManager, and event
  handling
- **Data Types**: Comprehensive financial data models (Account, Activity, Asset,
  Holding, etc.)
- **Permission System**: Risk-based permission categorization with validation
  and security controls
- **Manifest Management**: Validation, compatibility checks, and metadata
  handling
- **Host API Interface**: Secure communication layer between addons and
  Wealthfolio
- **Utility Functions**: Addon validation, version compatibility, ID generation,
  and size formatting
- **Development Tools**: Complete TypeScript definitions and development
  utilities

### Features

- Enhanced type safety with complete data type definitions
- Permission system with risk-based categorization (low, medium, high)
- Addon lifecycle management (install, validate, update, enable/disable)
- Development and runtime manifest types
- Comprehensive export definitions for all addon functionality
- Support for addon store listings and metadata

### Technical

- ESM module format with TypeScript declarations
- React peer dependency support (^18.0.0)
- Node.js 20+ compatibility
- MIT licensed for maximum compatibility
- Complete build pipeline with tsup
- Comprehensive type exports and module structure
