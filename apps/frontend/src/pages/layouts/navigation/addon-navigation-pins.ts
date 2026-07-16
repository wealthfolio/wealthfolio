import { usePersistentState } from "@/hooks/use-persistent-state";
import { useCallback, useMemo } from "react";

export interface AddonNavPinItem {
  id?: string;
  href: string;
}

export const PINNED_ADDON_NAV_STORAGE_KEY = "wealthfolio:pinned-addon-nav-items";
export const PINNED_ADDON_NAV_CONFIGURED_STORAGE_KEY =
  "wealthfolio:pinned-addon-nav-items-configured";

export function getAddonNavPinKey(item: AddonNavPinItem) {
  return item.id ?? item.href;
}

export function useAddonNavigationPins() {
  const [pinnedAddonIds, setPinnedAddonIds] = usePersistentState<string[]>(
    PINNED_ADDON_NAV_STORAGE_KEY,
    [],
  );
  const [hasConfiguredAddonPins, setHasConfiguredAddonPins] = usePersistentState<boolean>(
    PINNED_ADDON_NAV_CONFIGURED_STORAGE_KEY,
    false,
  );

  const pinnedAddonIdSet = useMemo(() => new Set(pinnedAddonIds), [pinnedAddonIds]);

  const isAddonPinned = useCallback(
    (item: AddonNavPinItem) => pinnedAddonIdSet.has(getAddonNavPinKey(item)),
    [pinnedAddonIdSet],
  );

  const setAddonPinned = useCallback(
    (item: AddonNavPinItem, pinned: boolean) => {
      const itemId = getAddonNavPinKey(item);
      setHasConfiguredAddonPins(true);

      setPinnedAddonIds((currentIds) => {
        const isPinned = currentIds.includes(itemId);

        if (pinned) {
          return isPinned ? currentIds : [...currentIds, itemId];
        }

        return isPinned ? currentIds.filter((id) => id !== itemId) : currentIds;
      });
    },
    [setHasConfiguredAddonPins, setPinnedAddonIds],
  );

  return {
    hasConfiguredAddonPins,
    isAddonPinned,
    pinnedAddonIds,
    pinnedAddonIdSet,
    setAddonPinned,
    setPinnedAddonIds,
  };
}
