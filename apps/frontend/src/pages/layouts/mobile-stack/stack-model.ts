/**
 * Back-stack rules for the phone layout.
 *
 * Browser history stays the source of truth: every move in the app is still a
 * history entry, so the back button, Android's system Back and the browser all
 * agree. This model only decides which screen each entry shows, so the screens
 * under the top one can stay mounted and come back as the user left them.
 *
 * A tab owns a stack of screens. Opening something from a screen pushes onto
 * that screen's tab; a top-level destination (a tab-bar or menu entry) leaves
 * the tab, which keeps its stack for when the user returns.
 */

export type NavigationAction = "PUSH" | "POP" | "REPLACE";

export interface StackLocation {
  pathname: string;
  search: string;
  hash: string;
  state: unknown;
  key: string;
}

export interface StackScreen {
  id: string;
  tab: string;
  location: StackLocation;
}

export interface StackTab {
  id: string;
  /**
   * Path of the tab's first screen. Paths under it nest: each path between the
   * root and a page is a page of its own (`/settings/spending` for
   * `/settings/spending/rules`), which a deep link opens under the page.
   */
  rootPath: string;
}

export interface StackConfig {
  tabs: readonly StackTab[];
  /** Destinations that leave the current tab instead of stacking on it. */
  topLevelPaths: readonly string[];
}

interface HistoryEntry {
  /** Tab the entry belongs to; null for a page shown outside the stacks. */
  tab: string | null;
  screenId: string | null;
  /** Position in history, relative to the first entry this session saw. */
  index: number;
}

export interface StackState {
  stacks: Record<string, StackScreen[]>;
  /** Tab on screen; null while a page outside the stacks is shown. */
  activeTab: string | null;
  entries: Record<string, HistoryEntry>;
  index: number;
  currentKey: string;
  nextId: number;
}

/**
 * What the app meant by the navigation it is about to make, when the location
 * alone cannot tell: switching to a tab shows that tab's top screen, and a back
 * step that has no history entry to return to replaces the current one.
 */
export type StackIntent = { type: "openTab"; tab: string } | { type: "popTo"; screenId: string };

export interface NavigationEvent {
  action: NavigationAction;
  location: StackLocation;
  intent?: StackIntent | null;
  /**
   * Position of the entry in the browser's history, when known. Without it
   * the model counts pushes, which misses navigations that land in the same
   * render and starts over after a reload.
   */
  index?: number | null;
}

export interface BackTarget {
  screen: StackScreen;
  /**
   * Going back in history reaches the screen: the previous entry shows it, or
   * the previous entry is one this session never saw (from before a reload),
   * in which case history decides and the stack follows it.
   */
  viaHistory: boolean;
}

export type StackTransition =
  | { kind: "push"; from: StackScreen; to: StackScreen }
  | { kind: "pop"; from: StackScreen; to: StackScreen; exiting: StackScreen[] }
  | null;

function normalizePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

function tabWithRoot(config: StackConfig, pathname: string): StackTab | undefined {
  const path = normalizePath(pathname);
  return config.tabs.find((tab) => tab.rootPath === path);
}

function tabOwning(config: StackConfig, pathname: string): StackTab | undefined {
  const path = normalizePath(pathname);
  return config.tabs.find((tab) => path === tab.rootPath || path.startsWith(`${tab.rootPath}/`));
}

function isTopLevel(config: StackConfig, pathname: string): boolean {
  return config.topLevelPaths.includes(normalizePath(pathname));
}

function makeScreen(state: StackState, tab: string, location: StackLocation) {
  const screen: StackScreen = { id: `${tab}:${state.nextId}`, tab, location };
  return { screen, nextId: state.nextId + 1 };
}

function findScreen(state: StackState, screenId: string) {
  for (const [tab, screens] of Object.entries(state.stacks)) {
    const position = screens.findIndex((screen) => screen.id === screenId);
    if (position !== -1) return { tab, position };
  }
  return null;
}

/** Stack of `tab` cut down to the screen at `position`, which shows `location`. */
function truncateTo(
  stacks: StackState["stacks"],
  tab: string,
  position: number,
  location: StackLocation,
) {
  const screens = stacks[tab].slice(0, position + 1);
  screens[position] = { ...screens[position], location };
  return { ...stacks, [tab]: screens };
}

/**
 * Pages a link straight to a deeper screen opens under it, so back walks up one
 * level at a time: each path between the tab's root and the link, root first.
 * `/settings/spending/rules` opens `/settings` and `/settings/spending`.
 */
function parentLocations(tab: StackTab, location: StackLocation): StackLocation[] {
  const path = normalizePath(location.pathname);
  if (path === tab.rootPath) return [];
  const segments = path.slice(tab.rootPath.length + 1).split("/");
  return segments.slice(0, -1).reduce<StackLocation[]>(
    (parents, _, position) => [
      ...parents,
      {
        pathname: [tab.rootPath, ...segments.slice(0, position + 1)].join("/"),
        search: "",
        hash: "",
        state: null,
        key: `${location.key}:parent-${position + 1}`,
      },
    ],
    [
      {
        pathname: tab.rootPath,
        search: "",
        hash: "",
        state: null,
        key: `${location.key}:parent-0`,
      },
    ],
  );
}

function sameUrl(a: StackLocation, b: StackLocation): boolean {
  return (
    normalizePath(a.pathname) === normalizePath(b.pathname) &&
    a.search === b.search &&
    a.hash === b.hash
  );
}

/** Records the entry at `key`; any other entry at its position is gone from history. */
function withEntry(entries: StackState["entries"], key: string, entry: HistoryEntry) {
  const kept = Object.entries(entries).filter(([, other]) => other.index !== entry.index);
  return { ...Object.fromEntries(kept), [key]: entry };
}

/** Removes a screen from its tab, except the tab's first screen, which always stays. */
function removeScreen(state: StackState, screenId: string): StackState {
  const found = findScreen(state, screenId);
  if (!found || found.position === 0) return state;
  const screens = state.stacks[found.tab].filter((screen) => screen.id !== screenId);
  return { ...state, stacks: { ...state.stacks, [found.tab]: screens } };
}

/**
 * Going back closes the screen being left, as on a phone, unless history goes
 * back to that screen or to one under it in the same tab.
 */
function closeTopWhenLeft(state: StackState, destinationScreenId: string | null): StackState {
  const top = topScreen(state);
  if (!top || top.id === destinationScreenId) return state;
  const screens = state.stacks[top.tab] ?? [];
  if (screens.some((screen) => screen.id === destinationScreenId)) return state;
  return removeScreen(state, top.id);
}

/** Builds the stack for a location reached without history this session knows. */
export function coldStart(
  config: StackConfig,
  location: StackLocation,
  previous?: StackState,
  index = 0,
): StackState {
  const base: StackState = {
    stacks: previous?.stacks ?? {},
    activeTab: null,
    entries: previous?.entries ?? {},
    index,
    currentKey: location.key,
    nextId: previous?.nextId ?? 0,
  };
  const tab = tabOwning(config, location.pathname);
  if (!tab) {
    return {
      ...base,
      entries: withEntry(base.entries, location.key, { tab: null, screenId: null, index }),
    };
  }

  let state = base;
  const screens: StackScreen[] = [];
  for (const parent of parentLocations(tab, location)) {
    const made = makeScreen(state, tab.id, parent);
    screens.push(made.screen);
    state = { ...state, nextId: made.nextId };
  }
  const top = makeScreen(state, tab.id, location);
  screens.push(top.screen);
  return {
    ...state,
    nextId: top.nextId,
    stacks: { ...state.stacks, [tab.id]: screens },
    activeTab: tab.id,
    entries: withEntry(state.entries, location.key, {
      tab: tab.id,
      screenId: top.screen.id,
      index,
    }),
  };
}

function goToKnownEntry(
  state: StackState,
  location: StackLocation,
  entry: HistoryEntry,
  index: number,
) {
  const moved = { ...state, index, currentKey: location.key };
  if (entry.tab === null || entry.screenId === null) {
    return { ...moved, activeTab: null };
  }

  const found = findScreen(state, entry.screenId);
  if (found) {
    return {
      ...moved,
      activeTab: found.tab,
      stacks: truncateTo(state.stacks, found.tab, found.position, location),
    };
  }

  // Forward to a screen that was popped: open it again on top of its tab.
  const { screen, nextId } = makeScreen(state, entry.tab, location);
  return {
    ...moved,
    nextId,
    activeTab: entry.tab,
    stacks: { ...state.stacks, [entry.tab]: [...(state.stacks[entry.tab] ?? []), screen] },
    entries: withEntry(state.entries, location.key, { ...entry, screenId: screen.id, index }),
  };
}

/** Where a new history entry lands: which tab, and which screen. */
function placeNewEntry(state: StackState, event: NavigationEvent, config: StackConfig) {
  const { action, location, intent } = event;

  if (intent?.type === "popTo") {
    const found = findScreen(state, intent.screenId);
    if (found) {
      return {
        ...state,
        activeTab: found.tab,
        stacks: truncateTo(state.stacks, found.tab, found.position, location),
        placed: { tab: found.tab, screenId: intent.screenId },
      };
    }
  }

  const openedTab =
    intent?.type === "openTab"
      ? config.tabs.find((tab) => tab.id === intent.tab)
      : tabWithRoot(config, location.pathname);
  if (openedTab) {
    const screens = state.stacks[openedTab.id] ?? [];
    // A tab switch shows the tab as it was left; going to the tab's root path
    // (or tapping the tab it is already on) returns it to its first screen.
    const keep = intent?.type === "openTab" ? screens.length - 1 : 0;
    if (screens.length > 0) {
      return {
        ...state,
        activeTab: openedTab.id,
        stacks: truncateTo(state.stacks, openedTab.id, keep, location),
        placed: { tab: openedTab.id, screenId: screens[keep].id },
      };
    }
    const { screen, nextId } = makeScreen(state, openedTab.id, location);
    return {
      ...state,
      nextId,
      activeTab: openedTab.id,
      stacks: { ...state.stacks, [openedTab.id]: [screen] },
      placed: { tab: openedTab.id, screenId: screen.id },
    };
  }

  if (state.activeTab === null || isTopLevel(config, location.pathname)) {
    return { ...state, activeTab: null, placed: { tab: null, screenId: null } };
  }

  const tab = state.activeTab;
  const screens = state.stacks[tab];
  if (action === "REPLACE") {
    // A redirect up to the page underneath (a `<Navigate replace>` to the
    // parent) returns to that page rather than showing it twice.
    const top = screens.length - 1;
    const below = screens[top - 1];
    const keep = below && sameUrl(below.location, location) ? top - 1 : top;
    return {
      ...state,
      stacks: truncateTo(state.stacks, tab, keep, location),
      placed: { tab, screenId: screens[keep].id },
    };
  }
  const { screen, nextId } = makeScreen(state, tab, location);
  return {
    ...state,
    nextId,
    stacks: { ...state.stacks, [tab]: [...screens, screen] },
    placed: { tab, screenId: screen.id },
  };
}

/** History moved to an existing entry: back, forward, or a jump. */
function applyPop(state: StackState, event: NavigationEvent, config: StackConfig): StackState {
  const { location } = event;
  const known = state.entries[location.key];
  const index = event.index ?? known?.index ?? null;

  if (index === null) {
    // Nowhere to place the entry: start over from it.
    return coldStart(config, location, { ...state, entries: {} });
  }
  const goingBack = index < state.index;

  if (known) {
    const base = goingBack ? closeTopWhenLeft(state, known.screenId) : state;
    return goToKnownEntry(base, location, known, index);
  }

  // An entry this session never saw: from before a reload, or a navigation
  // that landed in the same render as a later one. Going back to the URL of
  // the screen underneath means that screen.
  const screens = state.activeTab ? (state.stacks[state.activeTab] ?? []) : [];
  const below = screens[screens.length - 2];
  if (goingBack && state.activeTab && below && sameUrl(below.location, location)) {
    return {
      ...state,
      index,
      currentKey: location.key,
      stacks: truncateTo(state.stacks, state.activeTab, screens.length - 2, location),
      entries: withEntry(state.entries, location.key, {
        tab: state.activeTab,
        screenId: below.id,
        index,
      }),
    };
  }

  const base = goingBack ? closeTopWhenLeft(state, null) : state;
  if (Object.keys(base.stacks).length === 0) {
    return coldStart(config, location, base, index);
  }
  // Otherwise place it as if it were opened from the screen on top.
  const { placed, ...next } = placeNewEntry(base, { action: "PUSH", location }, config);
  return {
    ...next,
    index,
    currentKey: location.key,
    entries: withEntry(base.entries, location.key, { ...placed, index }),
  };
}

/** Applies one router navigation to the stacks. */
export function applyNavigation(
  state: StackState,
  event: NavigationEvent,
  config: StackConfig,
): StackState {
  const { action, location } = event;
  if (action === "POP") return applyPop(state, event, config);

  const index = event.index ?? (action === "PUSH" ? state.index + 1 : state.index);
  // A push drops the entries from its position on, as the browser does; a
  // replace drops the entry it overwrites.
  const entries = Object.fromEntries(
    Object.entries(state.entries).filter(([key, entry]) =>
      action === "PUSH" ? entry.index < index : key !== state.currentKey && entry.index !== index,
    ),
  );

  const replaced = action === "REPLACE" ? topScreen(state) : null;
  const { placed, ...next } = placeNewEntry(state, event, config);
  const result: StackState = {
    ...next,
    index,
    currentKey: location.key,
    entries: { ...entries, [location.key]: { ...placed, index } },
  };
  // A redirect away from the screen on top (a `<Navigate replace>` to another
  // tab's page) overwrote that screen's only entry, so the screen is gone.
  return replaced && placed.screenId !== replaced.id ? removeScreen(result, replaced.id) : result;
}

export function topScreen(state: StackState): StackScreen | null {
  if (state.activeTab === null) return null;
  const screens = state.stacks[state.activeTab] ?? [];
  return screens[screens.length - 1] ?? null;
}

/** The screen a back step returns to, or null when the tab is at its root. */
export function getBackTarget(state: StackState): BackTarget | null {
  if (state.activeTab === null) return null;
  const screens = state.stacks[state.activeTab] ?? [];
  if (screens.length < 2) return null;

  const screen = screens[screens.length - 2];
  const previousEntry = Object.values(state.entries).find(
    (entry) => entry.index === state.index - 1,
  );
  const viaHistory = previousEntry ? previousEntry.screenId === screen.id : state.index > 0;
  return { screen, viaHistory };
}

/** How the screen on top changed between two states. */
export function describeTransition(previous: StackState, next: StackState): StackTransition {
  if (previous.activeTab === null || previous.activeTab !== next.activeTab) return null;

  const before = previous.stacks[previous.activeTab] ?? [];
  const after = next.stacks[next.activeTab] ?? [];
  const from = before[before.length - 1];
  const to = after[after.length - 1];
  if (!from || !to || from.id === to.id) return null;

  const toPosition = before.findIndex((screen) => screen.id === to.id);
  if (toPosition !== -1) {
    return { kind: "pop", from, to, exiting: before.slice(toPosition + 1) };
  }
  if (after.some((screen) => screen.id === from.id)) {
    return { kind: "push", from, to };
  }
  return null;
}
