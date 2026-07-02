import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { useI18n } from "@/i18n/i18n-provider";
import { SettingsHeader } from "../settings-header";
import { AppearanceForm } from "./appearance-form";

export default function SettingsAppearancePage() {
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      <SettingsHeader
        heading={t("settings.appearance.heading")}
        text={t("settings.appearance.description")}
      />
      <Separator />
      <AppearanceForm />
    </div>
  );
}
