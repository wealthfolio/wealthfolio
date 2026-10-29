import type { ActivityDetails } from "@/lib/types";
import { generateId } from "@/lib/id";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangesSummary, LocalTransaction, TransactionChangeState } from "./types";
import { toLocalTransaction } from "./types";

/**
 * Generates a unique temporary ID for new transactions
 */
export const generateTempActivityId = (): string => {
  return generateId("temp");
};

/**
 * Checks if an ID represents a temporary (unsaved) transaction
 */
export const isTempId = (id: string): boolean => {
  return id.startsWith("temp-");
};

interface UseActivityGridStateOptions {
  activities: ActivityDetails[];
}

interface UseActivityGridStateReturn<TRow extends LocalTransaction> {
  /** Server-provided transactions normalized with IDs */
  serverTransactions: TRow[];
  /** Local state of transactions including drafts and modifications */
  localTransactions: TRow[];
  /** Update local transactions state */
  setLocalTransactions: React.Dispatch<React.SetStateAction<TRow[]>>;
  /** Set of IDs for transactions that have been modified */
  dirtyTransactionIds: Set<string>;
  /** Update dirty transaction IDs */
  setDirtyTransactionIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** Set of IDs for transactions pending deletion */
  pendingDeleteIds: Set<string>;
  /** Update pending delete IDs */
  setPendingDeleteIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  /** Whether there are any unsaved changes */
  hasUnsavedChanges: boolean;
  /** Summary of changes for UI display */
  changesSummary: ChangesSummary;
  /** Mark a transaction as dirty (modified) */
  markDirty: (id: string) => void;
  /** Mark multiple transactions as dirty */
  markDirtyBatch: (ids: string[]) => void;
  /** Mark a transaction for deletion */
  markForDeletion: (id: string, isNew: boolean) => void;
  /** Mark multiple transactions for deletion */
  markForDeletionBatch: (transactions: { id: string; isNew: boolean }[]) => void;
  /** Clear a transaction from dirty state */
  clearDirty: (id: string) => void;
  /** Reset all change tracking state */
  resetChangeState: () => void;
  /** Get current change state snapshot */
  getChangeState: () => TransactionChangeState;
}

/**
 * Hook to manage activity grid state with optimistic updates
 * Provides reliable change tracking for creates, updates, and deletes.
 * Rows passed in already shaped as `TRow` (a LocalTransaction) are kept as they are.
 */
export const useActivityGridState = <TRow extends LocalTransaction = LocalTransaction>({
  activities,
}: UseActivityGridStateOptions): UseActivityGridStateReturn<TRow> => {
  // Normalize server transactions to ensure all have valid IDs and extract derived fields
  const serverTransactions = useMemo(
    () =>
      activities.map((activity) => {
        const trimmedId = typeof activity.id === "string" ? activity.id.trim() : "";
        const activityWithId =
          trimmedId.length > 0 ? activity : { ...activity, id: generateTempActivityId() };
        // Convert to LocalTransaction to extract derived fields like isExternal from metadata
        return toLocalTransaction(activityWithId) as TRow;
      }),
    [activities],
  );

  // Local state for transactions displayed in the grid
  const [localTransactions, setLocalTransactions] = useState<TRow[]>(serverTransactions);

  // Track modified transaction IDs
  const [dirtyTransactionIds, setDirtyTransactionIds] = useState<Set<string>>(new Set());

  // Track transactions pending deletion
  const [pendingDeleteIds, setPendingDeleteIds] = useState<Set<string>>(new Set());

  // Ref to access current dirty state without stale closures
  const dirtyTransactionIdsRef = useRef(dirtyTransactionIds);
  useEffect(() => {
    dirtyTransactionIdsRef.current = dirtyTransactionIds;
  }, [dirtyTransactionIds]);

  // Ref to track pending delete IDs without triggering effect re-runs
  const pendingDeleteIdsRef = useRef(pendingDeleteIds);
  useEffect(() => {
    pendingDeleteIdsRef.current = pendingDeleteIds;
  }, [pendingDeleteIds]);

  // Sync local state from server while preserving local changes
  // Uses refs to access current state without stale closures
  useEffect(() => {
    setLocalTransactions((currentLocal) => {
      const currentDirtyIds = dirtyTransactionIdsRef.current;
      const currentPendingDeleteIds = pendingDeleteIdsRef.current;

      // Check if there are any local changes that need preserving
      const hasNewTransactions = currentLocal.some((t) => t.isNew);
      const hasDirtyTransactions = currentDirtyIds.size > 0;
      const hasPendingDeletes = currentPendingDeleteIds.size > 0;

      // If no local changes, just use server data
      if (!hasNewTransactions && !hasDirtyTransactions && !hasPendingDeletes) {
        return serverTransactions;
      }

      // Merge: preserve local changes, update non-dirty items from server
      const merged: TRow[] = [];

      // First, add all local transactions that need preserving (dirty, new, or pending delete)
      const preservedIds = new Set<string>();
      for (const local of currentLocal) {
        if (local.isNew || currentDirtyIds.has(local.id)) {
          merged.push(local);
          preservedIds.add(local.id);
        }
      }

      // Then, add/update non-dirty items from server (excluding pending deletes)
      for (const server of serverTransactions) {
        if (currentPendingDeleteIds.has(server.id)) {
          // Skip - marked for deletion
          continue;
        }
        if (preservedIds.has(server.id)) {
          // Already preserved from local - skip
          continue;
        }
        // This is a non-dirty item - use server version
        merged.push(server);
      }

      return merged;
    });
  }, [serverTransactions]);

  // Mark a single transaction as dirty
  const markDirty = useCallback((id: string) => {
    setDirtyTransactionIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  // Mark multiple transactions as dirty
  const markDirtyBatch = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    setDirtyTransactionIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of ids) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  // Mark a transaction for deletion
  const markForDeletion = useCallback((id: string, isNew: boolean) => {
    // Remove from local transactions
    setLocalTransactions((prev) => prev.filter((t) => t.id !== id));

    // Remove from dirty set
    setDirtyTransactionIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });

    // Only add to pending deletes if it's an existing (persisted) transaction
    if (!isNew) {
      setPendingDeleteIds((prev) => {
        if (prev.has(id)) return prev;
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    }
  }, []);

  // Mark multiple transactions for deletion
  const markForDeletionBatch = useCallback((transactions: { id: string; isNew: boolean }[]) => {
    if (transactions.length === 0) return;

    const idsToDelete = new Set(transactions.map((t) => t.id));
    const existingIdsToDelete = transactions.filter((t) => !t.isNew).map((t) => t.id);

    // Remove from local transactions
    setLocalTransactions((prev) => prev.filter((t) => !idsToDelete.has(t.id)));

    // Remove from dirty set
    setDirtyTransactionIds((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const id of idsToDelete) {
        if (next.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });

    // Add existing transactions to pending deletes
    if (existingIdsToDelete.length > 0) {
      setPendingDeleteIds((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const id of existingIdsToDelete) {
          if (!next.has(id)) {
            next.add(id);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
  }, []);

  // Clear dirty state for a transaction
  const clearDirty = useCallback((id: string) => {
    setDirtyTransactionIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Reset all change tracking state
  const resetChangeState = useCallback(() => {
    setDirtyTransactionIds(new Set());
    setPendingDeleteIds(new Set());
  }, []);

  // Get current change state snapshot
  const getChangeState = useCallback((): TransactionChangeState => {
    return {
      dirtyIds: new Set(dirtyTransactionIds),
      pendingDeleteIds: new Set(pendingDeleteIds),
    };
  }, [dirtyTransactionIds, pendingDeleteIds]);

  // Calculate if there are unsaved changes
  const hasUnsavedChanges = useMemo(() => {
    return (
      dirtyTransactionIds.size > 0 ||
      pendingDeleteIds.size > 0 ||
      localTransactions.some((transaction) => transaction.isNew)
    );
  }, [dirtyTransactionIds.size, localTransactions, pendingDeleteIds.size]);

  // Calculate changes summary for UI
  const changesSummary = useMemo((): ChangesSummary => {
    const newCount = localTransactions.filter(
      (t) => t.isNew && dirtyTransactionIds.has(t.id),
    ).length;
    const updatedCount = localTransactions.filter(
      (t) => !t.isNew && dirtyTransactionIds.has(t.id),
    ).length;
    const deletedCount = pendingDeleteIds.size;

    return {
      newCount,
      updatedCount,
      deletedCount,
      totalPendingChanges: dirtyTransactionIds.size + pendingDeleteIds.size,
    };
  }, [localTransactions, dirtyTransactionIds, pendingDeleteIds.size]);

  return {
    serverTransactions,
    localTransactions,
    setLocalTransactions,
    dirtyTransactionIds,
    setDirtyTransactionIds,
    pendingDeleteIds,
    setPendingDeleteIds,
    hasUnsavedChanges,
    changesSummary,
    markDirty,
    markDirtyBatch,
    markForDeletion,
    markForDeletionBatch,
    clearDirty,
    resetChangeState,
    getChangeState,
  };
};
