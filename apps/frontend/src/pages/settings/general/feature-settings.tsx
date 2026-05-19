import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import { useQueryClient } from "@tanstack/react-query";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";

export function FeatureSettings() {
  const { settings, updateSettings } = useSettingsContext();
  const queryClient = useQueryClient();

  if (!settings) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Features</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="private-assets-enabled" className="text-base">
              Private assets
            </Label>
            <p className="text-muted-foreground text-xs">
              Enable manual private-asset tracking, portfolio totals, and AI access for private
              investments.
            </p>
          </div>
          <Switch
            id="private-assets-enabled"
            checked={settings.privateAssetsEnabled}
            onCheckedChange={async (privateAssetsEnabled) => {
              await updateSettings({ privateAssetsEnabled });
              queryClient.invalidateQueries({ queryKey: [QueryKeys.NET_WORTH] });
              queryClient.invalidateQueries({ queryKey: [QueryKeys.NET_WORTH_HISTORY] });
              queryClient.invalidateQueries({ queryKey: [QueryKeys.HOLDINGS] });
              queryClient.invalidateQueries({ queryKey: [QueryKeys.PRIVATE_ASSET_ROWS] });
              queryClient.invalidateQueries({ queryKey: [QueryKeys.PRIVATE_ASSET_TOTALS] });
              queryClient.invalidateQueries({ queryKey: [QueryKeys.PRIVATE_ASSET_HISTORY] });
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
