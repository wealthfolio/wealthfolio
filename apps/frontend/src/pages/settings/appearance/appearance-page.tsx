import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { useTranslation } from "react-i18next";
import { SettingsHeader } from "../settings-header";
import { AppearanceForm } from "./appearance-form";

export default function SettingsAppearancePage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <SettingsHeader
        heading={t("settings:appearance")}
        text={t("settings:appearance_description")}
      />
      <Separator />
      <AppearanceForm />
    </div>
  );
}
