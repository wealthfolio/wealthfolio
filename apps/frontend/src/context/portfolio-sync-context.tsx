import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

export type SyncStatus = "idle" | "enriching-assets" | "syncing-market" | "calculating-portfolio";

interface PortfolioSyncContextType {
  status: SyncStatus;
  message: string;
  setEnrichingAssets: () => void;
  setMarketSyncing: () => void;
  setPortfolioCalculating: () => void;
  setIdle: () => void;
}

const PortfolioSyncContext = createContext<PortfolioSyncContextType | undefined>(undefined);

const STATUS_MESSAGE_KEYS: Record<Exclude<SyncStatus, "idle">, string> = {
  "enriching-assets": "common:globalEvents.fetchingAssetMetadata",
  "syncing-market": "common:globalEvents.syncingMarket",
  "calculating-portfolio": "common:globalEvents.calculatingPortfolio",
};

export function PortfolioSyncProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<SyncStatus>("idle");

  const setEnrichingAssets = useCallback(() => {
    setStatus("enriching-assets");
  }, []);

  const setMarketSyncing = useCallback(() => {
    setStatus("syncing-market");
  }, []);

  const setPortfolioCalculating = useCallback(() => {
    setStatus("calculating-portfolio");
  }, []);

  const setIdle = useCallback(() => {
    setStatus("idle");
  }, []);

  const value = useMemo<PortfolioSyncContextType>(
    () => ({
      status,
      message: status === "idle" ? "" : t(STATUS_MESSAGE_KEYS[status]),
      setEnrichingAssets,
      setMarketSyncing,
      setPortfolioCalculating,
      setIdle,
    }),
    [status, t, setEnrichingAssets, setMarketSyncing, setPortfolioCalculating, setIdle],
  );

  return <PortfolioSyncContext.Provider value={value}>{children}</PortfolioSyncContext.Provider>;
}

export function usePortfolioSync() {
  const context = useContext(PortfolioSyncContext);
  if (!context) {
    throw new Error("usePortfolioSync must be used within a PortfolioSyncProvider");
  }
  return context;
}

// Optional hook that returns null if used outside provider (for places where provider might not exist)
export function usePortfolioSyncOptional() {
  return useContext(PortfolioSyncContext);
}
