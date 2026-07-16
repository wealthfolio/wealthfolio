import { memo } from "react";
import { useTranslation } from "react-i18next";

import { Badge, Button } from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";

import type { ImportCsvMappingOutput, MappingConfidence } from "../../types";

interface MappingBadgeStripProps {
  mapping: ImportCsvMappingOutput;
  baseCurrency: string;
}

const CONFIDENCE_STYLES: Record<MappingConfidence, string> = {
  HIGH: "bg-success/10 text-success border-success/30",
  MEDIUM: "bg-warning/10 text-warning border-warning/30",
  LOW: "bg-destructive/10 text-destructive border-destructive/30",
};

const CONFIDENCE_LABEL_KEYS: Record<MappingConfidence, string> = {
  HIGH: "ai:mapping.confidenceHigh",
  MEDIUM: "ai:mapping.confidenceMedium",
  LOW: "ai:mapping.confidenceLow",
};

function formatDelimiter(delimiter: string | undefined, tabLabel: string): string | null {
  if (!delimiter || delimiter === "auto" || delimiter === ",") return null;
  if (delimiter === "\t") return tabLabel;
  return delimiter;
}

export const MappingBadgeStrip = memo(function MappingBadgeStrip({
  mapping,
  baseCurrency,
}: MappingBadgeStripProps) {
  const { t } = useTranslation();
  const { parseConfig, mappingConfidence, usedSavedProfile, appliedMapping } = mapping;

  const skipTop = parseConfig.skipTopRows ?? 0;
  const skipBottom = parseConfig.skipBottomRows ?? 0;
  const dateFormat = parseConfig.dateFormat;
  const defaultCurrency = parseConfig.defaultCurrency;
  const delimiter = formatDelimiter(parseConfig.delimiter, t("ai:mapping.tab"));
  const decimalSeparator = parseConfig.decimalSeparator;

  const showDateBadge = dateFormat && dateFormat !== "auto" && dateFormat !== "%Y-%m-%d";
  const showCurrencyBadge =
    defaultCurrency && defaultCurrency.toUpperCase() !== baseCurrency.toUpperCase();
  const showDecimalBadge =
    decimalSeparator && decimalSeparator !== "auto" && decimalSeparator !== ".";

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {usedSavedProfile ? (
        <Badge variant="outline" className="bg-primary/10 text-primary border-primary/30 gap-1">
          <Icons.Pin className="h-3 w-3" />
          {t("ai:mapping.usingSavedTemplate")}
        </Badge>
      ) : (
        <Badge variant="outline" className={`${CONFIDENCE_STYLES[mappingConfidence]} gap-1`}>
          <Icons.Sparkles className="h-3 w-3" />
          {t("ai:mapping.aiMapping", { confidence: t(CONFIDENCE_LABEL_KEYS[mappingConfidence]) })}
        </Badge>
      )}

      {skipTop > 0 && (
        <Badge variant="outline" className="text-muted-foreground">
          {t("ai:mapping.skippedPreamble", { count: skipTop })}
        </Badge>
      )}
      {skipBottom > 0 && (
        <Badge variant="outline" className="text-muted-foreground">
          {t("ai:mapping.skippedFooter", { count: skipBottom })}
        </Badge>
      )}
      {showDateBadge && (
        <Badge variant="outline" className="text-muted-foreground">
          {t("ai:mapping.date", { format: dateFormat })}
        </Badge>
      )}
      {showCurrencyBadge && (
        <Badge variant="outline" className="text-muted-foreground">
          {defaultCurrency}
        </Badge>
      )}
      {delimiter && (
        <Badge variant="outline" className="text-muted-foreground">
          {t("ai:mapping.delimiter", { delimiter })}
        </Badge>
      )}
      {showDecimalBadge && (
        <Badge variant="outline" className="text-muted-foreground">
          {t("ai:mapping.decimal", { separator: decimalSeparator })}
        </Badge>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-6 px-2 text-xs"
          >
            {t("ai:mapping.viewMapping")}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80" align="end">
          <div className="space-y-2">
            <div className="text-sm font-medium">{t("ai:mapping.columnMappings")}</div>
            <div className="text-muted-foreground text-xs">
              {Object.entries(appliedMapping.fieldMappings ?? {}).length === 0 ? (
                <div className="italic">{t("ai:mapping.noFieldMappings")}</div>
              ) : (
                <dl className="space-y-1">
                  {Object.entries(appliedMapping.fieldMappings ?? {}).map(([field, header]) => (
                    <div key={field} className="flex items-center justify-between gap-2">
                      <dt className="font-mono">{field}</dt>
                      <dd className="text-foreground truncate">
                        {Array.isArray(header) ? header.join(" / ") : header}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
            {Object.keys(appliedMapping.symbolMappings ?? {}).length > 0 && (
              <>
                <div className="border-t pt-2 text-sm font-medium">
                  {t("ai:mapping.symbolTranslations")}
                </div>
                <div className="text-muted-foreground text-xs">
                  <dl className="space-y-1">
                    {Object.entries(appliedMapping.symbolMappings ?? {})
                      .slice(0, 8)
                      .map(([from, to]) => (
                        <div key={from} className="flex items-center justify-between gap-2">
                          <dt className="truncate">{from}</dt>
                          <dd className="text-foreground font-mono">→ {to}</dd>
                        </div>
                      ))}
                  </dl>
                </div>
              </>
            )}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
});
