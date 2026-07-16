/**
 * Type utilities for bridging between main app and addon SDK types
 * These utilities help convert between the main app's internal types and the SDK's public types
 */

import type { EventCallback, UnlistenFn } from "@/adapters";
import type {
  Account,
  AccountValuation,
  Activity,
  ActivityBulkMutationRequest,
  ActivityBulkMutationResult,
  ActivityCreate,
  ActivityDetails,
  ActivityImport,
  ActivitySearchResponse,
  ActivityUpdate,
  Asset,
  CheckHoldingsImportResult,
  ContributionLimit,
  DepositsCalculation,
  ExchangeRate,
  Goal,
  GoalFundingRule,
  GoalFundingRuleInput,
  Holding,
  HoldingsSnapshotInput,
  ImportActivitiesResult,
  ImportHoldingsCsvResult,
  ImportMappingData,
  IncomeSummary,
  MarketDataProviderInfo,
  NewContributionLimit,
  PerformanceResult,
  Quote,
  SnapshotInfo,
  SymbolSearchResult,
  Settings,
  SimplePerformanceResult,
  UpdateAssetProfile,
} from "@/lib/types";
import type { HoldingInput } from "@/adapters";
import type {
  Goal as SDKGoal,
  GoalAllocation as SDKGoalAllocation,
  HostAPI as SDKHostAPI,
  NetworkRequest as SDKNetworkRequest,
  NetworkResponse as SDKNetworkResponse,
  Permission,
} from "@wealthfolio/addon-sdk";
import { isBaselineCategory } from "@wealthfolio/addon-sdk";

/**
 * Internal HostAPI interface that matches the actual command function signatures
 * This allows us to maintain type safety internally while providing a clean SDK interface
 */
export interface InternalHostAPI {
  // Core data access
  getHoldings(accountId: string): Promise<Holding[]>;
  getActivities(accountId?: string): Promise<ActivityDetails[]>;
  getAccounts(): Promise<Account[]>;

  // Exchange rates
  getExchangeRates(): Promise<ExchangeRate[]>;
  updateExchangeRate(updatedRate: ExchangeRate): Promise<ExchangeRate>;
  addExchangeRate(newRate: Omit<ExchangeRate, "id">): Promise<ExchangeRate>;

  // Contribution limits
  getContributionLimit(): Promise<ContributionLimit[]>;
  createContributionLimit(newLimit: NewContributionLimit): Promise<ContributionLimit>;
  updateContributionLimit(
    id: string,
    updatedLimit: NewContributionLimit,
  ): Promise<ContributionLimit>;
  calculateDepositsForLimit(limitId: string): Promise<DepositsCalculation>;

  // Goals
  getGoals(): Promise<Goal[]>;
  createGoal(goal: unknown): Promise<Goal>;
  updateGoal(goal: unknown): Promise<Goal>;
  getGoalFunding(goalId: string): Promise<GoalFundingRule[]>;
  saveGoalFunding(goalId: string, rules: GoalFundingRuleInput[]): Promise<GoalFundingRule[]>;

  // Market data
  searchTicker(query: string): Promise<SymbolSearchResult[]>;
  fetchDividends(
    symbol: string,
    options?: {
      exchangeMic?: string;
      instrumentType?: string;
      quoteCcy?: string;
      providerId?: string;
      startDate?: string;
      endDate?: string;
    },
  ): Promise<{ amount: number; date: number }[]>;
  syncHistoryQuotes(): Promise<void>;
  getAssetProfile(assetId: string): Promise<Asset>;
  updateAssetProfile(payload: UpdateAssetProfile): Promise<Asset>;
  updateQuoteMode(assetId: string, quoteMode: string): Promise<Asset>;
  updateQuote(symbol: string, quote: Quote): Promise<void>;
  syncMarketData(
    assetIds: string[],
    refetchAll: boolean,
    refetchRecentDays?: number,
  ): Promise<void>;
  getQuoteHistory(symbol: string): Promise<Quote[]>;
  getMarketDataProviders(): Promise<MarketDataProviderInfo[]>;

  // Portfolio
  updatePortfolio(): Promise<void>;
  recalculatePortfolio(): Promise<void>;
  getIncomeSummary(accountId?: string): Promise<IncomeSummary[]>;
  getHistoricalValuations(
    accountId?: string,
    startDate?: string,
    endDate?: string,
  ): Promise<AccountValuation[]>;
  getLatestValuations(accountIds: string[]): Promise<AccountValuation[]>;
  calculatePerformanceHistory(
    itemType: "account" | "symbol",
    itemId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<PerformanceResult>;
  calculatePerformanceSummary(args: {
    itemType: "account" | "symbol";
    itemId: string;
    startDate?: string | null;
    endDate?: string | null;
  }): Promise<PerformanceResult>;
  calculateAccountsSimplePerformance(accountIds: string[]): Promise<SimplePerformanceResult[]>;
  getHolding(accountId: string, assetId: string): Promise<Holding | null>;

  // Settings
  getSettings(): Promise<Settings>;
  updateSettings(settingsUpdate: Partial<Settings>): Promise<Settings>;
  backupDatabase(): Promise<{ filename: string }>;

  // Account management
  createAccount(account: unknown): Promise<Account>;
  updateAccount(account: unknown): Promise<Account>;

  // Activity management
  searchActivities(
    page: number,
    pageSize: number,
    filters: { accountIds?: string | string[]; activityTypes?: string | string[]; symbol?: string },
    searchKeyword: string,
    sort?: { id: string; desc?: boolean },
  ): Promise<ActivitySearchResponse>;
  createActivity(activity: ActivityCreate): Promise<Activity>;
  updateActivity(activity: ActivityUpdate): Promise<Activity>;
  saveActivities(request: ActivityBulkMutationRequest): Promise<ActivityBulkMutationResult>;

  // File operations
  openCsvFileDialog(): Promise<null | string | string[]>;
  openFileSaveDialog(fileContent: Uint8Array | Blob | string, fileName: string): Promise<unknown>;

  // Event listeners - Import
  listenImportFileDropHover<T>(handler: EventCallback<T>): Promise<UnlistenFn>;
  listenImportFileDrop<T>(handler: EventCallback<T>): Promise<UnlistenFn>;
  listenImportFileDropCancelled<T>(handler: EventCallback<T>): Promise<UnlistenFn>;

  // Event listeners - Portfolio
  listenPortfolioUpdateStart<T>(handler: EventCallback<T>): Promise<UnlistenFn>;
  listenPortfolioUpdateComplete<T>(handler: EventCallback<T>): Promise<UnlistenFn>;
  listenPortfolioUpdateError<T>(handler: EventCallback<T>): Promise<UnlistenFn>;
  listenMarketSyncStart<T>(handler: EventCallback<T>): Promise<UnlistenFn>;
  listenMarketSyncComplete<T>(handler: EventCallback<T>): Promise<UnlistenFn>;

  // Activity import
  importActivities(params: { activities: ActivityImport[] }): Promise<ImportActivitiesResult>;
  checkActivitiesImport(params: { activities: ActivityImport[] }): Promise<ActivityImport[]>;
  getAccountImportMapping(accountId: string, contextKind?: string): Promise<ImportMappingData>;
  saveAccountImportMapping(mapping: ImportMappingData): Promise<ImportMappingData>;

  // Snapshots
  getSnapshots(accountId: string, dateFrom?: string, dateTo?: string): Promise<SnapshotInfo[]>;
  getSnapshotByDate(accountId: string, date: string): Promise<Holding[]>;
  saveManualHoldings(
    accountId: string,
    holdings: HoldingInput[],
    cashBalances: Record<string, string>,
    snapshotDate?: string,
  ): Promise<void>;
  checkHoldingsImport(
    accountId: string,
    snapshots: HoldingsSnapshotInput[],
  ): Promise<CheckHoldingsImportResult>;
  importHoldingsCsv(
    accountId: string,
    snapshots: HoldingsSnapshotInput[],
  ): Promise<ImportHoldingsCsvResult>;
  deleteSnapshot(accountId: string, date: string): Promise<void>;

  // Logger functions (internal - these are the raw logger functions)
  logError(message: string): void;
  logInfo(message: string): void;
  logWarn(message: string): void;
  logTrace(message: string): void;
  logDebug(message: string): void;

  // Navigation functions
  navigateToRoute(route: string): Promise<void>;

  // Query functions
  getQueryClient(): unknown;
  invalidateQueries(queryKey: string | string[]): void;
  refetchQueries(queryKey: string | string[]): void;

  // Network functions
  addonNetworkRequest(request: SDKNetworkRequest): Promise<SDKNetworkResponse>;

  // Toast functions
  toastSuccess(message: string): void;
  toastError(message: string): void;
  toastWarning(message: string): void;
  toastInfo(message: string): void;
}

// `secrets` and `storage` are attached separately in createAddonHostAPI (both
// are addon-scoped and wired directly to adapters, not through this bridge).
type SDKApiWithoutSecrets = Omit<SDKHostAPI, "secrets" | "storage">;
type PermissionFunctionInput = Permission["functions"][number] | string;

export interface PermissionGuard {
  canUse(category: string, functionName: string): boolean;
  assertCanUse(category: string, functionName: string): void;
}

export function createPermissionGuard(
  addonId: string,
  permissions: Permission[] | undefined,
): PermissionGuard {
  const allowed = new Set<string>();

  for (const permission of permissions ?? []) {
    for (const fn of (permission.functions ?? []) as PermissionFunctionInput[]) {
      if (typeof fn === "string") {
        allowed.add(`${permission.category}:${fn}`);
      } else if (typeof fn.name === "string" && fn.isDeclared !== false) {
        allowed.add(`${permission.category}:${fn.name}`);
      }
    }
  }

  const isAllowed = (category: string, functionName: string) =>
    isBaselineCategory(category) || allowed.has(`${category}:${functionName}`);

  return {
    canUse: isAllowed,
    assertCanUse: (category: string, functionName: string) => {
      if (!isAllowed(category, functionName)) {
        const error = new Error(
          `Addon '${addonId}' is not allowed to call ${category}.${functionName}`,
        );
        // Lets callers surface permission denials distinctly from other errors.
        error.name = "AddonPermissionDenied";
        throw error;
      }
    },
  };
}

function guardNamespace<T extends Record<string, unknown>>(
  namespace: T,
  category: string,
  guard?: PermissionGuard,
): T {
  if (!guard) {
    return namespace;
  }

  return Object.fromEntries(
    Object.entries(namespace).map(([functionName, value]) => [
      functionName,
      typeof value === "function"
        ? (...args: unknown[]) => {
            guard.assertCanUse(category, functionName);
            return (value as (...innerArgs: unknown[]) => unknown)(...args);
          }
        : value,
    ]),
  ) as T;
}

function guardEventsNamespace<T extends SDKApiWithoutSecrets["events"]>(
  namespace: T,
  guard?: PermissionGuard,
): T {
  if (!guard) {
    return namespace;
  }

  return Object.fromEntries(
    Object.entries(namespace).map(([eventGroup, handlers]) => [
      eventGroup,
      guardNamespace(handlers as Record<string, unknown>, "events", guard),
    ]),
  ) as unknown as T;
}

/**
 * Type bridge utility to convert between internal and SDK types
 * This handles the mapping between the actual implementation types and the public SDK types
 */
export function createSDKHostAPIBridge(
  internalAPI: InternalHostAPI,
  addonId?: string,
  guard?: PermissionGuard,
): SDKApiWithoutSecrets {
  // Create logger with addon prefix
  const createAddonLogger = (prefix: string) => ({
    error: (message: string) => internalAPI.logError(`[${prefix}] ${message}`),
    info: (message: string) => internalAPI.logInfo(`[${prefix}] ${message}`),
    warn: (message: string) => internalAPI.logWarn(`[${prefix}] ${message}`),
    trace: (message: string) => internalAPI.logTrace(`[${prefix}] ${message}`),
    debug: (message: string) => internalAPI.logDebug(`[${prefix}] ${message}`),
  });

  const toSDKGoal = (goal: Goal): SDKGoal => {
    const targetAmount = goal.targetAmount ?? goal.summaryTargetAmount ?? 0;

    return {
      id: goal.id,
      goalType: goal.goalType,
      title: goal.title,
      description: goal.description ?? undefined,
      targetAmount,
      statusLifecycle: goal.statusLifecycle,
      statusHealth: goal.statusHealth,
      priority: goal.priority,
      coverImageKey: goal.coverImageKey ?? undefined,
      currency: goal.currency ?? undefined,
      startDate: goal.startDate ?? undefined,
      targetDate: goal.targetDate ?? undefined,
      summaryCurrentValue: goal.summaryCurrentValue ?? undefined,
      summaryProgress: goal.summaryProgress ?? undefined,
      projectedCompletionDate: goal.projectedCompletionDate ?? undefined,
      projectedValueAtTargetDate: goal.projectedValueAtTargetDate ?? undefined,
      summaryTargetAmount: goal.summaryTargetAmount ?? targetAmount,
      createdAt: goal.createdAt ?? undefined,
      updatedAt: goal.updatedAt ?? undefined,
    };
  };

  const toSDKGoalAllocation = (rule: GoalFundingRule): SDKGoalAllocation => ({
    id: rule.id,
    goalId: rule.goalId,
    accountId: rule.accountId,
    sharePercent: rule.sharePercent,
    taxBucket: rule.taxBucket,
  });

  const toGoalFundingRuleInput = (allocation: SDKGoalAllocation): GoalFundingRuleInput => {
    if (!Number.isFinite(allocation.sharePercent)) {
      throw new Error("Goal allocation sharePercent must be a number");
    }
    return {
      accountId: allocation.accountId,
      sharePercent: allocation.sharePercent,
      taxBucket: allocation.taxBucket,
    };
  };

  const getGoalAllocations = async (): Promise<SDKGoalAllocation[]> => {
    const goals = await internalAPI.getGoals();
    const allocations = await Promise.all(goals.map((goal) => internalAPI.getGoalFunding(goal.id)));
    return allocations.flat().map(toSDKGoalAllocation);
  };

  const getGoalFunding = async (goalId: string): Promise<SDKGoalAllocation[]> => {
    const rules = await internalAPI.getGoalFunding(goalId);
    return rules.map(toSDKGoalAllocation);
  };

  const saveGoalFunding = async (
    goalId: string,
    allocations: SDKGoalAllocation[],
  ): Promise<SDKGoalAllocation[]> => {
    const rules = await internalAPI.saveGoalFunding(
      goalId,
      allocations.map(toGoalFundingRuleInput),
    );
    return rules.map(toSDKGoalAllocation);
  };

  const updateGoalAllocations = async (allocations: SDKGoalAllocation[]): Promise<void> => {
    const byGoalId = new Map<string, GoalFundingRuleInput[]>();
    for (const allocation of allocations) {
      const rules = byGoalId.get(allocation.goalId) ?? [];
      rules.push(toGoalFundingRuleInput(allocation));
      byGoalId.set(allocation.goalId, rules);
    }

    await Promise.all(
      Array.from(byGoalId, ([goalId, rules]) => internalAPI.saveGoalFunding(goalId, rules)),
    );
  };

  const accounts = guardNamespace(
    {
      getAll: internalAPI.getAccounts,
      create: internalAPI.createAccount,
    },
    "accounts",
    guard,
  );
  const portfolio = guardNamespace(
    {
      getHoldings: internalAPI.getHoldings,
      getHolding: internalAPI.getHolding,
      update: internalAPI.updatePortfolio,
      recalculate: internalAPI.recalculatePortfolio,
      getIncomeSummary: internalAPI.getIncomeSummary,
      getHistoricalValuations: internalAPI.getHistoricalValuations,
      getLatestValuations: internalAPI.getLatestValuations,
    },
    "portfolio",
    guard,
  );
  const activities = guardNamespace(
    {
      getAll: internalAPI.getActivities,
      search: internalAPI.searchActivities,
      create: internalAPI.createActivity,
      update: internalAPI.updateActivity,
      saveMany: (input: ActivityUpdate[] | ActivityBulkMutationRequest) =>
        Array.isArray(input)
          ? internalAPI.saveActivities({ updates: input })
          : internalAPI.saveActivities(input),
      import: (activities: ActivityImport[]) => internalAPI.importActivities({ activities }),
      checkImport: (activities: ActivityImport[]) =>
        internalAPI.checkActivitiesImport({ activities }),
      getImportMapping: internalAPI.getAccountImportMapping,
      saveImportMapping: internalAPI.saveAccountImportMapping,
    },
    "activities",
    guard,
  );
  const market = guardNamespace(
    {
      searchTicker: internalAPI.searchTicker,
      syncHistory: internalAPI.syncHistoryQuotes,
      sync: internalAPI.syncMarketData,
      getProviders: internalAPI.getMarketDataProviders,
      fetchDividends: internalAPI.fetchDividends,
    },
    "market-data",
    guard,
  );
  const assets = guardNamespace(
    {
      getProfile: internalAPI.getAssetProfile,
      updateProfile: internalAPI.updateAssetProfile,
      updateQuoteMode: internalAPI.updateQuoteMode,
    },
    "assets",
    guard,
  );
  const quotes = guardNamespace(
    {
      update: internalAPI.updateQuote,
      getHistory: internalAPI.getQuoteHistory,
    },
    "quotes",
    guard,
  );
  const performance = guardNamespace(
    {
      calculateHistory: internalAPI.calculatePerformanceHistory,
      calculateSummary: internalAPI.calculatePerformanceSummary,
      calculateAccountsSimple: internalAPI.calculateAccountsSimplePerformance,
    },
    "performance",
    guard,
  );
  const exchangeRates = guardNamespace(
    {
      getAll: internalAPI.getExchangeRates,
      update: internalAPI.updateExchangeRate,
      add: internalAPI.addExchangeRate,
    },
    "currency",
    guard,
  );
  const contributionLimits = guardNamespace(
    {
      getAll: internalAPI.getContributionLimit,
      create: internalAPI.createContributionLimit,
      update: internalAPI.updateContributionLimit,
      calculateDeposits: internalAPI.calculateDepositsForLimit,
    },
    "contribution-limits",
    guard,
  );
  const goals = guardNamespace(
    {
      getAll: async () => (await internalAPI.getGoals()).map(toSDKGoal),
      create: async (goal: unknown) => toSDKGoal(await internalAPI.createGoal(goal)),
      update: async (goal: SDKGoal) => toSDKGoal(await internalAPI.updateGoal(goal)),
      getFunding: getGoalFunding,
      saveFunding: saveGoalFunding,
      getAllocations: getGoalAllocations,
      updateAllocations: updateGoalAllocations,
    },
    "financial-planning",
    guard,
  );
  const settings = guardNamespace(
    {
      get: internalAPI.getSettings,
      update: internalAPI.updateSettings,
      backupDatabase: internalAPI.backupDatabase,
    },
    "settings",
    guard,
  );
  const files = guardNamespace(
    {
      openCsvDialog: internalAPI.openCsvFileDialog,
      openSaveDialog: internalAPI.openFileSaveDialog,
    },
    "files",
    guard,
  );
  const snapshots = guardNamespace(
    {
      getAll: internalAPI.getSnapshots,
      getByDate: internalAPI.getSnapshotByDate,
      save: internalAPI.saveManualHoldings,
      checkImport: internalAPI.checkHoldingsImport,
      importSnapshots: internalAPI.importHoldingsCsv,
      delete: internalAPI.deleteSnapshot,
    },
    "snapshots",
    guard,
  );

  const events = guardEventsNamespace(
    {
      import: {
        onDropHover: internalAPI.listenImportFileDropHover,
        onDrop: internalAPI.listenImportFileDrop,
        onDropCancelled: internalAPI.listenImportFileDropCancelled,
      },
      portfolio: {
        onUpdateStart: internalAPI.listenPortfolioUpdateStart,
        onUpdateComplete: internalAPI.listenPortfolioUpdateComplete,
        onUpdateError: internalAPI.listenPortfolioUpdateError,
      },
      market: {
        onSyncStart: internalAPI.listenMarketSyncStart,
        onSyncComplete: internalAPI.listenMarketSyncComplete,
      },
    },
    guard,
  );
  const requestNetwork = (request: SDKNetworkRequest) => {
    guard?.assertCanUse("network", "request");
    if (request.auth) {
      guard?.assertCanUse("secrets", "use");
    }
    return internalAPI.addonNetworkRequest(request);
  };

  return {
    accounts: accounts as unknown as SDKApiWithoutSecrets["accounts"],
    portfolio: portfolio as unknown as SDKApiWithoutSecrets["portfolio"],
    activities: activities as unknown as SDKApiWithoutSecrets["activities"],
    market: market as unknown as SDKApiWithoutSecrets["market"],
    assets: assets as unknown as SDKApiWithoutSecrets["assets"],
    quotes: quotes as unknown as SDKApiWithoutSecrets["quotes"],
    performance: performance as unknown as SDKApiWithoutSecrets["performance"],
    exchangeRates: exchangeRates as unknown as SDKApiWithoutSecrets["exchangeRates"],
    contributionLimits: contributionLimits as unknown as SDKApiWithoutSecrets["contributionLimits"],
    goals: goals as unknown as SDKApiWithoutSecrets["goals"],
    settings: settings as unknown as SDKApiWithoutSecrets["settings"],
    files: files as unknown as SDKApiWithoutSecrets["files"],
    snapshots: snapshots as unknown as SDKApiWithoutSecrets["snapshots"],

    logger: createAddonLogger(addonId || "unknown-addon"),

    events: events as unknown as SDKApiWithoutSecrets["events"],

    navigation: {
      navigate: async (route: string) => {
        return internalAPI.navigateToRoute(route);
      },
    },

    query: {
      getClient: () => {
        throw new Error("Direct QueryClient access is not available to addons");
      },
      invalidateQueries: (queryKey: string | string[]) => {
        return internalAPI.invalidateQueries(queryKey);
      },
      refetchQueries: (queryKey: string | string[]) => {
        return internalAPI.refetchQueries(queryKey);
      },
    },

    network: {
      request: requestNetwork,
    } as unknown as SDKApiWithoutSecrets["network"],

    toast: {
      success: internalAPI.toastSuccess,
      error: internalAPI.toastError,
      warning: internalAPI.toastWarning,
      info: internalAPI.toastInfo,
    },
  };
}
