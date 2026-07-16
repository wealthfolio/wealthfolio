import type { ComponentType } from 'react';
import type { HostAPI } from './host-api';
import type { AddonIconName } from './icons';

/**
 * Core types for addon development
 */

/**
 * Handle returned from sidebar item creation
 */
export interface SidebarItemHandle {
  /** Remove the sidebar item */
  remove(): void;
}

/**
 * Configuration for adding a sidebar item
 */
export interface SidebarItemConfig {
  /** Unique identifier for the sidebar item */
  id: string;
  /** Display text for the sidebar item */
  label: string;
  /** Optional host-supported icon name (see {@link AddonIconName}) */
  icon?: AddonIconName;
  /** Optional route to navigate to when clicked */
  route?: string;
  /** Optional ordering priority (lower numbers appear first) */
  order?: number;
}

/**
 * Route location supplied by the host when an addon route is rendered.
 */
export interface AddonRouteLocation {
  pathname: string;
  search: string;
  hash: string;
  params: Record<string, string | undefined>;
}

/**
 * Context supplied to addon route render functions.
 */
export interface AddonRouteRenderContext {
  root: HTMLElement;
  location: AddonRouteLocation;
}

/**
 * Render callback for iframe-hosted addon routes.
 */
export type AddonRouteRenderer = (
  context: AddonRouteRenderContext,
) => void | Promise<void>;

/** Props the host passes to a route `component`. */
export interface AddonRouteComponentProps {
  location: AddonRouteLocation;
}

/**
 * A React component the host mounts for a route. The host owns a single React
 * root per addon and swaps the mounted component on navigation, so addons must
 * NOT call `createRoot` themselves — doing so leaves orphaned trees whose
 * re-renders never reach the DOM (the 3.6 "buttons do nothing" bug). The sandbox
 * has no react-router provider, so the component receives the current
 * `location` as a prop (re-passed on each navigation) — do not call
 * `useLocation()`/`useParams()`.
 */
export type AddonRouteComponent = ComponentType<AddonRouteComponentProps>;

/**
 * Configuration for adding a route.
 *
 * Provide exactly one of `component` (recommended — the host manages the React
 * root) or `render` (an imperative callback given the container element). If
 * both are provided, `component` wins; if neither, the host rejects the route.
 */
export interface RouteConfig {
  /** Optional stable route identifier */
  id?: string;
  /** Route path pattern */
  path: string;
  /** Optional label for diagnostics */
  title?: string;
  /**
   * React component rendered by the host into its managed single root.
   * Preferred over `render`.
   */
  component?: AddonRouteComponent;
  /**
   * Imperative render callback into the addon's sandboxed iframe container.
   * Legacy/escape hatch — prefer `component`. Optional when `component` is set.
   */
  render?: AddonRouteRenderer;
}

/**
 * Sidebar management interface
 */
export interface SidebarManager {
  /**
   * Add an item to the application sidebar
   * @param config Configuration for the sidebar item
   * @returns Handle to remove the item
   */
  addItem(config: SidebarItemConfig): SidebarItemHandle;
}

/**
 * Router management interface
 */
export interface RouterManager {
  /**
   * Register a new route in the application
   * @param route Route configuration
   */
  add(route: RouteConfig): void;
}

/**
 * Event callback type for Tauri events
 */
export type EventCallback<T> = (event: { payload: T }) => void;

/**
 * Unlisten function type for event listeners
 */
export type UnlistenFn = () => void;

/**
 * Main addon context interface providing access to Wealthfolio APIs
 */
export interface AddonContext {
  /** UI primitives owned by the addon's sandboxed iframe */
  ui: {
    /** Root element for addon-rendered content */
    root: HTMLElement;
  };
  /** Sidebar management */
  sidebar: SidebarManager;
  /** Router management */
  router: RouterManager;
  /** Register a callback for addon cleanup */
  onDisable(callback: () => void): void;
  /** Access to host application APIs */
  api: HostAPI;
}

/**
 * Addon enable function signature
 */
export type AddonEnableFunction = (
  context: AddonContext,
) => void | { disable?: () => void };
