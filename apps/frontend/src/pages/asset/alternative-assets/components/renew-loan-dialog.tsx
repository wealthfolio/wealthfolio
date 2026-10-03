import { addYears } from "date-fns";
import { LoanInterestMethodSelect } from "./loan-interest-method-select";
import { LoanFieldInfo } from "./loan-field-info";
import { loanErrorText } from "./loan-error-text";
import type { LoanInterestMethod, LoanPaymentFrequency } from "../lib/loan-events";
import {
  Button,
  DatePickerInput,
  Icons,
  MoneyInput,
  QuantityInput,
  ResponsiveSelect,
  useAmountFormatting,
  useDateFormatting,
} from "@wealthfolio/ui";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { buttonVariants } from "@wealthfolio/ui/components/ui/button-variants";
import { Sheet, SheetDescription, SheetTitle } from "@wealthfolio/ui/components/ui/sheet";
import {
  LoanSheetContent,
  LoanSheetHeader,
  LoanSheetBody,
  LoanSheetFooter,
} from "./loan-sheet-content";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Quote } from "@/lib/types";
import { cn, formatDateISO } from "@/lib/utils";
import { loanRenewalEstimateRequest, useLoanPayments } from "../hooks/use-loan-calculation";
import { inheritedLoanSettings } from "../lib/loan-event-editing";
import { recalculateLoan } from "@/adapters";
import { useQuery } from "@tanstack/react-query";
import { QueryKeys } from "@/lib/query-keys";

export interface LoanRenewalInput {
  effectiveDate: Date;
  annualRate: number;
  /** Omitted: the current payment continues. */
  paymentAmount?: number;
  /** Omitted: the frequency in effect on the renewal date continues. */
  frequency?: LoanPaymentFrequency;
  interestMethod?: LoanInterestMethod;
  termEndDate?: Date;
  /** Balance stated on the renewal letter, recorded as a confirmation. */
  balance?: number;
}

interface RenewLoanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  assetId: string;
  currency: string;
  interestRate: number;
  metadata: Record<string, unknown>;
  quoteHistory: Quote[];
  /** Maturity of the current term; a passed maturity is the default renewal date. */
  maturity: Date | null;
  mortgage: boolean;
  onSubmit: (renewal: LoanRenewalInput) => Promise<void>;
}

/** Common fixed terms; any other length goes in the custom field. */
const RENEWAL_TERM_YEARS = [3, 5];

/** A renewal usually starts when the current term matures; never in the future. */
function defaultRenewalDate(maturityTime: number | undefined) {
  const today = new Date();
  return maturityTime !== undefined && maturityTime <= today.getTime()
    ? new Date(maturityTime)
    : today;
}

/** Record a dated renewal without rewriting any historical quote. */
export function RenewLoanDialog({
  open,
  onOpenChange,
  assetId,
  currency,
  interestRate,
  metadata,
  quoteHistory,
  maturity,
  mortgage,
  onSubmit,
}: RenewLoanDialogProps) {
  const { t } = useTranslation();
  const { formatAmount } = useAmountFormatting();
  const dates = useDateFormatting();
  const rateInputId = useId();
  const paymentInputId = useId();
  const balanceInputId = useId();
  const maturityTime = maturity?.getTime();
  const [effectiveDate, setEffectiveDate] = useState<Date>(() => defaultRenewalDate(maturityTime));
  const [newRate, setNewRate] = useState(String(interestRate));
  const [method, setMethod] = useState<LoanInterestMethod | undefined>();
  const [frequency, setFrequency] = useState<LoanPaymentFrequency | undefined>();
  const [payment, setPayment] = useState<number | undefined>();
  // A term in years follows the renewal date; a picked date stays as picked.
  const [termYears, setTermYears] = useState<number | undefined>();
  const [customTerm, setCustomTerm] = useState("");
  const [pickedTermEnd, setPickedTermEnd] = useState<Date | undefined>();
  const [balance, setBalance] = useState<number | undefined>();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEffectiveDate(defaultRenewalDate(maturityTime));
    setNewRate(String(interestRate));
    setMethod(undefined);
    setFrequency(undefined);
    setPayment(undefined);
    setTermYears(undefined);
    setCustomTerm("");
    setPickedTermEnd(undefined);
    setBalance(undefined);
    setSubmitError(null);
  }, [interestRate, maturityTime, open]);

  const day = Number.isFinite(effectiveDate.getTime()) ? formatDateISO(effectiveDate) : "";
  const inherited = inheritedLoanSettings(metadata, -1, day);
  const changedFrequency = frequency && frequency !== inherited.frequency ? frequency : undefined;
  const changedMethod = method && method !== inherited.interestMethod ? method : undefined;
  // The current payment is an amount per period, so a new frequency needs its own payment.
  const paymentMissing = changedFrequency !== undefined && payment === undefined;
  const parsedRate = newRate === "" ? Number.NaN : Number(newRate);
  const rateInvalid = !Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 100;
  const dateInvalid = !day || effectiveDate > new Date();
  const termEndDate =
    termYears !== undefined && !dateInvalid ? addYears(effectiveDate, termYears) : pickedTermEnd;
  const isInvalid =
    rateInvalid ||
    dateInvalid ||
    (termEndDate !== undefined && termEndDate <= effectiveDate) ||
    (payment !== undefined && (!Number.isFinite(payment) || payment <= 0)) ||
    (balance !== undefined && (!Number.isFinite(balance) || balance < 0));
  const blocked = isInvalid || paymentMissing;

  // Preview the renewal as drafted: the backend solves the payment that keeps the
  // original amortization end, from the balance on the renewal date.
  const { data: payments = [] } = useLoanPayments(assetId, open);
  const estimateRequest =
    open && !rateInvalid && !dateInvalid
      ? loanRenewalEstimateRequest(
          metadata,
          quoteHistory,
          {
            effectiveDate: day,
            annualRate: parsedRate,
            frequency: changedFrequency,
            interestMethod: changedMethod,
            balance,
          },
          payments,
        )
      : null;
  const { data: estimate } = useQuery({
    queryKey: [QueryKeys.ASSET_DATA, assetId, "loan-renewal", estimateRequest],
    queryFn: () => recalculateLoan(estimateRequest!),
    enabled: estimateRequest !== null,
  });
  const date = (value: Date) =>
    dates.formatCalendarDate(formatDateISO(value), {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  const label = (text: string, htmlFor?: string, info?: string) => (
    <div className="flex items-center gap-1.5">
      <Label htmlFor={htmlFor}>{text}</Label>
      {info && <LoanFieldInfo label={text}>{info}</LoanFieldInfo>}
    </div>
  );
  const title = t(mortgage ? "asset:loanOverview.renew_mortgage" : "asset:loanActions.renew_loan");

  const handleSubmit = async () => {
    if (isSubmitting || blocked) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit({
        effectiveDate,
        annualRate: parsedRate,
        paymentAmount: payment,
        frequency: changedFrequency,
        interestMethod: changedMethod,
        termEndDate,
        balance,
      });
      onOpenChange(false);
    } catch (error) {
      setSubmitError(loanErrorText(t, error, "asset:quickAdd.validation.invalid"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <LoanSheetContent>
        <LoanSheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>{t("asset:loanActions.renew_description")}</SheetDescription>
        </LoanSheetHeader>
        <LoanSheetBody>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              {label(t("asset:loanActions.renewal_date"))}
              <DatePickerInput
                aria-label={t("asset:loanActions.renewal_date")}
                value={effectiveDate}
                onChange={(value) => value && setEffectiveDate(value)}
              />
            </div>
            <div className="space-y-2">
              {label(
                t("asset:loanActions.renewal_maturity"),
                undefined,
                t("asset:loanActions.renewal_maturity_hint"),
              )}
              <DatePickerInput
                aria-label={t("asset:loanActions.renewal_maturity")}
                value={termEndDate}
                onChange={(value) => {
                  setTermYears(undefined);
                  setCustomTerm("");
                  setPickedTermEnd(value ?? undefined);
                }}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                {RENEWAL_TERM_YEARS.map((years) => {
                  const selected = !customTerm && termYears === years;
                  return (
                    <Button
                      key={years}
                      type="button"
                      size="xs"
                      variant={selected ? "secondary" : "outline"}
                      aria-pressed={selected}
                      onClick={() => {
                        setCustomTerm("");
                        setTermYears(years);
                      }}
                      disabled={dateInvalid}
                    >
                      {t("asset:loanActions.duration_year", { count: years })}
                    </Button>
                  );
                })}
                {/* Styled as a third term button; typing a length selects it. */}
                <label
                  className={cn(
                    buttonVariants({ variant: customTerm ? "secondary" : "outline", size: "xs" }),
                    "focus-within:ring-ring/50 cursor-text px-3 focus-within:ring-[3px]",
                    dateInvalid && "pointer-events-none opacity-50",
                  )}
                >
                  <input
                    aria-label={t("asset:loanActions.custom_term_years")}
                    inputMode="numeric"
                    value={customTerm}
                    onChange={(event) => {
                      const text = event.target.value.replace(/\D/g, "").slice(0, 2);
                      const years = Number(text);
                      setCustomTerm(text);
                      setTermYears(text && years >= 1 && years <= 30 ? years : undefined);
                    }}
                    placeholder={t("asset:loanActions.custom_term")}
                    disabled={dateInvalid}
                    className="placeholder:text-muted-foreground w-12 bg-transparent text-center outline-none"
                  />
                  <span aria-hidden="true" className="text-muted-foreground text-xs">
                    {t("asset:loanActions.years_short")}
                  </span>
                </label>
              </div>
            </div>
            <div className="space-y-2">
              {label(t("asset:detailsSheet.interest_rate"), rateInputId)}
              <div className="relative">
                <QuantityInput
                  id={rateInputId}
                  value={newRate}
                  onValueChange={(value) => setNewRate(value == null ? "" : String(value))}
                  maxDecimalPlaces={3}
                  className="pr-8"
                />
                <span className="text-muted-foreground pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm">
                  %
                </span>
              </div>
            </div>
            <div className="space-y-2">
              {label(t("asset:loanInterest.method"), undefined, t("asset:loanInterest.hint"))}
              <LoanInterestMethodSelect
                value={method ?? inherited.interestMethod}
                onChange={setMethod}
              />
            </div>
            <div className="space-y-2">
              {label(
                t("asset:valueHistory.payment"),
                paymentInputId,
                t("asset:loanActions.payment_hint"),
              )}
              <MoneyInput
                id={paymentInputId}
                maxDecimalPlaces={2}
                placeholder={t("asset:loanActions.payment_unchanged")}
                value={payment ?? null}
                onValueChange={(value) => setPayment(value || undefined)}
              />
              {paymentMissing && (
                <p className="text-warning text-xs">
                  {t("asset:loanActions.payment_required_for_frequency")}
                </p>
              )}
              {estimate && estimate.paymentAmount > 0 && (
                <p className="text-muted-foreground text-xs">
                  {t("asset:loanActions.payment_estimate", {
                    amount: formatAmount(estimate.paymentAmount, currency),
                  })}{" "}
                  {payment !== estimate.paymentAmount && (
                    <button
                      type="button"
                      className="text-foreground font-medium underline underline-offset-2"
                      onClick={() => setPayment(estimate.paymentAmount)}
                    >
                      {t("asset:loanActions.use_estimate")}
                    </button>
                  )}
                </p>
              )}
            </div>
            <div className="space-y-2">
              {label(t("asset:loanActions.payment_frequency"))}
              <ResponsiveSelect
                aria-label={t("asset:loanActions.payment_frequency")}
                value={frequency ?? inherited.frequency}
                onValueChange={(value) => setFrequency(value as LoanPaymentFrequency)}
                options={(["monthly", "biweekly", "accelerated_biweekly"] as const).map(
                  (value) => ({ value, label: t(`asset:loanActions.${value}`) }),
                )}
                sheetTitle={t("asset:loanActions.payment_frequency")}
              />
            </div>
          </div>

          <Separator />

          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <Label htmlFor={balanceInputId}>{t("asset:loanActions.balance_at_renewal")}</Label>
              <span className="text-muted-foreground text-xs">{t("asset:quickAdd.optional")}</span>
              <LoanFieldInfo label={t("asset:loanActions.balance_at_renewal")}>
                {t("asset:loanActions.balance_at_renewal_hint")}
              </LoanFieldInfo>
            </div>
            <MoneyInput
              id={balanceInputId}
              maxDecimalPlaces={2}
              placeholder=""
              value={balance ?? null}
              onValueChange={(value) => setBalance(value ?? undefined)}
            />
            {estimate && balance === undefined && (
              <p className="text-muted-foreground text-xs">
                {t("asset:loanActions.balance_estimate", {
                  amount: formatAmount(estimate.currentBalance, currency),
                  date: date(effectiveDate),
                })}
              </p>
            )}
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
          <Button onClick={handleSubmit} disabled={isSubmitting || blocked}>
            {isSubmitting && <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />}
            {title}
          </Button>
        </LoanSheetFooter>
      </LoanSheetContent>
    </Sheet>
  );
}
