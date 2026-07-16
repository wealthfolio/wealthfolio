import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Separator } from "@wealthfolio/ui/components/ui/separator";

import { useQuoteImport } from "@/hooks/use-quote-import";
import { ImportQuotesSection } from "@/pages/settings/market-data/components/quote-import-section";

import { SettingsHeader } from "../settings-header";
import { QuoteImportHelpPopover } from "./components/quote-import-help-popover";

export default function MarketDataImportPage() {
  const { t } = useTranslation();
  const quoteImport = useQuoteImport();
  const [currentStep, setCurrentStep] = useState(1);

  // Automatically switch to preview step when preview is created
  useEffect(() => {
    if (quoteImport.preview && currentStep === 1) {
      setCurrentStep(2);
    }
  }, [quoteImport.preview, currentStep]);

  const handleStartOver = () => {
    quoteImport.reset();
    setCurrentStep(1);
  };

  return (
    <div className="space-y-6">
      <SettingsHeader
        heading={t("settings:market_data_page.import_page_heading")}
        text={t("settings:market_data_page.import_page_subtitle")}
        backTo="/settings/market-data"
      >
        <div className="flex items-center gap-2">
          <QuoteImportHelpPopover />
          <Button variant="outline" size="sm" onClick={handleStartOver}>
            <Icons.Refresh className="mr-2 h-4 w-4" />
            {t("settings:market_data_page.start_over")}
          </Button>
        </div>
      </SettingsHeader>
      <Separator />
      <ImportQuotesSection
        showTitle={false}
        quoteImport={quoteImport}
        currentStep={currentStep}
        onStepChange={setCurrentStep}
      />
    </div>
  );
}
