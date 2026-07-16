import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { useTranslation } from "react-i18next";
import { usePlatform } from "@/hooks/use-platform";
import { SettingsHeader } from "../settings-header";
import { AutoUpdateSettings } from "./auto-update-settings";
import { BaseCurrencySettings } from "./currency-settings";
import { ExchangeRatesSettings } from "./exchange-rates/exchange-rates-settings";
import { LanguageRegionSettings } from "./language-region-settings";

export default function GeneralSettingsPage() {
  const { t } = useTranslation();
  const { isMobile } = usePlatform();

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
      {!isMobile && (
        <div className="pt-6">
          <AutoUpdateSettings />
        </div>
      )}
    </div>
  );
}
