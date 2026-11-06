import type { TFunction } from "i18next";

/**
 * User-friendly display names for structured addon function names
 * This mapping converts technical API function names to human-readable descriptions
 * that are more understandable for end users.
 *
 * Uses structured keys that match the Host API categories (e.g., 'accounts.getAll', 'portfolio.getHoldings')
 * as detected by the backend permission system in src-tauri/src/addons/service.rs
 *
 * Based on the Host API structure defined in packages/addon-sdk/src/host-api.ts
 */

export const FUNCTION_DISPLAY_NAMES: Record<string, string> = {
  // AccountsAPI functions
  "accounts.getAll": "View all accounts",
  "accounts.create": "Create new accounts",

  // AlternativeAssetsAPI functions
  "alternative-assets.getAll": "View alternative assets and liabilities",

  // PortfolioAPI functions
  "portfolio.getHoldings": "View your investment holdings",
  "portfolio.getHolding": "View individual holding details",
  "portfolio.update": "Update portfolio calculations",
  "portfolio.recalculate": "Recalculate entire portfolio",
  "portfolio.getIncomeSummary": "View income and dividends",
  "portfolio.getHistoricalValuations": "View historical portfolio values",
  "portfolio.getLatestValuations": "View current portfolio values",
  "portfolio.getNetWorth": "View net worth, including credit card balances",

  // ActivitiesAPI functions
  "activities.getAll": "View all transactions",
  "activities.search": "Search transactions with filters",
  "activities.searchCashActivities": "Search categorized spending transactions",
  "activities.assignCategory": "Categorize spending transactions",
  "activities.unassignCategory": "Clear a transaction category",
  "activities.setEvent": "Attach or clear transaction event tags",
  "spending.getContext": "View enabled spending accounts",
  "spending.getBudget": "View budgets and groups",
  "spending.getEvents": "View spending events",
  "spending.getEventTypes": "View event types",
  "budgets.upsertBudgetTarget": "Change default and monthly budget targets",
  "activities.create": "Add new transactions",
  "activities.update": "Modify transactions",
  "activities.saveMany": "Save multiple transactions",
  "activities.import": "Import transaction data",
  "activities.checkImport": "Validate import data",
  "activities.getImportMapping": "View import settings",
  "activities.saveImportMapping": "Save import settings",
  "activities.getTransferPair": "View linked transfer pairs",
  "activities.findTransferMatchCandidates": "Find matching transfer candidates",
  "activities.saveTransferPair": "Link transactions as a transfer",
  "activities.linkTransfer": "Link transactions as a transfer",
  "activities.unlinkTransfer": "Unlink transfer transactions",

  // MarketDataAPI functions
  "market.searchTicker": "Search for stocks/funds",
  "market.syncHistory": "Download price history",
  "market.sync": "Sync market data for symbols",
  "market.getProviders": "View market data providers",
  "market.fetchDividends": "Download dividend history",

  // AssetsAPI functions
  "assets.getProfile": "View asset profile details",
  "assets.updateProfile": "Update asset information",
  "assets.updateDataSource": "Change asset data provider",
  "assets.updateQuoteMode": "Switch between market and manual prices",

  // QuotesAPI functions
  "quotes.update": "Update current prices",
  "quotes.getHistory": "View price history",

  // PerformanceAPI functions
  "performance.calculateHistory": "Calculate performance history",
  "performance.calculateSummary": "Calculate performance summary",
  "performance.calculateAccountsSimple": "Calculate basic account performance",

  // ExchangeRatesAPI functions
  "currency.getAll": "View exchange rates",
  "currency.update": "Update currency rates",
  "currency.add": "Add new exchange rates",
  "currency.getRatesForDates": "View historical exchange rates",
  "exchangeRates.getAll": "View exchange rates",
  "exchangeRates.update": "Update currency rates",
  "exchangeRates.add": "Add new exchange rates",
  "exchangeRates.getRatesForDates": "View historical exchange rates",

  // SpendingAPI functions
  "spending.isEnabled": "Check whether Spending is enabled",
  "spending.getCategories": "View your spend categories",
  "spending.getReport": "View aggregate spending reports",
  "spending.getRules": "View its own auto-categorization rules",
  "spending.saveRule": "Create or update auto-categorization rules",
  "spending.deleteRule": "Delete auto-categorization rules",
  "spending.rerunRules": "Re-apply categorization rules to your transactions",

  // ContributionLimitsAPI functions
  "contributionLimits.getAll": "View contribution limits",
  "contributionLimits.create": "Set contribution limits",
  "contributionLimits.update": "Modify contribution limits",
  "contributionLimits.calculateDeposits": "Calculate required deposits",

  // GoalsAPI functions
  "financial-planning.getAll": "View financial goals",
  "financial-planning.create": "Create new goals",
  "financial-planning.update": "Modify goals",
  "financial-planning.getFunding": "View goal funding",
  "financial-planning.saveFunding": "Update goal funding",
  "financial-planning.updateAllocations": "Update goal allocations",
  "financial-planning.getAllocations": "View goal allocations",

  // SettingsAPI functions
  "settings.get": "View app settings",
  "settings.update": "Modify app settings",
  "settings.backupDatabase": "Create data backup",

  // FilesAPI functions
  "files.openCsvDialog": "Open file picker for CSV",
  "files.openSaveDialog": "Save files to disk",

  // SecretsAPI functions
  "secrets.get": "Retrieve stored credentials",
  "secrets.set": "Store secure credentials",
  "secrets.use": "Use stored credentials for brokered requests",
  "secrets.delete": "Remove stored credentials",

  // SnapshotsAPI functions
  "snapshots.getAll": "View holdings snapshots",
  "snapshots.getByDate": "View holdings on a snapshot date",
  "snapshots.save": "Save holdings snapshots",
  "snapshots.checkImport": "Validate snapshot import data",
  "snapshots.importSnapshots": "Import holdings snapshots",
  "snapshots.delete": "Delete holdings snapshots",

  // EventsAPI functions - Import events
  "events.onDropHover": "Detect file drag-and-drop",
  "events.onDrop": "Handle file drops",
  "events.onDropCancelled": "Handle cancelled drops",

  // EventsAPI functions - Portfolio events
  "events.onUpdateStart": "Monitor portfolio update start",
  "events.onUpdateComplete": "Monitor portfolio update completion",
  "events.onUpdateError": "Monitor portfolio update errors",

  // EventsAPI functions - Market events
  "events.onSyncStart": "Monitor market sync start",
  "events.onSyncComplete": "Monitor market sync completion",

  // Network broker
  "network.request": "Send brokered network requests",
};

/**
 * Get user-friendly display name for a function within its category context
 * @param category The permission category (e.g., 'accounts', 'portfolio', 'events')
 * @param functionName The function name (e.g., 'getAll', 'create', 'onDrop')
 * @returns User-friendly description or the original function name if no mapping exists
 */
export function getFunctionDisplayName(
  category: string,
  functionName: string,
  t?: TFunction,
): string {
  const displayCategory =
    category === "market-data"
      ? "market"
      : category === "contribution-limits"
        ? "contributionLimits"
        : category;
  const key = `${displayCategory}.${functionName}`;
  const label = FUNCTION_DISPLAY_NAMES[key];
  return label && t
    ? t(`settings:addonPermissions.functions.${key.replaceAll(".", "_")}`, { defaultValue: label })
    : label || functionName;
}

/**
 * Check if a function has a user-friendly display name
 * @param category The permission category
 * @param functionName The function name
 */
export function hasFunctionDisplayName(category: string, functionName: string): boolean {
  const key = `${category}.${functionName}`;
  return key in FUNCTION_DISPLAY_NAMES;
}

/**
 * Get all mapped function keys in category.function format
 */
export function getMappedFunctionKeys(): string[] {
  return Object.keys(FUNCTION_DISPLAY_NAMES);
}
