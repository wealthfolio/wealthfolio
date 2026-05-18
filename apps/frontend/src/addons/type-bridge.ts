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
  PerformanceMetrics,
  Quote,
  SnapshotInfo,
  SymbolSearchResult,
  Settings,
  SimplePerformanceMetrics,
  UpdateAssetProfile,
} from "@/lib/types";
import type { HoldingInput } from "@/adapters";
import type {
  Goal as SDKGoal,
  GoalAllocation as SDKGoalAllocation,
  HostAPI as SDKHostAPI,
} from "@wealthfolio/addon-sdk";

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
  fetchYahooDividends(symbol: string): Promise<{ amount: number; date: number }[]>;
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
    startDate: string,
    endDate: string,
  ): Promise<PerformanceMetrics>;
  calculatePerformanceSummary(args: {
    itemType: "account" | "symbol";
    itemId: string;
    startDate?: string | null;
    endDate?: string | null;
  }): Promise<PerformanceMetrics>;
  calculateAccountsSimplePerformance(accountIds: string[]): Promise<SimplePerformanceMetrics[]>;
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

  // Toast functions
  toastSuccess(message: string): void;
  toastError(message: string): void;
  toastWarning(message: string): void;
  toastInfo(message: string): void;
}

/**
 * Type bridge utility to convert between internal and SDK types
 * This handles the mapping between the actual implementation types and the public SDK types
 */
export function createSDKHostAPIBridge(
  internalAPI: InternalHostAPI,
  addonId?: string,
): Omit<SDKHostAPI, "secrets"> {
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

  return {
    accounts: {
      getAll: internalAPI.getAccounts,
      create: internalAPI.createAccount,
    },
    portfolio: {
      getHoldings: internalAPI.getHoldings,
      getHolding: internalAPI.getHolding,
      update: internalAPI.updatePortfolio,
      recalculate: internalAPI.recalculatePortfolio,
      getIncomeSummary: internalAPI.getIncomeSummary,
      getHistoricalValuations: internalAPI.getHistoricalValuations,
      getLatestValuations: internalAPI.getLatestValuations,
    },
    activities: {
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
    market: {
      searchTicker: internalAPI.searchTicker,
      syncHistory: internalAPI.syncHistoryQuotes,
      sync: internalAPI.syncMarketData,
      getProviders: internalAPI.getMarketDataProviders,
      fetchDividends: internalAPI.fetchYahooDividends,
    },
    assets: {
      getProfile: internalAPI.getAssetProfile,
      updateProfile: internalAPI.updateAssetProfile,
      updateQuoteMode: internalAPI.updateQuoteMode,
    },
    quotes: {
      update: internalAPI.updateQuote,
      getHistory: internalAPI.getQuoteHistory,
    },
    performance: {
      calculateHistory: internalAPI.calculatePerformanceHistory,
      calculateSummary: internalAPI.calculatePerformanceSummary,
      calculateAccountsSimple: internalAPI.calculateAccountsSimplePerformance,
    },
    exchangeRates: {
      getAll: internalAPI.getExchangeRates,
      update: internalAPI.updateExchangeRate,
      add: internalAPI.addExchangeRate,
    },
    contributionLimits: {
      getAll: internalAPI.getContributionLimit,
      create: internalAPI.createContributionLimit,
      update: internalAPI.updateContributionLimit,
      calculateDeposits: internalAPI.calculateDepositsForLimit,
    },
    goals: {
      getAll: async () => (await internalAPI.getGoals()).map(toSDKGoal),
      create: async (goal) => toSDKGoal(await internalAPI.createGoal(goal)),
      update: async (goal) => toSDKGoal(await internalAPI.updateGoal(goal)),
      getFunding: getGoalFunding,
      saveFunding: saveGoalFunding,
      getAllocations: getGoalAllocations,
      updateAllocations: updateGoalAllocations,
    },
    settings: {
      get: internalAPI.getSettings,
      update: internalAPI.updateSettings,
      backupDatabase: internalAPI.backupDatabase,
    },
    files: {
      openCsvDialog: internalAPI.openCsvFileDialog,
      openSaveDialog: internalAPI.openFileSaveDialog,
    },
    snapshots: {
      getAll: internalAPI.getSnapshots,
      getByDate: internalAPI.getSnapshotByDate,
      save: internalAPI.saveManualHoldings,
      checkImport: internalAPI.checkHoldingsImport,
      importSnapshots: internalAPI.importHoldingsCsv,
      delete: internalAPI.deleteSnapshot,
    },

    logger: createAddonLogger(addonId || "unknown-addon"),

    events: {
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

    navigation: {
      navigate: internalAPI.navigateToRoute,
    },

    query: {
      getClient: internalAPI.getQueryClient,
      invalidateQueries: internalAPI.invalidateQueries,
      refetchQueries: internalAPI.refetchQueries,
    },

    toast: {
      success: internalAPI.toastSuccess,
      error: internalAPI.toastError,
      warning: internalAPI.toastWarning,
      info: internalAPI.toastInfo,
    },
  };
}
