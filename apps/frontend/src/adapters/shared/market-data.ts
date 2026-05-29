// Market Data Commands
import type {
  SymbolSearchResult,
  Asset,
  Quote,
  LatestQuoteSnapshot,
  NewAsset,
  UpdateAssetProfile,
  MarketDataProviderInfo,
  ExchangeInfo,
  ResolvedQuote,
} from "@/lib/types";
import type { QuoteImport } from "@/lib/types/quote-import";
import type { MarketDataProviderSetting } from "../types";

import { invoke, logger } from "./platform";

export const searchTicker = async (query: string): Promise<SymbolSearchResult[]> => {
  try {
    return await invoke<SymbolSearchResult[]>("search_symbol", { query });
  } catch (error) {
    logger.error("Error searching for ticker.");
    throw error;
  }
};

export const syncHistoryQuotes = async (): Promise<void> => {
  try {
    await invoke<void>("synch_quotes");
  } catch (error) {
    logger.error("Error syncing history quotes.");
    throw error;
  }
};

export const getAssetProfile = async (assetId: string): Promise<Asset> => {
  try {
    return await invoke<Asset>("get_asset_profile", { assetId });
  } catch (error) {
    logger.error("Error loading asset data.");
    throw error;
  }
};

export const getAssets = async (): Promise<Asset[]> => {
  try {
    return await invoke<Asset[]>("get_assets");
  } catch (error) {
    logger.error("Error loading assets.");
    throw error;
  }
};

export const getLatestQuotes = async (
  assetIds: string[],
): Promise<Record<string, LatestQuoteSnapshot>> => {
  try {
    return await invoke<Record<string, LatestQuoteSnapshot>>("get_latest_quotes", { assetIds });
  } catch (error) {
    logger.error("Error loading latest quotes.");
    throw error;
  }
};

export const updateAssetProfile = async (payload: UpdateAssetProfile): Promise<Asset> => {
  try {
    return await invoke<Asset>("update_asset_profile", { id: payload.id, payload });
  } catch (error) {
    logger.error("Error updating asset profile.");
    throw error;
  }
};

export const createAsset = async (payload: NewAsset): Promise<Asset> => {
  try {
    return await invoke<Asset>("create_asset", { payload });
  } catch (error) {
    logger.error("Error creating asset.");
    throw error;
  }
};

export const deleteAsset = async (id: string): Promise<void> => {
  try {
    await invoke<void>("delete_asset", { id });
  } catch (error) {
    logger.error("Error deleting asset.");
    throw error;
  }
};

export const updateQuoteMode = async (assetId: string, quoteMode: string): Promise<Asset> => {
  try {
    return await invoke<Asset>("update_quote_mode", { id: assetId, quoteMode });
  } catch (error) {
    logger.error("Error updating asset quote mode.");
    throw error;
  }
};

export const updateQuote = async (symbol: string, quote: Quote): Promise<void> => {
  try {
    return await invoke<void>("update_quote", { symbol, quote });
  } catch (error) {
    logger.error("Error updating quote");
    throw error;
  }
};

export const syncMarketData = async (
  assetIds: string[],
  refetchAll: boolean,
  refetchRecentDays?: number,
): Promise<void> => {
  try {
    await invoke<void>("sync_market_data", { assetIds, refetchAll, refetchRecentDays });
  } catch (error) {
    logger.error(`Error refreshing quotes for assets: ${String(error)}`);
    throw error;
  }
};

export const deleteQuote = async (id: string): Promise<void> => {
  try {
    return await invoke<void>("delete_quote", { id });
  } catch (error) {
    logger.error("Error deleting quote");
    throw error;
  }
};

export const getQuoteHistory = async (symbol: string): Promise<Quote[]> => {
  try {
    return await invoke<Quote[]>("get_quote_history", { symbol });
  } catch (error) {
    logger.error(`Error fetching quote history for symbol ${symbol}.`);
    throw error;
  }
};

export const getMarketDataProviders = async (): Promise<MarketDataProviderInfo[]> => {
  try {
    return await invoke<MarketDataProviderInfo[]>("get_market_data_providers");
  } catch (error) {
    logger.error("Error fetching market data providers.");
    throw error;
  }
};

export const getMarketDataProviderSettings = async (): Promise<MarketDataProviderSetting[]> => {
  try {
    return await invoke<MarketDataProviderSetting[]>("get_market_data_providers_settings");
  } catch (error) {
    logger.error("Error fetching market data provider settings.");
    throw error;
  }
};

export const updateMarketDataProviderSettings = async (payload: {
  providerId: string;
  priority: number;
  enabled: boolean;
}): Promise<MarketDataProviderSetting> => {
  try {
    return await invoke<MarketDataProviderSetting>("update_market_data_provider_settings", payload);
  } catch (error) {
    logger.error("Error updating market data provider settings.");
    throw error;
  }
};

export const checkQuotesImport = async (
  file: File,
  hasHeaderRow = true,
): Promise<QuoteImport[]> => {
  try {
    const buffer = await file.arrayBuffer();
    const content = Array.from(new Uint8Array(buffer));
    return await invoke<QuoteImport[]>("check_quotes_import", { content, hasHeaderRow });
  } catch (error) {
    logger.error("Error checking quotes import.");
    throw error;
  }
};

export const resolveSymbolQuote = async (
  symbol: string,
  exchangeMic?: string,
  instrumentType?: string,
  providerId?: string,
  quoteCcy?: string,
): Promise<ResolvedQuote | null> => {
  try {
    return await invoke<ResolvedQuote>("resolve_symbol_quote", {
      symbol,
      exchangeMic,
      instrumentType,
      providerId,
      quoteCcy,
    });
  } catch (_error) {
    logger.error("Error resolving symbol quote.");
    return null;
  }
};

export const getExchanges = async (): Promise<ExchangeInfo[]> => {
  try {
    return await invoke<ExchangeInfo[]>("get_exchanges");
  } catch (error) {
    logger.error("Error fetching exchanges.");
    throw error;
  }
};

export interface FetchDividendsOptions {
  exchangeMic?: string;
  instrumentType?: string;
  quoteCcy?: string;
  providerId?: string;
  startDate?: string;
  endDate?: string;
}

export const fetchDividends = async (
  symbol: string,
  options: FetchDividendsOptions = {},
): Promise<{ amount: number; date: number }[]> => {
  try {
    return await invoke<{ amount: number; date: number }[]>("fetch_dividends", {
      symbol,
      ...options,
    });
  } catch (error) {
    logger.error(`Error fetching dividends for ${symbol}.`);
    throw error;
  }
};

export const importManualQuotes = async (quotes: QuoteImport[]): Promise<QuoteImport[]> => {
  try {
    // Internal transformation: hardcode overwriteExisting flag
    const overwriteExisting = true;
    return await invoke<QuoteImport[]>("import_quotes_csv", { quotes, overwriteExisting });
  } catch (error) {
    logger.error("Error importing manual quotes.");
    throw error;
  }
};
