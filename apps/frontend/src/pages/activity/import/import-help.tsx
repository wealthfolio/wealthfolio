import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useTranslation } from "react-i18next";

import { Button } from "@wealthfolio/ui/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@wealthfolio/ui/components/ui/tabs";
import { usePlatform } from "@/hooks/use-platform";
import {
  ScrollArea,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@wealthfolio/ui";
import { downloadSampleCsv, downloadSampleHoldingsCsv } from "./utils/sample-csv";

// ─────────────────────────────────────────────────────────────────────────────
// Activities Help Content
// ─────────────────────────────────────────────────────────────────────────────

function ActivitiesHelpContent() {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <div>
          <h4 className="text-lg font-semibold">{t("activity:import.help.activitiesTitle")}</h4>
          <p className="text-muted-foreground mt-2 text-sm">
            {t("activity:import.help.activitiesIntro")}
          </p>
        </div>

        <div>
          <p className="font-semibold">{t("activity:import.help.stepsLabel")}</p>
          <ol className="mt-2 list-inside list-decimal space-y-1 text-sm">
            <li>
              <strong>{t("activity:import.help.activitiesStep1Bold")}</strong>
              {t("activity:import.help.activitiesStep1")}
            </li>
            <li>
              <strong>{t("activity:import.help.activitiesStep2Bold")}</strong>
              {t("activity:import.help.activitiesStep2")}
            </li>
            <li>
              <strong>{t("activity:import.help.activitiesStep3Bold")}</strong>
              {t("activity:import.help.activitiesStep3")}
            </li>
            <li>
              <strong>{t("activity:import.help.activitiesStep4Bold")}</strong>
              {t("activity:import.help.activitiesStep4")}
            </li>
            <li>
              <strong>{t("activity:import.help.activitiesStep5Bold")}</strong>
              {t("activity:import.help.activitiesStep5")}
            </li>
          </ol>
        </div>

        <div>
          <p className="text-sm font-semibold">{t("activity:import.help.requiredFields")}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("activity:import.help.activitiesRequiredFields")}
          </p>
          <p className="mt-2 text-sm font-semibold">{t("activity:import.help.optionalFields")}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("activity:import.help.activitiesOptionalFields")}
          </p>
        </div>

        <div className="space-y-3">
          <div className="border-blue-500 bg-blue-50 p-3 dark:bg-blue-900/50">
            <p className="text-sm">
              <strong className="text-blue-700 dark:text-blue-300">
                {t("activity:import.help.tipBold")}
              </strong>
              {t("activity:import.help.activitiesTip")}
            </p>
          </div>

          <div className="border-green-500 bg-green-50 p-3 dark:bg-green-900/50">
            <p className="text-sm">
              <strong className="text-green-700 dark:text-green-300">
                {t("activity:import.help.amountBold")}
              </strong>
              {t("activity:import.help.activitiesAmount")}
            </p>
          </div>

          <div className="border-purple-500 bg-purple-50 p-3 dark:bg-purple-900/50">
            <p className="text-sm">
              <strong className="text-purple-700 dark:text-purple-300">
                {t("activity:import.help.autoFormattingBold")}
              </strong>{" "}
              {t("activity:import.help.activitiesAutoFormatting")}
            </p>
          </div>
        </div>

        <p className="text-xs">
          {t("activity:import.help.activitiesDocsPrefix")}
          <a
            href="https://wealthfolio.app/docs/concepts/activity-types"
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            {t("activity:import.help.activitiesDocsLink")}
          </a>
          .
        </p>
      </div>

      <div className="space-y-4">
        <div>
          <p className="font-semibold">{t("activity:import.help.exampleFormat")}</p>
          <pre className="bg-muted mt-2 select-all overflow-x-auto p-3 text-xs leading-relaxed">
            <span className="text-muted-foreground">
              {t("activity:import.help.exampleStandard")}
            </span>
            <br />
            date,symbol,instrumentType,quantity,activityType,unitPrice,currency,fee,tax,amount,fxRate,subtype
            <br />
            2024-01-15,MSFT,EQUITY,10,BUY,380.50,USD,4.95,0,,,
            <br />
            2024-02-01,MSFT,EQUITY,1,DIVIDEND,0.75,USD,0,0.11,0.75,,QUALIFIED
            <br />
            2024-02-15,,,1,DEPOSIT,1,USD,0,0,1000.00,,
            <br />
            2024-06-01,TD.TO,EQUITY,10,BUY,85.00,CAD,9.99,0,,1.36,
            <br />
            <br />
            <span className="text-muted-foreground">
              {t("activity:import.help.exampleCurrencySymbols")}
            </span>
            <br />
            06/27/2025,AAPL,25,SELL,$48.95,USD,,$1223.63,,
            <br />
            06/20/2025,AAPL,8,BUY,$86.56,USD,,-$692.48,,
          </pre>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3 flex items-center gap-1.5"
            onClick={downloadSampleCsv}
          >
            <Icons.Download className="h-4 w-4" />
            {t("activity:import.help.downloadSample")}
          </Button>
        </div>

        <div>
          <p className="font-semibold">{t("activity:import.help.supportedActivityTypes")}</p>
          <pre className="bg-muted mt-2 overflow-x-auto p-4 text-xs">
            <ul className="list-inside list-disc space-y-1">
              <li>BUY</li>
              <li>SELL</li>
              <li>DIVIDEND</li>
              <li>INTEREST</li>
              <li>DEPOSIT</li>
              <li>WITHDRAWAL</li>
              <li>TRANSFER_IN (Moves cash/assets in)</li>
              <li>TRANSFER_OUT (Moves cash/assets out)</li>
              <li>FEE</li>
              <li>TAX</li>
              <li>SPLIT (Use Amount as the split ratio, e.g. 2 for 2:1)</li>
              <li>CREDIT (Cash credits: refunds, rebates, bonuses)</li>
              <li>ADJUSTMENT (Non-trade corrections)</li>
            </ul>
          </pre>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Holdings Help Content
// ─────────────────────────────────────────────────────────────────────────────

function HoldingsHelpContent() {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        <div>
          <h4 className="text-lg font-semibold">{t("activity:import.help.holdingsTitle")}</h4>
          <p className="text-muted-foreground mt-2 text-sm">
            {t("activity:import.help.holdingsIntro")}
          </p>
        </div>

        <div>
          <p className="font-semibold">{t("activity:import.help.stepsLabel")}</p>
          <ol className="mt-2 list-inside list-decimal space-y-1 text-sm">
            <li>{t("activity:import.help.holdingsStep1")}</li>
            <li>{t("activity:import.help.holdingsStep2")}</li>
            <li>
              {t("activity:import.help.holdingsStep3")}
              <span className="text-muted-foreground ml-2 text-xs">
                {t("activity:import.help.holdingsStep3Fields")}
              </span>
            </li>
            <li>{t("activity:import.help.holdingsStep4")}</li>
          </ol>
        </div>

        <div>
          <p className="font-semibold">{t("activity:import.help.requiredFields")}</p>
          <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
            <li>
              <strong>{t("activity:import.help.holdingsDateBold")}</strong>
              {t("activity:import.help.holdingsDateDesc")}
            </li>
            <li>
              <strong>{t("activity:import.help.holdingsSymbolBold")}</strong>
              {t("activity:import.help.holdingsSymbolDesc")}
            </li>
            <li>
              <strong>{t("activity:import.help.holdingsQuantityBold")}</strong>
              {t("activity:import.help.holdingsQuantityDesc")}
            </li>
          </ul>
          <p className="mt-3 font-semibold">{t("activity:import.help.optionalFields")}</p>
          <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
            <li>
              <strong>{t("activity:import.help.holdingsAvgCostBold")}</strong>
              {t("activity:import.help.holdingsAvgCostDesc")}
            </li>
            <li>
              <strong>{t("activity:import.help.holdingsCurrencyBold")}</strong>
              {t("activity:import.help.holdingsCurrencyDesc")}
            </li>
          </ul>
        </div>

        <div className="space-y-3">
          <div className="border-blue-500 bg-blue-50 p-3 dark:bg-blue-900/50">
            <p className="text-sm">
              <strong className="text-blue-700 dark:text-blue-300">
                {t("activity:import.help.tipBold")}
              </strong>
              {t("activity:import.help.holdingsTip")}
            </p>
          </div>

          <div className="border-green-500 bg-green-50 p-3 dark:bg-green-900/50">
            <p className="text-sm">
              <strong className="text-green-700 dark:text-green-300">
                {t("activity:import.help.cashBalancesBold")}
              </strong>{" "}
              {t("activity:import.help.holdingsCashBalancesUse")}{" "}
              <code className="bg-muted rounded px-1">$CASH</code>
              {t("activity:import.help.holdingsCashBalances")}
            </p>
          </div>

          <div className="border-purple-500 bg-purple-50 p-3 dark:bg-purple-900/50">
            <p className="text-sm">
              <strong className="text-purple-700 dark:text-purple-300">
                {t("activity:import.help.snapshotsBold")}
              </strong>
              {t("activity:import.help.holdingsSnapshots")}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div>
          <p className="font-semibold">{t("activity:import.help.exampleFormat")}</p>
          <pre className="bg-muted mt-2 select-all overflow-x-auto p-3 text-xs leading-relaxed">
            <span className="text-muted-foreground">
              {t("activity:import.help.holdingsExampleSnapshot")}
            </span>
            <br />
            date,symbol,quantity,avgCost,currency
            <br />
            2024-03-31,AAPL,50,171.48,USD
            <br />
            2024-03-31,MSFT,30,420.72,USD
            <br />
            2024-03-31,VOO,20,468.50,USD
            <br />
            2024-03-31,$CASH,5000,,USD
            <br />
            <br />
            <span className="text-muted-foreground">
              {t("activity:import.help.holdingsExampleMultiple")}
            </span>
            <br />
            2024-06-30,AAPL,55,210.62,USD
            <br />
            2024-06-30,MSFT,30,446.34,USD
            <br />
            2024-06-30,VOO,25,495.89,USD
            <br />
            2024-06-30,$CASH,3200,,USD
          </pre>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3 flex items-center gap-1.5"
            onClick={downloadSampleHoldingsCsv}
          >
            <Icons.Download className="h-4 w-4" />
            {t("activity:import.help.downloadSample")}
          </Button>
        </div>

        <div>
          <p className="font-semibold">{t("activity:import.help.supportedDateFormats")}</p>
          <pre className="bg-muted mt-2 overflow-x-auto p-4 text-xs">
            <ul className="list-inside list-disc space-y-1">
              <li>YYYY-MM-DD (2024-03-31)</li>
              <li>MM/DD/YYYY (03/31/2024)</li>
              <li>DD/MM/YYYY (31/03/2024)</li>
              <li>MM-DD-YYYY (03-31-2024)</li>
              <li>DD-MM-YYYY (31-03-2024)</li>
            </ul>
          </pre>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Import Help Popover
// ─────────────────────────────────────────────────────────────────────────────

interface ImportHelpPopoverProps {
  defaultTab?: "activities" | "holdings";
}

export function ImportHelpPopover({ defaultTab = "activities" }: ImportHelpPopoverProps) {
  const { isMobile } = usePlatform();
  const { t } = useTranslation();

  const helpContent = (
    <Tabs defaultValue={defaultTab}>
      <TabsList className="mb-4 w-auto">
        <TabsTrigger value="activities">{t("activity:import.help.tabActivities")}</TabsTrigger>
        <TabsTrigger value="holdings">{t("activity:import.help.tabHoldings")}</TabsTrigger>
      </TabsList>
      <TabsContent value="activities" className="m-0">
        <ActivitiesHelpContent />
      </TabsContent>
      <TabsContent value="holdings" className="m-0">
        <HoldingsHelpContent />
      </TabsContent>
    </Tabs>
  );

  if (isMobile) {
    return (
      <Sheet>
        <SheetTrigger asChild>
          <Button type="button" variant="ghost" size="icon" className="h-9 w-9">
            <Icons.HelpCircle className="h-6 w-6" />
          </Button>
        </SheetTrigger>
        <SheetContent side="bottom" className="rounded-t-4xl mx-1 h-[85vh]">
          <SheetHeader>
            <SheetTitle>{t("activity:import.help.mobileTitle")}</SheetTitle>
          </SheetHeader>
          <ScrollArea className="h-[calc(85vh-4rem)] pr-4">{helpContent}</ScrollArea>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="link" className="flex items-center">
          <Icons.HelpCircle className="mr-1 h-5 w-5" />
          {t("activity:import.help.button")}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="m-4 max-h-[80vh] w-[900px] max-w-[calc(100vw-2rem)] overflow-y-auto p-6 text-sm">
        {helpContent}
      </PopoverContent>
    </Popover>
  );
}
