/**
 * Host API interface for addon development
 * Provides comprehensive access to Wealthfolio functionality organized by domain
 */

import type { EventCallback, UnlistenFn } from './types';
import type {
  Account,
  Activity,
  ActivityBulkMutationRequest,
  ActivityBulkMutationResult,
  ActivityCreate,
  ActivityDetails,
  ActivityImport,
  ActivitySearchResponse,
  ActivityUpdate,
  AccountValuation,
  CheckSnapshotImportResult,
  ImportActivitiesResult,
  Asset,
  ContributionLimit,
  DepositsCalculation,
  ExchangeRate,
  Goal,
  GoalAllocation,
  Holding,
  ImportMappingData,
  IncomeSummary,
  MarketDataProviderInfo,
  NewContributionLimit,
  PerformanceResult,
  Quote,
  Settings,
  SimplePerformanceResult,
  SnapshotHoldingInput,
  SnapshotImportResult,
  SnapshotInfo,
  SnapshotInput,
  SymbolSearchResult,
  UpdateAssetProfile,
} from './data-types';

export interface ActivitySearchFilters {
  accountIds?: string | string[];
  activityTypes?: string | string[];
  symbol?: string;
}

export interface ActivitySort {
  id: string;
  desc?: boolean;
}

/**
 * Account management APIs
 */
export interface AccountsAPI {
  /**
   * Get all accounts
   * @returns Promise resolving to array of accounts
   */
  getAll(): Promise<Account[]>;

  /**
   * Create a new account
   * @param account New account data
   * @returns Promise resolving to created account
   */
  create(account: unknown): Promise<Account>;
}

/**
 * Portfolio and holdings APIs
 */
export interface PortfolioAPI {
  /**
   * Get holdings for a specific account
   * @param accountId Account identifier
   * @returns Promise resolving to array of holdings
   */
  getHoldings(accountId: string): Promise<Holding[]>;

  /**
   * Get specific holding information
   * @param accountId Account identifier
   * @param assetId Asset identifier
   * @returns Promise resolving to holding or null if not found
   */
  getHolding(accountId: string, assetId: string): Promise<Holding | null>;

  /**
   * Update portfolio calculations
   * @returns Promise that resolves when update is complete
   */
  update(): Promise<void>;

  /**
   * Recalculate entire portfolio
   * @returns Promise that resolves when recalculation is complete
   */
  recalculate(): Promise<void>;

  /**
   * Get income summary data
   * @returns Promise resolving to array of income summaries
   */
  getIncomeSummary(): Promise<IncomeSummary[]>;

  /**
   * Get historical valuations
   * @param accountId Optional account identifier
   * @param startDate Optional start date
   * @param endDate Optional end date
   * @returns Promise resolving to array of account valuations
   */
  getHistoricalValuations(
    accountId?: string,
    startDate?: string,
    endDate?: string,
  ): Promise<AccountValuation[]>;

  /**
   * Get latest valuations for a set of accounts
   * @param accountIds Array of account identifiers
   * @returns Promise resolving to array of latest account valuations
   */
  getLatestValuations(accountIds: string[]): Promise<AccountValuation[]>;
}

/**
 * Activity management APIs
 */
export interface ActivitiesAPI {
  /**
   * Get activities, optionally filtered by account
   * @param accountId Optional account identifier for filtering
   * @returns Promise resolving to array of activity details
   */
  getAll(accountId?: string): Promise<ActivityDetails[]>;

  /**
   * Search activities with pagination and filters
   * @param page Page number
   * @param pageSize Number of items per page
   * @param filters Filter criteria
   * @param searchKeyword Search keyword
   * @param sort Sort criteria
   * @returns Promise resolving to search response
   */
  search(
    page: number,
    pageSize: number,
    filters: ActivitySearchFilters,
    searchKeyword: string,
    sort?: ActivitySort,
  ): Promise<ActivitySearchResponse>;

  /**
   * Create a new activity
   * @param activity New activity data
   * @returns Promise resolving to created activity
   */
  create(activity: ActivityCreate): Promise<Activity>;

  /**
   * Update an existing activity
   * @param activity Updated activity data
   * @returns Promise resolving to updated activity
   */
  update(activity: ActivityUpdate): Promise<Activity>;

  /**
   * Save multiple activities (create/update/delete) in a single request.
   * @param request Bulk mutation payload
   * @returns Promise resolving to detailed mutation result
   */
  saveMany(request: ActivityBulkMutationRequest): Promise<ActivityBulkMutationResult>;

  /**
   * Import activities from parsed data
   * @param activities Array of activities to import
   * @returns Promise resolving to import result with activities, run ID, and summary
   */
  import(activities: ActivityImport[]): Promise<ImportActivitiesResult>;

  /**
   * Check activities before import (read-only validation/preview)
   * @param activities Array of activities to check
   * @returns Promise resolving to validated activities
   */
  checkImport(activities: ActivityImport[]): Promise<ActivityImport[]>;

  /**
   * Get import mapping configuration for an account
   * @param accountId Account identifier
   * @param contextKind Optional context kind (defaults to 'ACTIVITY')
   * @returns Promise resolving to import mapping data
   */
  getImportMapping(accountId: string, contextKind?: string): Promise<ImportMappingData>;

  /**
   * Save import mapping configuration
   * @param mapping Import mapping data to save
   * @returns Promise resolving to saved mapping data
   */
  saveImportMapping(mapping: ImportMappingData): Promise<ImportMappingData>;
}

/**
 * A cash dividend event returned by a market data provider.
 */
export interface DividendEvent {
  amount: number;
  date: number; // unix seconds
}

export interface FetchDividendsOptions {
  exchangeMic?: string;
  instrumentType?: string;
  quoteCcy?: string;
  providerId?: string;
  startDate?: string;
  endDate?: string;
}

/**
 * Market data and asset APIs
 */
export interface MarketDataAPI {
  /**
   * Search for ticker symbols
   * @param query Search query
   * @returns Promise resolving to array of quote summaries
   */
  searchTicker(query: string): Promise<SymbolSearchResult[]>;

  /**
   * Synchronize historical quotes
   * @returns Promise that resolves when sync is complete
   */
  syncHistory(): Promise<void>;

  /**
   * Synchronize market data for specific assets
   * @param assetIds Array of asset identifiers to sync
   * @param refetchAll Whether to refetch all data
   * @param refetchRecentDays Optional number of recent days to refetch
   * @returns Promise that resolves when sync is complete
   */
  sync(
    assetIds: string[],
    refetchAll: boolean,
    refetchRecentDays?: number,
  ): Promise<void>;

  /**
   * Get market data providers information
   * @returns Promise resolving to array of provider info
   */
  getProviders(): Promise<MarketDataProviderInfo[]>;

  /**
   * Fetch dividend history for a symbol.
   * @param symbol Ticker symbol
   * @returns Promise resolving to array of dividend events
   */
  fetchDividends(
    symbol: string,
    options?: FetchDividendsOptions,
  ): Promise<DividendEvent[]>;
}

/**
 * Asset management APIs
 */
export interface AssetsAPI {
  /**
   * Get asset profile information
   * @param assetId Asset identifier
   * @returns Promise resolving to asset profile
   */
  getProfile(assetId: string): Promise<Asset>;

  /**
   * Update asset profile information
   * @param payload Updated asset profile data
   * @returns Promise resolving to updated asset
   */
  updateProfile(payload: UpdateAssetProfile): Promise<Asset>;

  /**
   * Update asset quote mode (MARKET or MANUAL)
   * @param assetId Asset identifier
   * @param quoteMode New quote mode
   * @returns Promise resolving to updated asset
   */
  updateQuoteMode(assetId: string, quoteMode: string): Promise<Asset>;
}

/**
 * Quote management APIs
 */
export interface QuotesAPI {
  /**
   * Update quote information
   * @param assetId Asset identifier
   * @param quote Updated quote data
   * @returns Promise that resolves when update is complete
   */
  update(assetId: string, quote: Quote): Promise<void>;

  /**
   * Get quote history for an asset
   * @param assetId Asset identifier
   * @returns Promise resolving to array of quotes
   */
  getHistory(assetId: string): Promise<Quote[]>;
}

/**
 * Performance calculation APIs
 */
export interface PerformanceAPI {
  /**
   * Calculate performance history
   * @param itemType Type of item ('account' or 'symbol')
   * @param itemId Item identifier
   * @param startDate Start date for calculation
   * @param endDate End date for calculation
   * @returns Promise resolving to performance metrics
   */
  calculateHistory(
    itemType: 'account' | 'symbol',
    itemId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<PerformanceResult>;

  /**
   * Calculate performance summary
   * @param args Performance calculation arguments
   * @returns Promise resolving to performance metrics
   */
  calculateSummary(args: {
    itemType: 'account' | 'symbol';
    itemId: string;
    startDate?: string | null;
    endDate?: string | null;
  }): Promise<PerformanceResult>;

  /**
   * Calculate simple performance for multiple accounts
   * @param accountIds Array of account identifiers
   * @returns Promise resolving to array of simple performance metrics
   */
  calculateAccountsSimple(accountIds: string[]): Promise<SimplePerformanceResult[]>;
}

/**
 * Exchange rates APIs
 */
export interface ExchangeRatesAPI {
  /**
   * Get all exchange rates
   * @returns Promise resolving to array of exchange rates
   */
  getAll(): Promise<ExchangeRate[]>;

  /**
   * Update an existing exchange rate
   * @param updatedRate Updated exchange rate data
   * @returns Promise resolving to updated exchange rate
   */
  update(updatedRate: ExchangeRate): Promise<ExchangeRate>;

  /**
   * Add a new exchange rate
   * @param newRate New exchange rate data (without ID)
   * @returns Promise resolving to created exchange rate
   */
  add(newRate: Omit<ExchangeRate, 'id'>): Promise<ExchangeRate>;
}

/**
 * Contribution limits APIs
 */
export interface ContributionLimitsAPI {
  /**
   * Get all contribution limits
   * @returns Promise resolving to array of contribution limits
   */
  getAll(): Promise<ContributionLimit[]>;

  /**
   * Create a new contribution limit
   * @param newLimit New contribution limit data
   * @returns Promise resolving to created contribution limit
   */
  create(newLimit: NewContributionLimit): Promise<ContributionLimit>;

  /**
   * Update an existing contribution limit
   * @param id Contribution limit identifier
   * @param updatedLimit Updated contribution limit data
   * @returns Promise resolving to updated contribution limit
   */
  update(id: string, updatedLimit: NewContributionLimit): Promise<ContributionLimit>;

  /**
   * Calculate deposits for a specific contribution limit
   * @param limitId Contribution limit identifier
   * @returns Promise resolving to deposits calculation
   */
  calculateDeposits(limitId: string): Promise<DepositsCalculation>;
}

/**
 * Goals management APIs
 */
export interface GoalsAPI {
  /**
   * Get all goals
   * @returns Promise resolving to array of goals
   */
  getAll(): Promise<Goal[]>;

  /**
   * Create a new goal
   * @param goal New goal data
   * @returns Promise resolving to created goal
   */
  create(goal: unknown): Promise<Goal>;

  /**
   * Update an existing goal
   * @param goal Updated goal data
   * @returns Promise resolving to updated goal
   */
  update(goal: Goal): Promise<Goal>;

  /**
   * Get funding rules for a goal
   * @param goalId Goal ID
   * @returns Promise resolving to array of funding rules
   */
  getFunding(goalId: string): Promise<GoalAllocation[]>;

  /**
   * Get funding rules across all goals
   * @deprecated Use getAll() and getFunding(goalId). This compatibility shim will be removed in a future major version.
   * @returns Promise resolving to array of funding rules
   */
  getAllocations(): Promise<GoalAllocation[]>;

  /**
   * Save funding rules for a goal
   * @param goalId Goal ID
   * @param rules Array of funding rule inputs
   * @returns Promise resolving to saved rules
   */
  saveFunding(goalId: string, rules: GoalAllocation[]): Promise<GoalAllocation[]>;

  /**
   * Save funding rules grouped by goalId
   * @deprecated Use saveFunding(goalId, rules). This compatibility shim will be removed in a future major version.
   * @param allocations Array of funding rules
   * @returns Promise resolving when funding rules are saved
   */
  updateAllocations(allocations: GoalAllocation[]): Promise<void>;
}

/**
 * Application settings APIs
 */
export interface SettingsAPI {
  /**
   * Get application settings
   * @returns Promise resolving to settings
   */
  get(): Promise<Settings>;

  /**
   * Update application settings
   * @param settingsUpdate Updated settings data
   * @returns Promise resolving to updated settings
   */
  update(settingsUpdate: Partial<Settings>): Promise<Settings>;

  /**
   * Create database backup
   * @returns Promise resolving to backup file information
   */
  backupDatabase(): Promise<{ filename: string }>;
}

/**
 * File operations APIs
 */
export interface FilesAPI {
  /**
   * Open CSV file dialog
   * @returns Promise resolving to file path(s) or null if cancelled
   */
  openCsvDialog(): Promise<null | string | string[]>;

  /**
   * Open file save dialog
   * @param fileContent File content to save
   * @param fileName Default file name
   * @returns Promise resolving to save result
   */
  openSaveDialog(
    fileContent: Uint8Array | Blob | string,
    fileName: string,
  ): Promise<unknown>;
}

/**
 * Secrets management APIs
 * Provides secure storage for addon secrets using the system keyring
 * Each addon can only access its own secrets
 */
export interface SecretsAPI {
  /**
   * Store a secret value for this addon
   * @param key Secret key identifier
   * @param value Secret value to store
   * @returns Promise that resolves when secret is stored
   */
  set(key: string, value: string): Promise<void>;

  /**
   * Retrieve a secret value for this addon
   * @param key Secret key identifier
   * @returns Promise resolving to secret value or null if not found
   */
  get(key: string): Promise<string | null>;

  /**
   * Delete a secret for this addon
   * @param key Secret key identifier
   * @returns Promise that resolves when secret is deleted
   */
  delete(key: string): Promise<void>;
}

/**
 * Storage APIs
 * Durable per-addon key-value storage (SQLite-backed on the host).
 * Values are opaque strings owned by the addon; storage survives addon
 * updates and is removed on uninstall. Each addon can only access its own
 * storage. Use this instead of `localStorage`, which is unavailable in the
 * sandboxed (opaque-origin) iframe.
 *
 * Keys are ≤ 128 characters from the charset `[A-Za-z0-9_.:-]`. Values are
 * capped at roughly 250 KB each (the storage replicates across a user's paired
 * devices, which bounds per-item size); `set` rejects an oversized value. Use
 * many small keys rather than one large blob, and keep device-local caches out
 * of storage.
 */
export interface StorageAPI {
  /**
   * Retrieve a stored value for this addon
   * @param key Storage key identifier
   * @returns Promise resolving to the stored value or null if not found
   */
  get(key: string): Promise<string | null>;

  /**
   * Store a value for this addon
   * @param key Storage key identifier
   * @param value Value to store
   * @returns Promise that resolves when the value is stored
   */
  set(key: string, value: string): Promise<void>;

  /**
   * Delete a stored value for this addon
   * @param key Storage key identifier
   * @returns Promise that resolves when the value is deleted
   */
  delete(key: string): Promise<void>;
}

/**
 * Logger APIs
 * Provides logging functionality with automatic addon prefix
 * All log messages will be prefixed with the addon ID for easy identification
 */
export interface LoggerAPI {
  /**
   * Log an error message
   * @param message Error message to log
   */
  error(message: string): void;

  /**
   * Log an info message
   * @param message Info message to log
   */
  info(message: string): void;

  /**
   * Log a warning message
   * @param message Warning message to log
   */
  warn(message: string): void;

  /**
   * Log a trace message (for detailed debugging)
   * @param message Trace message to log
   */
  trace(message: string): void;

  /**
   * Log a debug message
   * @param message Debug message to log
   */
  debug(message: string): void;
}

/**
 * Event listeners APIs
 */
export interface EventsAPI {
  /**
   * Import file events
   */
  import: {
    /**
     * Listen for import file drop hover events
     * @param handler Event handler
     * @returns Promise resolving to unlisten function
     */
    onDropHover<T>(handler: EventCallback<T>): Promise<UnlistenFn>;

    /**
     * Listen for import file drop events
     * @param handler Event handler
     * @returns Promise resolving to unlisten function
     */
    onDrop<T>(handler: EventCallback<T>): Promise<UnlistenFn>;

    /**
     * Listen for import file drop cancelled events
     * @param handler Event handler
     * @returns Promise resolving to unlisten function
     */
    onDropCancelled<T>(handler: EventCallback<T>): Promise<UnlistenFn>;
  };

  /**
   * Portfolio events
   */
  portfolio: {
    /**
     * Listen for portfolio update start events
     * @param handler Event handler
     * @returns Promise resolving to unlisten function
     */
    onUpdateStart<T>(handler: EventCallback<T>): Promise<UnlistenFn>;

    /**
     * Listen for portfolio update complete events
     * @param handler Event handler
     * @returns Promise resolving to unlisten function
     */
    onUpdateComplete<T>(handler: EventCallback<T>): Promise<UnlistenFn>;

    /**
     * Listen for portfolio update error events
     * @param handler Event handler
     * @returns Promise resolving to unlisten function
     */
    onUpdateError<T>(handler: EventCallback<T>): Promise<UnlistenFn>;
  };

  /**
   * Market sync events
   */
  market: {
    /**
     * Listen for market sync start events
     * @param handler Event handler
     * @returns Promise resolving to unlisten function
     */
    onSyncStart<T>(handler: EventCallback<T>): Promise<UnlistenFn>;

    /**
     * Listen for market sync complete events
     * @param handler Event handler
     * @returns Promise resolving to unlisten function
     */
    onSyncComplete<T>(handler: EventCallback<T>): Promise<UnlistenFn>;
  };
}

/**
 * Navigation APIs
 */
export interface NavigationAPI {
  /**
   * Navigate to a route in the application
   * @param route The route path to navigate to
   * @returns Promise that resolves when navigation is complete
   */
  navigate(route: string): Promise<void>;
}

/**
 * Toast notification APIs
 * Allows addons to show toast notifications using the host application's toast system
 */
export interface ToastAPI {
  /**
   * Show a success toast
   * @param message Message to display
   */
  success(message: string): void;

  /**
   * Show an error toast
   * @param message Message to display
   */
  error(message: string): void;

  /**
   * Show a warning toast
   * @param message Message to display
   */
  warning(message: string): void;

  /**
   * Show an info toast
   * @param message Message to display
   */
  info(message: string): void;
}

/**
 * Query management APIs for React Query integration
 */
export interface QueryAPI {
  /**
   * Get the shared QueryClient instance from the main application
   * @returns The shared QueryClient instance
   */
  getClient(): unknown; // QueryClient from @tanstack/react-query

  /**
   * Invalidate queries by key
   * @param queryKey The query key to invalidate
   */
  invalidateQueries(queryKey: string | string[]): void;

  /**
   * Refetch queries by key
   * @param queryKey The query key to refetch
   */
  refetchQueries(queryKey: string | string[]): void;
}

export interface NetworkRequest {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string;
  auth?: NetworkAuth;
}

export interface NetworkResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface NetworkAuth {
  /**
   * Authorization scheme. For `basic`, the stored secret must be the
   * base64-encoded `user:pass` value.
   */
  type: 'bearer' | 'basic';
  secretKey: string;
}

export interface NetworkAPI {
  /**
   * Send a brokered HTTPS request to a host declared in the addon manifest.
   */
  request(request: NetworkRequest): Promise<NetworkResponse>;
}

/**
 * Snapshot management APIs
 * For accounts using HOLDINGS tracking mode
 */
export interface SnapshotsAPI {
  getAll(accountId: string, dateFrom?: string, dateTo?: string): Promise<SnapshotInfo[]>;
  getByDate(accountId: string, date: string): Promise<Holding[]>;
  save(
    accountId: string,
    holdings: SnapshotHoldingInput[],
    cashBalances: Record<string, string>,
    snapshotDate?: string,
  ): Promise<void>;
  checkImport(
    accountId: string,
    snapshots: SnapshotInput[],
  ): Promise<CheckSnapshotImportResult>;
  importSnapshots(
    accountId: string,
    snapshots: SnapshotInput[],
  ): Promise<SnapshotImportResult>;
  delete(accountId: string, date: string): Promise<void>;
}

/**
 * Comprehensive Host API interface providing access to all Wealthfolio functionality
 * Organized by functional domains for better discoverability and maintainability
 */
export interface HostAPI {
  /** Account management operations */
  accounts: AccountsAPI;

  /** Portfolio and holdings operations */
  portfolio: PortfolioAPI;

  /** Activity management operations */
  activities: ActivitiesAPI;

  /** Market data operations */
  market: MarketDataAPI;

  /** Asset management operations */
  assets: AssetsAPI;

  /** Quote management operations */
  quotes: QuotesAPI;

  /** Performance calculation operations */
  performance: PerformanceAPI;

  /** Exchange rates operations */
  exchangeRates: ExchangeRatesAPI;

  /** Contribution limits operations */
  contributionLimits: ContributionLimitsAPI;

  /** Goals management operations */
  goals: GoalsAPI;

  /** Application settings operations */
  settings: SettingsAPI;

  /** File operations */
  files: FilesAPI;

  /** Snapshot management for HOLDINGS mode accounts */
  snapshots: SnapshotsAPI;

  /** Secrets management */
  secrets: SecretsAPI;

  /** Durable per-addon key-value storage */
  storage: StorageAPI;

  /** Logger operations */
  logger: LoggerAPI;

  /** Event listeners */
  events: EventsAPI;

  /** Navigation operations */
  navigation: NavigationAPI;

  /** React Query operations */
  query: QueryAPI;

  /** Brokered external network operations */
  network: NetworkAPI;

  /** Toast notification operations */
  toast: ToastAPI;
}
