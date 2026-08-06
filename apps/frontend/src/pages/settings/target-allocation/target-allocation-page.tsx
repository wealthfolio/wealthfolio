import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useSettingsContext } from "@/lib/settings-provider";
import { SettingsHeader } from "../settings-header";

export default function TargetAllocationSettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { settings, updateSettings } = useSettingsContext();
  const showOnDashboard = settings?.showTargetAllocationCard ?? true;

  function handleToggle(value: boolean) {
    updateSettings({ showTargetAllocationCard: value }).catch((error) => {
      console.error("Failed to update target allocation settings:", error);
    });
  }

  return (
    <div className="space-y-6">
      <SettingsHeader
        heading={t("settings:target_allocation_title")}
        text={t("settings:target_allocation_description")}
      />
      <Separator />
      <div className="max-w-4xl space-y-6">
        <div className="flex items-center justify-between rounded-lg border p-3 shadow-sm">
          <div className="space-y-0.5">
            <p className="text-base font-medium">{t("settings:target_allocation_show_label")}</p>
            <p className="text-muted-foreground text-sm">
              {t("settings:target_allocation_show_description")}
            </p>
          </div>
          <Switch checked={showOnDashboard} onCheckedChange={handleToggle} />
        </div>

        <div className="flex items-center justify-between rounded-lg border p-3 shadow-sm">
          <div className="space-y-0.5">
            <p className="text-base font-medium">{t("settings:target_allocation_manage_label")}</p>
            <p className="text-muted-foreground text-sm">
              {t("settings:target_allocation_manage_description")}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => navigate("/insights?tab=overview")}>
            {t("settings:target_allocation_manage_button")}
            <Icons.ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
