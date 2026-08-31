import type { AccountScope } from "@/lib/types";
import { create } from "zustand";

interface AccountScopeState {
  scope: AccountScope;
  setScope: (scope: AccountScope) => void;
  /** `accountScopeKey` of the scope last applied to the performance tracked list. */
  bridgedScopeKey: string;
  /** Item id the bridge inserted, or null when it adopted an existing item. */
  bridgedItemId: string | null;
  setBridged: (bridgedScopeKey: string, bridgedItemId: string | null) => void;
}

/**
 * Session-scoped account/portfolio selection shared by insights, holdings and
 * income. Deliberately not persisted: the selection resets on relaunch.
 */
export const useAccountScopeStore = create<AccountScopeState>()((set) => ({
  scope: { type: "all" },
  setScope: (scope) => set({ scope }),
  // Seeded with the default scope's key so a fresh session never rewrites the
  // performance tracked list before the user picks a scope.
  bridgedScopeKey: "all",
  bridgedItemId: null,
  setBridged: (bridgedScopeKey, bridgedItemId) => set({ bridgedScopeKey, bridgedItemId }),
}));
