import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { useTranslation } from "react-i18next";
import { usePlatform } from "@/hooks/use-platform";
import { useExternalUpdateSource } from "@/hooks/use-updater";
import { SettingsHeader } from "../settings-header";
import { AutoUpdateSettings } from "./auto-update-settings";
import { BaseCurrencySettings } from "./currency-settings";
import { DatabaseEncryptionSettings } from "./database-encryption-settings";
import { ExchangeRatesSettings } from "./exchange-rates/exchange-rates-settings";
import { LanguageRegionSettings } from "./language-region-settings";

export default function GeneralSettingsPage() {
  const { t } = useTranslation();
  const { isMobile } = usePlatform();
  // The toggle has no effect when a package manager handles updates.
  const { data: externalUpdateSource } = useExternalUpdateSource();

  return (
    <div className="space-y-6">
      <SettingsHeader
        heading={t("settings:general")}
        text={t("settings:general_page_description")}
      />
      <Separator />
      <BaseCurrencySettings />
      <LanguageRegionSettings />
      <div className="pt-6">
        <ExchangeRatesSettings />
      </div>
      <div className="pt-6">
        <DatabaseEncryptionSettings />
      </div>
      {!isMobile && externalUpdateSource === null && (
        <div className="pt-6">
          <AutoUpdateSettings />
        </div>
      )}
    </div>
  );
}
