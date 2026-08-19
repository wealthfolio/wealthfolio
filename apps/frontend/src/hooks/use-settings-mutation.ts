import { logger, updateSettings } from "@/adapters";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { QueryKeys } from "@/lib/query-keys";
import { invalidatePerformanceCaches } from "@/lib/performance-cache";
import { Settings } from "@/lib/types";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

export function useSettingsMutation(
  setSettings: React.Dispatch<React.SetStateAction<Settings | null>>,
  applySettingsToDocument: (newSettings: Settings) => void,
) {
  const queryClient = useQueryClient();
  const { t, i18n } = useTranslation();
  return useMutation({
    mutationFn: updateSettings,
    onSuccess: async (updatedSettings, variables) => {
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
        try {
          await i18n.loadLanguages(updatedSettings.language);
        } catch {
          // changeLanguage handles the configured fallback locale.
        }
        const translate = i18n.getFixedT(updatedSettings.language);
        toast({
          title: translate("settings:settings_updated_title"),
          description: translate("settings:settings_updated_description"),
          variant: "success",
          duration: 1000,
        });
      }
    },
    onError: (error) => {
      logger.error(`Error updating settings: ${error}`);
      toast({
        title: t("settings:settings_update_error_title"),
        description: t("settings:settings_update_error_description"),
        variant: "destructive",
      });
    },
  });
}
