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
  AddonRouteLocation,
  AddonRouteRenderContext,
  AddonRouteRenderer,
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
  NetworkAuth,
  NetworkAPI,
  NetworkRequest,
  NetworkResponse,
  SnapshotsAPI,
  StorageAPI,
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
  AddonContributedLink,
  AddonContributedRoute,
  AddonContributes,
  AddonHostDependencies,
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
  BASELINE_PERMISSION_CATEGORIES,
  getFunctionRiskLevel,
  getPermissionCategoriesByRisk,
  getPermissionCategory,
  isBaselineCategory,
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

/**
 * React version provided by the Wealthfolio add-on sandbox for host-externalized
 * add-ons.
 */
export const ReactVersion = '19.2.4';

export { HOST_DEPENDENCIES } from './host-dependencies';

// Sidebar icon names (see SidebarItemConfig.icon)
export { ADDON_ICON_NAMES } from './icons';
export type { AddonIconName } from './icons';

/**
 * Addons receive their context as a parameter to the enable() function.
 * Each addon gets its own isolated iframe context with scoped host APIs.
 *
 * Example:
 * export default function enable(ctx: AddonContext) {
 *   // Use ctx.api.secrets.set/get/delete for secure storage
 *   // Use ctx.sidebar.addItem() to add navigation
 *   // Use ctx.router.add() with a render callback to register routes
 * }
 */

// Version
export { SDK_VERSION } from './version';
