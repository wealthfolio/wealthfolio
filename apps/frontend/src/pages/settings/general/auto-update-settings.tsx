import { updateSettings } from "@/adapters";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { QueryKeys } from "@/lib/query-keys";
import { useI18n } from "@/i18n/i18n-provider";
import { useSettingsContext } from "@/lib/settings-provider";
import { useMutation, useQueryClient } from "@tanstack/react-query";

export function AutoUpdateSettings() {
  const { settings } = useSettingsContext();
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const updateSettingsMutation = useMutation({
    mutationFn: updateSettings,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [QueryKeys.SETTINGS] });
    },
    onError: (error) => {
      toast({
        title: t("settings.autoUpdate.errorTitle"),
        description: t("settings.autoUpdate.errorDescription"),
        variant: "destructive",
      });
      console.error("Failed to update settings:", error);
    },
  });

  const handleAutoUpdateToggle = (enabled: boolean) => {
    if (!settings) return;

    updateSettingsMutation.mutate({
      ...settings,
      autoUpdateCheckEnabled: enabled,
    });
  };

  if (!settings) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t("settings.autoUpdate.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="auto-update-check" className="text-base">
              {t("settings.autoUpdate.label")}
            </Label>
            <p className="text-muted-foreground text-xs">{t("settings.autoUpdate.description")}</p>
          </div>
          <Switch
            id="auto-update-check"
            checked={settings.autoUpdateCheckEnabled}
            onCheckedChange={handleAutoUpdateToggle}
            disabled={updateSettingsMutation.isPending}
          />
        </div>
      </CardContent>
    </Card>
  );
}
