import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { useI18n } from "@/i18n/i18n-provider";
import { usePlatform } from "@/hooks/use-platform";
import { SettingsHeader } from "../settings-header";
import { AutoUpdateSettings } from "./auto-update-settings";
import { BaseCurrencySettings } from "./currency-settings";
import { ExchangeRatesSettings } from "./exchange-rates/exchange-rates-settings";
import { LanguageSettings } from "./language-settings";
import { TimezoneSettings } from "./timezone-settings";

export default function GeneralSettingsPage() {
  const { isMobile } = usePlatform();
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      <SettingsHeader
        heading={t("settings.general.heading")}
        text={t("settings.general.description")}
      />
      <Separator />
      <BaseCurrencySettings />
      <LanguageSettings />
      <TimezoneSettings />
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
