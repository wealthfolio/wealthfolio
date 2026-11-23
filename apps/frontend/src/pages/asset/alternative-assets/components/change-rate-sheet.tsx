import { LoanFieldInfo } from "./loan-field-info";
import { loanErrorText } from "./loan-error-text";
import {
  Button,
  DatePickerInput,
  MoneyInput,
  QuantityInput,
  Spinner,
  useNumberFormatting,
} from "@wealthfolio/ui";
import { Sheet, SheetDescription, SheetTitle } from "@wealthfolio/ui/components/ui/sheet";
import {
  LoanSheetContent,
  LoanSheetHeader,
  LoanSheetBody,
  LoanSheetFooter,
} from "./loan-sheet-content";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDateISO } from "@/lib/utils";
import { parseISO } from "date-fns";
import { inheritedLoanSettings } from "../lib/loan-event-editing";

export interface LoanRateChangeInput {
  effectiveDate: Date;
  annualRate: number;
  /** Omitted: the current payment continues. */
  paymentAmount?: number;
}

interface ChangeRateSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  metadata: Record<string, unknown>;
  /** Today in the settings timezone, which the backend dates loan actions against. */
  today: string;
  onSubmit: (change: LoanRateChangeInput) => Promise<void>;
}

/** As many decimals as Quick Add and Recalculate store, so a stored rate shows exactly. */
const RATE_DECIMALS = 8;

/** The rate in effect on a calendar day, including that day's recorded events. */
function rateOn(metadata: Record<string, unknown>, date: Date) {
  return inheritedLoanSettings(metadata, -1, formatDateISO(date)).annualRate;
}

/** Record a rate set by the lender. The payment stays unless a new one is entered. */
export function ChangeRateSheet({
  open,
  onOpenChange,
  metadata,
  today,
  onSubmit,
}: ChangeRateSheetProps) {
  const { t } = useTranslation();
  const { formatDecimal } = useNumberFormatting();
  const rateInputId = useId();
  const paymentInputId = useId();
  const [effectiveDate, setEffectiveDate] = useState<Date>(() => parseISO(today));
  // Starts from the rate on the default date, which the check below compares with.
  const [newRate, setNewRate] = useState(() => String(rateOn(metadata, parseISO(today))));
  const [payment, setPayment] = useState<number | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // A fresh draft each time the sheet opens. A loan update while it is open
  // keeps the draft; the checks below use the updated loan.
  const [lastOpen, setLastOpen] = useState(false);
  if (lastOpen !== open) {
    setLastOpen(open);
    if (open) {
      const date = parseISO(today);
      setEffectiveDate(date);
      setNewRate(String(rateOn(metadata, date)));
      setPayment(undefined);
      setSubmitError(null);
    }
  }

  const day = Number.isFinite(effectiveDate.getTime()) ? formatDateISO(effectiveDate) : "";
  const currentRate = inheritedLoanSettings(metadata, -1, day).annualRate;
  const parsedRate = newRate === "" ? Number.NaN : Number(newRate);
  const rateInvalid = !Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 100;
  const dateInvalid = !day || day > today;
  const isInvalid =
    rateInvalid ||
    dateInvalid ||
    (payment !== undefined && (!Number.isFinite(payment) || payment <= 0));
  // The rate already in effect, with no new payment, would record nothing.
  const unchanged = parsedRate === currentRate && payment === undefined;

  const handleSubmit = async () => {
    if (isSubmitting || isInvalid || unchanged) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit({ effectiveDate, annualRate: parsedRate, paymentAmount: payment });
    } catch (error) {
      setSubmitError(loanErrorText(t, error, "asset:loanEvents.failed"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <LoanSheetContent>
        <LoanSheetHeader>
          <SheetTitle>{t("asset:loanActions.change_rate")}</SheetTitle>
          <SheetDescription>{t("asset:loanActions.change_rate_description")}</SheetDescription>
        </LoanSheetHeader>
        <LoanSheetBody>
          <div className="space-y-2">
            <Label>{t("asset:loanOverview.effective_date")}</Label>
            <DatePickerInput
              aria-label={t("asset:loanOverview.effective_date")}
              value={effectiveDate}
              onChange={(value) => value && setEffectiveDate(value)}
              disabled={isSubmitting}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={rateInputId}>{t("asset:detailsSheet.interest_rate")}</Label>
            <div className="relative">
              <QuantityInput
                id={rateInputId}
                value={newRate}
                onValueChange={(value) => setNewRate(value == null ? "" : String(value))}
                maxDecimalPlaces={RATE_DECIMALS}
                className="pe-8"
                disabled={isSubmitting}
              />
              <span className="text-muted-foreground pointer-events-none absolute end-3 top-1/2 -translate-y-1/2 text-sm">
                %
              </span>
            </div>
            {!dateInvalid && (
              <p className="text-muted-foreground text-xs">
                {t("asset:loanActions.rate_in_effect", {
                  rate: formatDecimal(currentRate / 100, {
                    style: "percent",
                    maximumFractionDigits: RATE_DECIMALS,
                  }),
                })}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor={paymentInputId}>{t("asset:valueHistory.payment")}</Label>
              <span className="text-muted-foreground text-xs">{t("asset:quickAdd.optional")}</span>
              <LoanFieldInfo label={t("asset:valueHistory.payment")}>
                {t("asset:loanActions.payment_hint")}
              </LoanFieldInfo>
            </div>
            <MoneyInput
              id={paymentInputId}
              maxDecimalPlaces={2}
              placeholder={t("asset:loanActions.payment_unchanged")}
              value={payment ?? null}
              onValueChange={(value) => setPayment(value)}
              disabled={isSubmitting}
            />
          </div>
          {(isInvalid || submitError) && (
            <p className="text-destructive text-sm" role="alert">
              {submitError ?? t("asset:quickAdd.validation.invalid")}
            </p>
          )}
        </LoanSheetBody>
        <LoanSheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t("common:cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || isInvalid || unchanged}>
            {isSubmitting && <Spinner className="me-2 h-4 w-4" />}
            {t("asset:loanActions.change_rate")}
          </Button>
        </LoanSheetFooter>
      </LoanSheetContent>
    </Sheet>
  );
}
