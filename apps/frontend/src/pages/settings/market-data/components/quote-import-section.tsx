import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { useQuoteImport } from "@/hooks/use-quote-import";
import type { QuoteImportActions, QuoteImportState } from "@/lib/types/quote-import";
import { cn } from "@/lib/utils";
import { StepIndicator } from "@/pages/activity/import/components/step-indicator";
import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card, CardContent, CardHeader } from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { QuoteImportForm } from "./quote-import-form";
import { QuoteImportHelpPopover } from "./quote-import-help-popover";
import { QuoteImportProgress } from "./quote-import-progress";
import { QuotePreviewTable } from "./quote-preview-table";

interface ImportQuotesSectionProps {
  showTitle?: boolean;
  /** When provided externally, uses these instead of internal hook */
  quoteImport?: QuoteImportState & QuoteImportActions;
  currentStep?: number;
  onStepChange?: (step: number) => void;
}

export function ImportQuotesSection({
  showTitle = true,
  quoteImport: externalQuoteImport,
  currentStep: externalCurrentStep,
  onStepChange,
}: ImportQuotesSectionProps) {
  const { t } = useTranslation();
  // Define the steps in the wizard
  const STEPS = useMemo(
    () => [
      { id: 1, title: t("settings:market_data_page.step_upload_validate") },
      { id: 2, title: t("settings:market_data_page.step_preview_data") },
      { id: 3, title: t("settings:market_data_page.step_import_results") },
    ],
    [t],
  );
  // Use internal hook if not provided externally
  const internalQuoteImport = useQuoteImport();
  const quoteImport = externalQuoteImport ?? internalQuoteImport;

  const {
    file,
    preview,
    isValidating,
    isImporting,
    importProgress,
    error,
    setFile,
    validateFile,
    importQuotes,
    reset,
  } = quoteImport;

  const [internalCurrentStep, setInternalCurrentStep] = useState(1);
  const currentStep = externalCurrentStep ?? internalCurrentStep;
  const setCurrentStep = onStepChange ?? setInternalCurrentStep;

  // Automatically switch to preview step when preview is created (only for internal state)
  useEffect(() => {
    if (!externalQuoteImport && preview && currentStep === 1) {
      setCurrentStep(2);
    }
  }, [externalQuoteImport, preview, currentStep, setCurrentStep]);

  const handleImportComplete = () => {
    setCurrentStep(3);
  };

  const handleStartOver = () => {
    reset();
    setCurrentStep(1);
  };

  // Render the current step
  const renderStep = () => {
    switch (currentStep) {
      case 1:
        return (
          <QuoteImportForm
            file={file}
            isValidating={isValidating}
            error={error}
            onFileSelect={setFile}
            onValidate={validateFile}
          />
        );
      case 2:
        return (
          preview && (
            <div className="space-y-4">
              <QuotePreviewTable quotes={preview.sampleQuotes} />

              {error && (
                <Alert variant="destructive">
                  <Icons.AlertCircle className="h-4 w-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Card>
                <CardContent className="py-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-6 text-sm">
                      <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground">{t("common:total")}:</span>
                        <span className="font-semibold">{preview.totalRows}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground">
                          {t("settings:market_data_page.field_valid")}:
                        </span>
                        <span className="font-semibold text-green-600">{preview.validRows}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-muted-foreground">
                          {t("settings:market_data_page.field_invalid")}:
                        </span>
                        <span className="font-semibold text-red-600">{preview.invalidRows}</span>
                      </div>
                      {preview.duplicateCount > 0 && (
                        <div className="flex items-center gap-1.5">
                          <span className="text-muted-foreground">
                            {t("settings:market_data_page.field_duplicates")}:
                          </span>
                          <span className="font-semibold text-yellow-600">
                            {preview.duplicateCount}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <Button variant="outline" onClick={handleStartOver}>
                        <Icons.ArrowLeft className="mr-2 h-4 w-4" />
                        {t("common:back")}
                      </Button>
                      <Button
                        onClick={async () => {
                          const success = await importQuotes();
                          if (success) {
                            handleImportComplete();
                          }
                        }}
                        disabled={preview.validRows === 0 || isImporting}
                      >
                        <Icons.Import className="mr-2 h-4 w-4" />
                        {t("settings:market_data_page.import_quotes_count", {
                          count: preview.validRows,
                        })}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )
        );
      case 3:
        return (
          <QuoteImportProgress
            isImporting={isImporting}
            progress={importProgress}
            totalRows={preview?.totalRows ?? 0}
            successfulRows={preview?.validRows ?? 0}
            failedRows={preview?.invalidRows ?? 0}
          />
        );
      default:
        return null;
    }
  };

  // When state is managed externally, don't render the header buttons
  const showHeaderButtons = !externalQuoteImport;

  return (
    <div className="space-y-6">
      {(showTitle || showHeaderButtons) && (
        <div
          className={cn("flex items-center justify-between", showTitle ? undefined : "justify-end")}
        >
          {showTitle && (
            <div>
              <h3 className="text-lg font-semibold">
                {t("settings:market_data_page.import_page_heading")}
              </h3>
              <p className="text-muted-foreground text-sm">
                {t("settings:market_data_page.import_intro")}
              </p>
            </div>
          )}
          {showHeaderButtons && (
            <div className="flex items-center gap-2">
              <QuoteImportHelpPopover />
              <Button variant="outline" size="sm" onClick={handleStartOver}>
                <Icons.Refresh className="mr-2 h-4 w-4" />
                {t("settings:market_data_page.start_over")}
              </Button>
            </div>
          )}
        </div>
      )}

      {showTitle && <Separator />}

      <Card className="w-full">
        <CardHeader className="border-b">
          <StepIndicator steps={STEPS} currentStep={currentStep} />
        </CardHeader>
        <CardContent className="overflow-hidden p-0">
          <AnimatePresence mode="wait">
            <motion.div
              key={currentStep}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.3 }}
              className="p-4 sm:p-6"
            >
              {renderStep()}
            </motion.div>
          </AnimatePresence>
        </CardContent>
      </Card>
    </div>
  );
}
