/**
 * @wealthfolio/addon-sdk
 *
 * TypeScript SDK for building Wealthfolio addons with enhanced functionality,
 * type safety, and comprehensive permission management.
 *
 * @version 1.0.0
 * @author Wealthfolio Team
 * @license MIT
 */

// Core types
export type {
  AddonContext,
  AddonEnableFunction,
  EventCallback,
  RouteConfig,
  RouterManager,
  SidebarItemConfig,
  SidebarItemHandle,
  SidebarManager,
  UnlistenFn,
} from './types';

// Host API interface
export type {
  ActivitySearchFilters,
  ActivitySort,
  HostAPI,
  SnapshotsAPI,
  ToastAPI,
  DividendEvent,
  FetchDividendsOptions,
} from './host-api';

// Query Client and Keys exports
export type { QueryClient } from '@tanstack/react-query';
export { QueryKeys } from './query-keys';

// Comprehensive data types
export type * from './data-types';

// Manifest and metadata types
export type {
  AddonFile,
  AddonInstallResult,
  AddonManifest,
  AddonStoreListing,
  AddonUpdateCheckResult,
  AddonUpdateInfo,
  AddonValidationResult,
  DevelopmentManifest,
  ExtractedAddon,
  InstalledAddon,
  InstalledManifest,
} from './manifest';

export { isInstalledManifest } from './manifest';

// Permission system
export type {
  FunctionPermission,
  Permission,
  PermissionCategory,
  RiskLevel,
} from './permissions';

export {
  getFunctionRiskLevel,
  getPermissionCategoriesByRisk,
  getPermissionCategory,
  isPermissionRequired,
  PERMISSION_CATEGORIES,
} from './permissions';

// Utilities
export {
  formatAddonSize,
  generateAddonId,
  isAddonManifest,
  isCompatibleVersion,
  validateManifest,
} from './utils';

// Goal progress calculation
export { calculateGoalProgress } from './goal-progress';

// -----------------------------------------------------------------------------
// Framework version contract
// -----------------------------------------------------------------------------

/**
 * React version guaranteed by the host application. Addons may assert against
 * this at runtime if they rely on a particular React feature set.
 */
export const ReactVersion = '19.1.1';

/**
 * Addons receive their context as a parameter to the enable() function.
 * Each addon gets its own isolated context with scoped secret storage.
 *
 * Example:
 * export default function enable(ctx: AddonContext) {
 *   // Use ctx.api.secrets.set/get/delete for secure storage
 *   // Use ctx.sidebar.addItem() to add navigation
 *   // Use ctx.router.add() to register routes
 * }
 */

interface HostGlobals {
  React: typeof import('react');
  ReactDOM: typeof import('react-dom');
}
const hostGlobals = window as unknown as Partial<HostGlobals>;
export const React = hostGlobals.React!;
export const ReactDOM = hostGlobals.ReactDOM!;

// Version
export { SDK_VERSION } from './version';
