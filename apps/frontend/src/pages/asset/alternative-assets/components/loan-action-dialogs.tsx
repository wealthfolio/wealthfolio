import { AmountDisplay, Button, DatePickerInput, Icons, MoneyInput } from "@wealthfolio/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { calculateMonthlyPayment } from "../lib/loan-schedule";
import type { LoanPaymentFrequency } from "../lib/loan-events";

interface CloseLoanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (date: Date) => Promise<void>;
  originationDate: Date | null;
}

export function CloseLoanDialog({
  open,
  onOpenChange,
  onSubmit,
  originationDate,
}: CloseLoanDialogProps) {
  const { t } = useTranslation();
  const [date, setDate] = useState<Date>(() => new Date());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isDateInvalid = (originationDate !== null && date < originationDate) || date > new Date();

  useEffect(() => {
    if (open) setDate(new Date());
  }, [open]);

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit(date);
      setDate(new Date());
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("asset:loanActions.close_loan")}</DialogTitle>
          <DialogDescription>{t("asset:loanActions.close_loan_description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>{t("asset:loanActions.closure_date")}</Label>
            <DatePickerInput
              value={date}
              onChange={(d) => d && setDate(d)}
              disabled={isSubmitting}
            />
          </div>
          {isDateInvalid && (
            <p className="text-destructive text-sm" role="alert">
              {t("asset:loanActions.validation.closure_date_invalid")}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t("common:cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={handleSubmit}
            disabled={isSubmitting || isDateInvalid}
          >
            {isSubmitting && <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />}
            {t("asset:loanActions.confirm_close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RecalculateScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentBalance: number;
  currency: string;
  interestRate: number;
  endDate: Date | null;
  frequency: LoanPaymentFrequency;
  remainingPayments: number;
  onSubmit: (newRate: number) => Promise<void>;
}

export function RecalculateScheduleDialog({
  open,
  onOpenChange,
  currentBalance,
  currency,
  interestRate,
  endDate,
  frequency,
  remainingPayments,
  onSubmit,
}: RecalculateScheduleDialogProps) {
  const { t, i18n } = useTranslation();
  const [newRate, setNewRate] = useState<string>(() => String(interestRate));
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (open) setNewRate(String(interestRate));
  }, [interestRate, open]);

  const parsedRate = parseFloat(newRate);
  const isRateInvalid = !Number.isFinite(parsedRate) || parsedRate < 0 || parsedRate > 100;
  const newPayment = calculateMonthlyPayment(
    currentBalance,
    parsedRate,
    remainingPayments,
    frequency,
  );

  const handleSubmit = async () => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit(parseFloat(newRate || "0"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("asset:loanActions.recalculate_schedule")}</DialogTitle>
          <DialogDescription>{t("asset:loanActions.recalculate_description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="bg-muted grid grid-cols-2 gap-x-4 gap-y-1 rounded-md px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              {t("asset:loanActions.recalculate_current_balance")}
            </span>
            <span className="text-right font-medium">
              <AmountDisplay value={currentBalance} currency={currency} />
            </span>
            <span className="text-muted-foreground">
              {t("asset:loanActions.remaining_payments")}
            </span>
            <span className="text-right font-medium">{remainingPayments}</span>
            {endDate && (
              <>
                <span className="text-muted-foreground">{t("asset:altContent.end_date")}</span>
                <span className="text-right font-medium">
                  {endDate.toLocaleDateString(i18n.language, {
                    month: "short",
                    year: "numeric",
                  })}
                </span>
              </>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>{t("asset:loanActions.recalculate_new_rate")}</Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={newRate}
              onChange={(e) => setNewRate(e.target.value)}
              disabled={isSubmitting}
            />
          </div>
          {newPayment !== null && (
            <div className="bg-muted rounded-md px-3 py-2 text-sm">
              <span className="text-muted-foreground">{t("asset:valueHistory.payment")}: </span>
              <span className="font-medium">
                <AmountDisplay value={newPayment} currency={currency} />
              </span>
            </div>
          )}
          {isRateInvalid && (
            <p className="text-destructive text-sm" role="alert">
              {t("asset:quickAdd.validation.invalid")}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t("common:cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || remainingPayments <= 0 || isRateInvalid}
          >
            {isSubmitting && <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />}
            {t("asset:loanActions.recalculate_confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RenewLoanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentBalance: number;
  currency: string;
  interestRate: number;
  endDate: Date | null;
  onSubmit: (
    effectiveDate: Date,
    newRate: number,
    paymentAmount?: number,
    termEndDate?: Date,
  ) => Promise<void>;
}

/** Record a dated renewal without rewriting any historical quote. */
export function RenewLoanDialog({
  open,
  onOpenChange,
  currentBalance,
  currency,
  interestRate,
  endDate,
  onSubmit,
}: RenewLoanDialogProps) {
  const { t } = useTranslation();
  const [effectiveDate, setEffectiveDate] = useState<Date>(() => new Date());
  const [newRate, setNewRate] = useState(String(interestRate));
  const [payment, setPayment] = useState<number | undefined>();
  const [termEndDate, setTermEndDate] = useState<Date | undefined>(endDate ?? undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setEffectiveDate(new Date());
    setNewRate(String(interestRate));
    setPayment(undefined);
    setTermEndDate(endDate ?? undefined);
  }, [endDate, interestRate, open]);

  const parsedRate = Number(newRate);
  const isInvalid =
    !Number.isFinite(parsedRate) ||
    parsedRate < 0 ||
    parsedRate > 100 ||
    effectiveDate > new Date() ||
    (termEndDate !== undefined && termEndDate <= effectiveDate) ||
    (payment !== undefined && (!Number.isFinite(payment) || payment <= 0));

  const handleSubmit = async () => {
    if (isSubmitting || isInvalid) return;
    setIsSubmitting(true);
    try {
      await onSubmit(effectiveDate, parsedRate, payment, termEndDate);
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("asset:loanActions.recalculate_schedule")}</DialogTitle>
          <DialogDescription>{t("asset:loanActions.recalculate_description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="bg-muted rounded-md px-3 py-2 text-sm">
            <span className="text-muted-foreground">
              {t("asset:loanActions.recalculate_current_balance")}:{" "}
            </span>
            <AmountDisplay value={currentBalance} currency={currency} />
          </div>
          <div className="space-y-1.5">
            <Label>{t("asset:loanActions.repayment_date")}</Label>
            <DatePickerInput
              value={effectiveDate}
              onChange={(date) => date && setEffectiveDate(date)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("asset:loanActions.recalculate_new_rate")}</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={newRate}
              onChange={(event) => setNewRate(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("asset:loanActions.new_monthly_payment")}</Label>
            <MoneyInput
              value={payment ?? 0}
              onValueChange={(value) => setPayment(value || undefined)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>{t("asset:altContent.end_date")}</Label>
            <DatePickerInput
              value={termEndDate}
              onChange={(date) => setTermEndDate(date ?? undefined)}
            />
          </div>
          {isInvalid && (
            <p className="text-destructive text-sm" role="alert">
              {t("asset:quickAdd.validation.invalid")}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t("common:cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || isInvalid}>
            {isSubmitting && <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />}
            {t("asset:loanActions.recalculate_confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface LoanBalanceEventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "balance_correction" | "extra_repayment";
  currentBalance: number;
  onSubmit: (date: Date, amount: number) => Promise<void>;
}

export function LoanBalanceEventDialog({
  open,
  onOpenChange,
  mode,
  currentBalance,
  onSubmit,
}: LoanBalanceEventDialogProps) {
  const { t } = useTranslation();
  const [date, setDate] = useState<Date>(() => new Date());
  const [amount, setAmount] = useState<number>(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isCorrection = mode === "balance_correction";
  const invalid =
    amount < 0 || (!isCorrection && (amount === 0 || amount > currentBalance)) || date > new Date();

  useEffect(() => {
    if (!open) return;
    setDate(new Date());
    setAmount(0);
  }, [open]);

  const handleSubmit = async () => {
    if (invalid || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit(date, amount);
      onOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(
              isCorrection
                ? "asset:loanActions.balance_correction"
                : "asset:loanActions.extra_repayment",
            )}
          </DialogTitle>
          <DialogDescription>
            {t(
              isCorrection
                ? "asset:loanActions.balance_correction_description"
                : "asset:loanActions.extra_repayment_description",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>{t("asset:loanActions.repayment_date")}</Label>
            <DatePickerInput value={date} onChange={(value) => value && setDate(value)} />
          </div>
          <div className="space-y-1.5">
            <Label>
              {t(
                isCorrection
                  ? "asset:loanActions.recalculate_current_balance"
                  : "asset:loanActions.repayment_amount",
              )}
            </Label>
            <MoneyInput value={amount} onValueChange={(value) => setAmount(value ?? 0)} />
          </div>
          {invalid && (
            <p className="text-destructive text-sm" role="alert">
              {t(
                !isCorrection && amount > currentBalance
                  ? "asset:loanActions.validation.amount_exceeds_balance"
                  : "asset:quickAdd.validation.invalid",
              )}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSubmitting}>
            {t("common:cancel")}
          </Button>
          <Button onClick={handleSubmit} disabled={invalid || isSubmitting}>
            {isSubmitting && <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />}
            {t(
              isCorrection
                ? "asset:loanActions.confirm_balance_correction"
                : "asset:loanActions.confirm_extra_repayment",
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
