import type { Asset, PriceAlertCondition } from "@/lib/types";
import { useLatestQuotes } from "@/pages/asset/hooks/use-latest-quotes";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  SearchableSelect,
  Tabs,
  TabsList,
  TabsTrigger,
  formatPrice,
} from "@wealthfolio/ui";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePriceAlertMutations, usePriceAlerts } from "../hooks/use-price-alerts";
import {
  PRICE_PRESETS,
  conditionForPercent,
  sanitizeTargetInput,
  targetFromPercent,
  validatePriceAlertTarget,
} from "../lib/price-alert-form";

interface CreatePriceAlertDialogProps {
  assets: Asset[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialAssetId?: string;
}

export function CreatePriceAlertDialog({
  assets,
  open,
  onOpenChange,
  initialAssetId,
}: CreatePriceAlertDialogProps) {
  const { t } = useTranslation();
  const { createMutation } = usePriceAlertMutations();
  const { data: existingAlerts = [] } = usePriceAlerts();
  const [assetId, setAssetId] = useState(initialAssetId ?? "");
  const [condition, setCondition] = useState<PriceAlertCondition>("ABOVE");
  const [targetPrice, setTargetPrice] = useState("");
  const [targetTouched, setTargetTouched] = useState(false);
  const quoteAssetIds = useMemo(() => (assetId ? [assetId] : []), [assetId]);
  const { data: latestQuotes = {} } = useLatestQuotes(quoteAssetIds);

  useEffect(() => {
    if (open) setAssetId(initialAssetId ?? "");
  }, [initialAssetId, open]);

  const options = useMemo(
    () =>
      assets.map((asset) => ({
        value: asset.id,
        label: [asset.displayCode ?? asset.instrumentSymbol, asset.name]
          .filter(Boolean)
          .join(" - "),
      })),
    [assets],
  );
  const selectedAsset = assets.find((asset) => asset.id === assetId);
  const latestQuote = assetId ? latestQuotes[assetId]?.quote : undefined;
  const currentPrice = latestQuote?.close;
  const targetValidation = validatePriceAlertTarget({
    assetId,
    condition,
    targetPrice,
    currentPrice,
    existingAlerts,
  });
  const isValid = Boolean(assetId) && !targetValidation.error;
  const targetError =
    (targetTouched || targetValidation.error === "DUPLICATE") && Boolean(targetValidation.error);
  const assetIsFixed = Boolean(initialAssetId);

  const reset = () => {
    setAssetId(initialAssetId ?? "");
    setCondition("ABOVE");
    setTargetPrice("");
    setTargetTouched(false);
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!isValid) return;
    try {
      await createMutation.mutateAsync({ assetId, condition, targetPrice: targetPrice.trim() });
      reset();
      onOpenChange(false);
    } catch {
      // The mutation displays the backend validation error and leaves the form editable.
    }
  };

  const handlePreset = (percent: number) => {
    if (currentPrice == null) return;
    setCondition(conditionForPercent(percent));
    setTargetPrice(targetFromPercent(currentPrice, percent));
    setTargetTouched(false);
  };

  const handleTargetChange = (value: string) => {
    setTargetPrice(sanitizeTargetInput(value));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !createMutation.isPending) reset();
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent className="w-[calc(100vw-2rem)] max-w-md overflow-x-hidden">
        <form onSubmit={handleSubmit} className="min-w-0 space-y-6">
          <DialogHeader>
            <DialogTitle>{t("common:price_alerts.create.title")}</DialogTitle>
            <DialogDescription>{t("common:price_alerts.create.description")}</DialogDescription>
          </DialogHeader>

          <div className="min-w-0 space-y-2">
            <Label>{t("common:price_alerts.create.asset")}</Label>
            {assetIsFixed ? (
              <div className="bg-muted/40 flex min-h-10 items-center rounded-md border px-3 text-sm">
                <span className="truncate">
                  {selectedAsset
                    ? [
                        selectedAsset.displayCode ?? selectedAsset.instrumentSymbol,
                        selectedAsset.name,
                      ]
                        .filter(Boolean)
                        .join(" - ")
                    : t("common:price_alerts.create.select_asset")}
                </span>
                {selectedAsset && (
                  <span className="text-muted-foreground ml-auto pl-3 text-xs">
                    {selectedAsset.quoteCcy}
                  </span>
                )}
              </div>
            ) : (
              <SearchableSelect
                options={options}
                value={assetId}
                onValueChange={setAssetId}
                placeholder={t("common:price_alerts.create.select_asset")}
                searchPlaceholder={t("common:price_alerts.create.search_assets")}
                emptyMessage={t("common:price_alerts.create.no_assets")}
                className="w-full min-w-0"
              />
            )}
          </div>

          <div className="space-y-2">
            <Label>{t("common:price_alerts.create.condition")}</Label>
            <Tabs
              value={condition}
              onValueChange={(value) => {
                setCondition(value as PriceAlertCondition);
                if (targetPrice) setTargetTouched(true);
              }}
            >
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="ABOVE">{t("common:price_alerts.condition.above")}</TabsTrigger>
                <TabsTrigger value="BELOW">{t("common:price_alerts.condition.below")}</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="price-alert-target">{t("common:price_alerts.create.target")}</Label>
              {latestQuote && (
                <span className="text-muted-foreground text-xs tabular-nums">
                  {t("common:price_alerts.create.latest_price", {
                    price: formatPrice(latestQuote.close, latestQuote.currency),
                  })}
                </span>
              )}
            </div>
            <div className="grid min-w-0 grid-cols-4 gap-2">
              {PRICE_PRESETS.map((percent) => (
                <Button
                  key={percent}
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={currentPrice == null}
                  onClick={() => handlePreset(percent)}
                  className="min-w-0 px-2 tabular-nums"
                >
                  {percent > 0 ? `+${percent}%` : `${percent}%`}
                </Button>
              ))}
            </div>
            <div className="relative">
              <Input
                id="price-alert-target"
                inputMode="decimal"
                type="text"
                value={targetPrice}
                onBlur={() => setTargetTouched(true)}
                onChange={(event) => handleTargetChange(event.target.value)}
                placeholder="0.00"
                aria-invalid={targetError}
                className={`pr-16 tabular-nums ${targetError ? "border-destructive focus-visible:ring-destructive" : ""}`}
              />
              {selectedAsset && (
                <span className="text-muted-foreground pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-medium">
                  {selectedAsset.quoteCcy}
                </span>
              )}
            </div>
            {targetError ? (
              <p className="text-destructive text-xs">
                {targetValidation.error === "REQUIRED"
                  ? t("common:price_alerts.create.target_required")
                  : targetValidation.error === "ALREADY_SATISFIED"
                    ? t(
                        condition === "ABOVE"
                          ? "common:price_alerts.create.target_above_current"
                          : "common:price_alerts.create.target_below_current",
                        {
                          price: currentPrice
                            ? formatPrice(
                                currentPrice,
                                latestQuote?.currency ?? selectedAsset?.quoteCcy ?? "USD",
                              )
                            : "",
                        },
                      )
                    : targetValidation.error === "DUPLICATE"
                      ? t("common:price_alerts.create.duplicate")
                      : t("common:price_alerts.create.target_invalid")}
              </p>
            ) : (
              <p className="text-muted-foreground text-xs">
                {t("common:price_alerts.create.one_shot_hint")}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("common:cancel")}
            </Button>
            <Button type="submit" disabled={!isValid || createMutation.isPending}>
              {createMutation.isPending
                ? t("common:price_alerts.create.creating")
                : t("common:price_alerts.create.submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
