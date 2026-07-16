export const QueryKeys = {
  // Portfolios (saved reporting scopes)
  PORTFOLIOS: "portfolios",

  // Account related keys
  ACCOUNTS: "accounts",
  ACCOUNTS_SUMMARY: "accounts_summary",

  // Spending module keys
  SPENDING_SETTINGS: "spending_settings",
  SPENDING_TRANSACTIONS: "spending_transactions",
  SPENDING_RULES: "spending_rules",
  SPENDING_EVENTS: "spending_events",
  SPENDING_EVENT_TYPES: "spending_event_types",
  SPENDING_BUDGET: "spending_budget",
  SPENDING_REPORT: "spending_report",
  SPENDING_INSIGHT: "spending_insight",

  // Activity related keys
  ACTIVITY_DATA: "activity-data",
  ACTIVITIES: "activities",

  // Portfolio related keys
  HOLDINGS: "holdings",
  HOLDING: "holding",
  ASSET_HOLDINGS: "assetHoldings",
  ASSET_LOTS: "assetLots",
  PORTFOLIO_ALLOCATIONS: "portfolioAllocations",
  HOLDINGS_BY_ALLOCATION: "holdingsByAllocation",
  INCOME_SUMMARY: "incomeSummary",
  PORTFOLIO_SUMMARY: "portfolioSummary",
  QUOTE_HISTORY: "quoteHistory",

  // Goals related keys
  GOALS: "goals",
  GOAL: "goal",
  goal: (id: string) => [QueryKeys.GOAL, id],
  GOAL_PLAN: "goalPlan",
  goalPlan: (id: string) => [QueryKeys.GOAL_PLAN, id],
  GOAL_FUNDING: "goalFunding",
  goalFunding: (id: string) => [QueryKeys.GOAL_FUNDING, id],
  RETIREMENT_OVERVIEW: "retirementOverview",
  retirementOverview: (id: string) => [QueryKeys.RETIREMENT_OVERVIEW, id],
  SAVE_UP_OVERVIEW: "saveUpOverview",
  saveUpOverview: (id: string) => [QueryKeys.SAVE_UP_OVERVIEW, id],
  SAVE_UP_PREVIEW: "saveUpPreview",

  // Settings related keys
  SETTINGS: "settings",
  DATABASE_BACKUPS: "databaseBackups",
  EXCHANGE_RATES: "exchangeRates",

  // New keys for exchange rates
  EXCHANGE_RATE_SYMBOLS: "exchange_rate_symbols",
  QUOTE: "quote",

  CONTRIBUTION_LIMITS: "contributionLimits",
  CONTRIBUTION_LIMIT_PROGRESS: "contributionLimitProgress",

  ASSET_DATA: "asset_data",
  ASSETS: "assets",
  LATEST_QUOTES: "latest_quotes",
  IMPORT_MAPPING: "import_mapping",
  IMPORT_TEMPLATES: "import_templates",

  PERFORMANCE_SUMMARY: "performanceSummary",
  PERFORMANCE_HISTORY: "performanceHistory",

  HISTORY_VALUATION: "historyValuation",
  // Helper function to create account-specific keys
  valuationHistory: (scope: unknown) => [QueryKeys.HISTORY_VALUATION, scope],

  // Account simple performance
  ACCOUNTS_SIMPLE_PERFORMANCE: "accountsSimplePerformance",
  accountsSimplePerformance: (accountIds: string[]) => [
    QueryKeys.ACCOUNTS_SIMPLE_PERFORMANCE,
    [...accountIds].sort().join(",") || "none",
  ],

  // Market Data Providers
  MARKET_DATA_PROVIDERS: "marketDataProviders",
  MARKET_DATA_PROVIDER_SETTINGS: "marketDataProviderSettings",
  CUSTOM_PROVIDERS: "CUSTOM_PROVIDERS",

  // AI Providers
  AI_PROVIDERS: "aiProviders",
  AI_PROVIDER_MODELS: "aiProviderModels",
  aiProviderModels: (providerId: string) => [QueryKeys.AI_PROVIDER_MODELS, providerId],

  // AI Chat
  AI_THREADS: "aiThreads",
  AI_THREAD: "aiThread",
  AI_THREAD_MESSAGES: "aiThreadMessages",
  aiThread: (threadId: string) => [QueryKeys.AI_THREAD, threadId],
  aiThreadMessages: (threadId: string) => [QueryKeys.AI_THREAD_MESSAGES, threadId],

  transactions: "transactions",
  latestValuations: "latest-valuations",
  CURRENT_VALUATION: "current-valuation",

  // Market Data
  symbolSearch: "symbol-search",

  ASSET_HISTORY: "asset-history",

  // Addons
  INSTALLED_ADDONS: "installedAddons",
  ADDON_STORE_LISTINGS: "addonStoreListings",
  ADDON_AUTO_UPDATE_CHECK: "addonAutoUpdateCheck",

  // Cloud Sync
  BROKER_CONNECTIONS: "brokerConnections",
  BROKER_ACCOUNTS: "brokerAccounts",
  PLATFORMS: "platforms",
  SYNCED_ACCOUNTS: "syncedAccounts",
  SUBSCRIPTION_PLANS: "subscriptionPlans",
  SUBSCRIPTION_PLANS_PUBLIC: "subscriptionPlansPublic",
  USER_INFO: "userInfo",
  BROKER_SYNC_STATES: "brokerSyncStates",
  IMPORT_RUNS: "importRuns",

  // Alternative Assets & Net Worth
  NET_WORTH: "netWorth",
  netWorth: (date?: string) => [QueryKeys.NET_WORTH, date ?? "current"],
  ALTERNATIVE_HOLDINGS: "alternativeHoldings",
  NET_WORTH_HISTORY: "netWorthHistory",
  netWorthHistory: (startDate: string, endDate: string) => [
    QueryKeys.NET_WORTH_HISTORY,
    startDate,
    endDate,
  ],

  secrets: {
    apiKey: (providerId: string) => ["secrets", "apiKey", providerId],
  },

  // Taxonomies
  TAXONOMIES: "taxonomies",
  TAXONOMY: "taxonomy",
  taxonomy: (id: string) => [QueryKeys.TAXONOMY, id],
  ASSET_TAXONOMY_ASSIGNMENTS: "assetTaxonomyAssignments",
  assetTaxonomyAssignments: (assetId: string) => [QueryKeys.ASSET_TAXONOMY_ASSIGNMENTS, assetId],
  ASSET_CLASSIFICATIONS: "asset-classifications",

  // Allocation Targets
  ALLOCATION_TARGETS: "allocationTargets",
  ALLOCATION_TARGET_WEIGHTS: "allocationTargetWeights",
  ALLOCATION_TARGET_DRIFT: "allocationTargetDrift",
  allocationTargetWeights: (targetId: string) => [QueryKeys.ALLOCATION_TARGET_WEIGHTS, targetId],
  allocationTargetDrift: (targetId: string, scope: unknown, includeHoldings = false) => [
    QueryKeys.ALLOCATION_TARGET_DRIFT,
    targetId,
    scope,
    includeHoldings,
  ],

  // Agent Access (MCP server + personal access tokens)
  AGENT_MCP_STATUS: "agentMcpStatus",
  AGENT_MCP_CONFIG: "agentMcpConfig",
  AGENT_ACCESS_STATUS: "agentAccessStatus",
  AGENT_ACCESS_TOKENS: "agentAccessTokens",
  AGENT_AUDIT_LOG: "agentAuditLog",
  agentAuditLog: (page: number, pageSize: number, tool?: string) => [
    QueryKeys.AGENT_AUDIT_LOG,
    page,
    pageSize,
    tool ?? "all",
  ],

  // Health Center
  HEALTH_STATUS: "healthStatus",
  HEALTH_CONFIG: "healthConfig",
  DISMISSED_HEALTH_ISSUES: "dismissedHealthIssues",

  // Snapshot Management
  SNAPSHOTS: "snapshots",
  snapshots: (accountId: string) => [QueryKeys.SNAPSHOTS, accountId],
  // Legacy alias for backwards compatibility
  MANUAL_SNAPSHOTS: "snapshots",
  manualSnapshots: (accountId: string) => [QueryKeys.SNAPSHOTS, accountId],
  SNAPSHOT_HOLDINGS: "snapshotHoldings",
  snapshotHoldings: (accountId: string, date: string) => [
    QueryKeys.SNAPSHOT_HOLDINGS,
    accountId,
    date,
  ],
} as const;
