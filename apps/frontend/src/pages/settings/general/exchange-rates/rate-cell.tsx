import { stripBidiControls, useNumberFormatting } from "@wealthfolio/ui";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ExchangeRate } from "@/lib/types";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";

interface RateCellProps {
  rate: ExchangeRate;
  onUpdate: (updatedRate: ExchangeRate) => void;
}

export function RateCell({ rate, onUpdate }: RateCellProps) {
  const { t } = useTranslation();
  const numbers = useNumberFormatting();
  const formatRateInput = () =>
    numbers.formatDecimal(rate.rate, { useGrouping: false, maximumFractionDigits: 20 });
  const [isEditing, setIsEditing] = useState(false);
  // Region settings can change on this same page while the rate is being edited.
  const [rateDraft, setRateDraft] = useState({ value: "", numbers });
  const setEditedRate = (value: string) =>
    setRateDraft({ value: stripBidiControls(value), numbers });
  const parsedRate = rateDraft.numbers.parseNumber(rateDraft.value);
  const editedRate =
    rateDraft.numbers === numbers || parsedRate === undefined
      ? rateDraft.value
      : stripBidiControls(
          numbers.formatDecimal(parsedRate, { useGrouping: false, maximumFractionDigits: 20 }),
        );
  const isManual = rate.source === "MANUAL";

  const handleEdit = () => {
    if (!isManual) {
      toast({
        title: t("settings:fx_cannot_edit_title"),
        description: t("settings:fx_cannot_edit_desc"),
        variant: "destructive",
      });
      return;
    }
    setIsEditing(true);
    setEditedRate(formatRateInput());
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditedRate(formatRateInput());
  };

  const handleSubmit = () => {
    const newRate = parsedRate;
    if (newRate === undefined || newRate <= 0) {
      toast({
        title: t("settings:fx_invalid_title"),
        description: t("settings:fx_invalid_desc"),
        variant: "destructive",
      });
      return;
    }
    const updatedRate = { ...rate, rate: newRate };
    onUpdate(updatedRate);
    setIsEditing(false);
  };

  return (
    <div className="flex items-center space-x-2">
      <div className="w-24">
        {isManual && isEditing ? (
          <Input
            aria-label={t("settings:exchange_rates_rate")}
            value={editedRate}
            onChange={(e) => setEditedRate(e.target.value)}
            className="w-full"
          />
        ) : (
          <span>
            {rate.rate
              ? numbers.formatDecimal(rate.rate, {
                  minimumFractionDigits: 4,
                  maximumFractionDigits: 4,
                })
              : "-"}
          </span>
        )}
      </div>
      {isManual && (
        <div className="flex space-x-1">
          {isEditing ? (
            <>
              <Button
                variant="outline"
                size="icon"
                onClick={handleCancelEdit}
                aria-label={t("common:cancel")}
              >
                <Icons.Close className="h-4 w-4" />
              </Button>
              <Button size="icon" onClick={handleSubmit} aria-label={t("common:save")}>
                <Icons.Check className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              size="icon"
              onClick={handleEdit}
              aria-label={t("common:edit")}
            >
              <Icons.Pencil className="h-4 w-4" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
