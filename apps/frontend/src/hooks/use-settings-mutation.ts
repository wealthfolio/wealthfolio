import { logger, updateSettings } from "@/adapters";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { QueryKeys } from "@/lib/query-keys";
import { invalidatePerformanceCaches } from "@/lib/performance-cache";
import { Settings } from "@/lib/types";
import { normalizeLanguage } from "@/i18n/languages";
import { getMessage, type TranslationKey } from "@/i18n/messages";
import { useMutation, useQueryClient } from "@tanstack/react-query";

function settingsMessage(languageValue: unknown, key: TranslationKey): string {
  return getMessage(normalizeLanguage(languageValue), key);
}

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
          title: settingsMessage(updatedSettings.language, "settings.toast.successTitle"),
          description: settingsMessage(
            updatedSettings.language,
            "settings.toast.successDescription",
          ),
          variant: "success",
          duration: 1000,
        });
      }
    },
    onError: (error, variables) => {
      logger.error(`Error updating settings: ${error}`);
      toast({
        title: settingsMessage(variables?.language, "settings.toast.errorTitle"),
        description: settingsMessage(variables?.language, "settings.toast.errorDescription"),
        variant: "destructive",
      });
    },
  });
}
