import { DECIMAL_PRECISION } from "@/lib/constants";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Button,
  MoneyInput,
  Spinner,
  useBalancePrivacy,
  useNumberFormatting,
} from "@wealthfolio/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@wealthfolio/ui/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { useBalanceUpdate } from "./use-balance-update";

interface CashBalance {
  currency: string;
  balance: number;
}

interface CashBalanceDialogProps {
  accountId: string;
  accountCurrency: string;
  cashBalances: CashBalance[];
  disabled: boolean;
  onClose: () => void;
}

export function CashBalanceDialog({
  accountId,
  accountCurrency,
  cashBalances,
  disabled,
  onClose,
}: CashBalanceDialogProps) {
  const { t } = useTranslation();
  const formatting = useNumberFormatting();
  const { isBalanceHidden } = useBalancePrivacy();
  const { updateBalance, isPending } = useBalanceUpdate(accountId);
  // A missing account-currency row is zero only after the full native split has loaded.
  const balances = cashBalances.some(({ currency }) => currency === accountCurrency)
    ? cashBalances
    : [...cashBalances, { currency: accountCurrency, balance: 0 }];
  const heldCurrencies = cashBalances.filter(({ balance }) => balance !== 0);
  const initialCurrency =
    heldCurrencies.length === 1 ? heldCurrencies[0].currency : accountCurrency;
  const initialBalance = balances.find(({ currency }) => currency === initialCurrency)?.balance;
  const invalidAmount = t("account:balance_edit.invalid_amount");
  const schema = z.object({
    currency: z.string().min(1),
    targetBalance: z
      .number({ error: invalidAmount })
      .finite(invalidAmount)
      .nonnegative(invalidAmount)
      .nullable()
      .refine((value): value is number => value !== null, invalidAmount),
  });
  const form = useForm<z.input<typeof schema>, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    mode: "onChange",
    // This component mounts on each open. Refreshes must not reset the user's draft.
    defaultValues: {
      currency: initialCurrency,
      targetBalance: initialBalance != null && initialBalance >= 0 ? initialBalance : null,
    },
  });
  const currency = form.watch("currency");
  const targetBalance = form.watch("targetBalance");
  const currentBalance = balances.find((balance) => balance.currency === currency)?.balance;
  const difference = (targetBalance ?? NaN) - (currentBalance ?? NaN);
  const amount = parseFloat(Math.abs(difference).toFixed(DECIMAL_PRECISION));
  const busy = isPending || form.formState.isSubmitting;
  const unavailable = disabled || currentBalance == null;
  const formatBalance = (value: number) =>
    isBalanceHidden
      ? "••••"
      : formatting.formatDecimal(value, { maximumFractionDigits: DECIMAL_PRECISION });

  const handleSubmit = form.handleSubmit(async (values) => {
    if (isPending || unavailable || currentBalance == null) return;
    try {
      await updateBalance({ ...values, currentBalance });
      onClose();
    } catch {
      form.setError("root", { message: t("account:balance_edit.error") });
    }
  });

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>{t("account:balance_edit.title")}</DialogTitle>
          <DialogDescription>{t("account:balance_edit.description")}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={handleSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="currency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("common:currency")}</FormLabel>
                  <Select
                    items={balances.map(({ currency }) => ({ value: currency, label: currency }))}
                    value={field.value}
                    disabled={busy || disabled}
                    onValueChange={(value) => {
                      if (!value) return;
                      field.onChange(value);
                      const balance = balances.find(({ currency }) => currency === value)?.balance;
                      form.setValue(
                        "targetBalance",
                        balance != null && balance >= 0 ? balance : null,
                        {
                          shouldValidate: true,
                        },
                      );
                    }}
                  >
                    <FormControl>
                      <SelectTrigger onBlur={field.onBlur} ref={field.ref}>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {balances.map(({ currency }) => (
                        <SelectItem key={currency} value={currency}>
                          {currency}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <dl className="flex items-center justify-between gap-2 text-sm">
              <dt className="text-muted-foreground">{t("account:balance_edit.current_balance")}</dt>
              <dd className="font-medium tabular-nums">
                {unavailable ? "—" : `${formatBalance(currentBalance)} ${currency}`}
              </dd>
            </dl>
            <FormField
              control={form.control}
              name="targetBalance"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("account:balance_edit.new_balance")}</FormLabel>
                  <FormControl>
                    <MoneyInput
                      name={field.name}
                      ref={field.ref}
                      value={Number.isFinite(field.value) ? field.value : ""}
                      onValueChange={(value) => field.onChange(value ?? null)}
                      onBlur={field.onBlur}
                      disabled={busy || unavailable}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <p className="text-muted-foreground text-sm" aria-live="polite">
              {unavailable
                ? t("account:balance_edit.unavailable")
                : Number.isFinite(amount) && targetBalance != null && targetBalance >= 0
                  ? amount === 0
                    ? t("account:balance_edit.no_change")
                    : `${t(difference > 0 ? "activity:type_deposit" : "activity:type_withdrawal")}: ${formatBalance(amount)} ${currency}`
                  : null}
            </p>
            {form.formState.errors.root && (
              <p role="alert" className="text-destructive text-sm">
                {form.formState.errors.root.message}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                {t("common:cancel")}
              </Button>
              <Button
                type="submit"
                disabled={
                  busy ||
                  unavailable ||
                  targetBalance == null ||
                  targetBalance < 0 ||
                  !Number.isFinite(amount) ||
                  amount === 0
                }
              >
                {busy && <Spinner className="size-4" />}
                {t("common:save")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
