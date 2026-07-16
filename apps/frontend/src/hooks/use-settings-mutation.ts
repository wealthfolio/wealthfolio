import { logger, updateSettings } from "@/adapters";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { QueryKeys } from "@/lib/query-keys";
import { invalidatePerformanceCaches } from "@/lib/performance-cache";
import { Settings } from "@/lib/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export function useSettingsMutation(
  setSettings: React.Dispatch<React.SetStateAction<Settings | null>>,
  applySettingsToDocument: (newSettings: Settings) => void,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateSettings,
    onSuccess: (updatedSettings, variables) => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.SETTINGS] });
      if (
        "baseCurrency" in variables ||
        "defaultReturnMetric" in variables ||
        "timezone" in variables
      ) {
        invalidatePerformanceCaches(queryClient);
      }
      setSettings(updatedSettings);
      applySettingsToDocument(updatedSettings);
      // Don't show toast during onboarding
      const isOnboarding =
        "onboardingCompleted" in variables || !updatedSettings.onboardingCompleted;
      if (!isOnboarding) {
        toast({
          title: "Settings updated",
          description: "Your settings have been updated successfully.",
          variant: "success",
          duration: 1000,
        });
      }
    },
    onError: (error) => {
      logger.error(`Error updating settings: ${error}`);
      toast({
        title: "Uh oh! Something went wrong.",
        description: "There was a problem updating your settings.",
        variant: "destructive",
      });
    },
  });
}
