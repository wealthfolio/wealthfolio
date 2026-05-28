import { useSettingsContext } from "@/lib/settings-provider";

export function usePrivateAssetsFeatureFlag() {
  const { isError, isLoading, settings } = useSettingsContext();

  return {
    enabled: settings?.privateAssetsEnabled ?? false,
    isPending: isLoading || (!isError && !settings),
  };
}

export function usePrivateAssetsEnabled() {
  return usePrivateAssetsFeatureFlag().enabled;
}
