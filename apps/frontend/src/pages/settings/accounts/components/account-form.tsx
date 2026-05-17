import { zodResolver } from "@hookform/resolvers/zod";
import { useCallback, useState } from "react";
import { useForm } from "react-hook-form";
import * as z from "zod";

import { Button } from "@wealthfolio/ui/components/ui/button";
import { Checkbox } from "@wealthfolio/ui/components/ui/checkbox";

import { newAccountSchema } from "@/lib/schemas";
import {
  CurrencyInput,
  RadioGroup,
  RadioGroupItem,
  ResponsiveSelect,
  type ResponsiveSelectOption,
} from "@wealthfolio/ui";
import { Alert, AlertDescription } from "@wealthfolio/ui/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui/components/ui/alert-dialog";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@wealthfolio/ui/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@wealthfolio/ui/components/ui/form";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";

import { useAccountMutations } from "./use-account-mutations";

const accountTypes: ResponsiveSelectOption[] = [
  { label: "Securities", value: "SECURITIES" },
  { label: "Cash", value: "CASH" },
  { label: "Crypto", value: "CRYPTOCURRENCY" },
];

// Input type (what the form receives)
type AccountFormInput = z.input<typeof newAccountSchema>;
// Output type after zod parsing (with defaults applied)
type AccountFormOutput = z.output<typeof newAccountSchema>;

interface AccountFormlProps {
  defaultValues?: AccountFormInput;
  onSuccess?: () => void;
}

export function AccountForm({ defaultValues, onSuccess = () => undefined }: AccountFormlProps) {
  const { createAccountMutation, updateAccountMutation } = useAccountMutations({ onSuccess });

  // Track initial tracking mode to detect changes
  const initialTrackingMode = defaultValues?.trackingMode;
  const needsSetup = initialTrackingMode === "NOT_SET" || initialTrackingMode === undefined;

  // State for mode switch confirmation dialog
  const [showModeConfirmation, setShowModeConfirmation] = useState(false);
  const [pendingFormData, setPendingFormData] = useState<AccountFormOutput | null>(null);

  const form = useForm<AccountFormInput, unknown, AccountFormOutput>({
    resolver: zodResolver(newAccountSchema),
    defaultValues: {
      ...defaultValues,
      // Don't default to any mode if account needs setup (must come after spread)
      trackingMode: needsSetup ? undefined : defaultValues?.trackingMode,
    },
  });

  const currentTrackingMode = form.watch("trackingMode");

  // Perform the actual submit (after confirmation if needed)
  // Returns a promise when updating so it can be chained with other operations
  const doSubmit = useCallback(
    (data: AccountFormOutput, options?: { async?: boolean }) => {
      const { id, trackingMode, taxTreatment, ...rest } = data;

      if (id) {
        if (options?.async) {
          return updateAccountMutation.mutateAsync({
            id,
            trackingMode,
            taxTreatment,
            ...rest,
          });
        }
        return updateAccountMutation.mutate({ id, trackingMode, taxTreatment, ...rest });
      }
      return createAccountMutation.mutate({ trackingMode, taxTreatment, ...rest });
    },
    [createAccountMutation, updateAccountMutation],
  );

  function onSubmit(data: AccountFormOutput) {
    // Validate tax treatment is selected for new accounts
    const isNewAccount = !data.id;
    if (isNewAccount && !data.taxTreatment) {
      form.setError("taxTreatment", {
        type: "manual",
        message: "Please select a tax treatment.",
      });
      return;
    }

    // Check if this is an existing account (update) and mode is switching from HOLDINGS to TRANSACTIONS
    const isExistingAccount = !!data.id;
    const isSwitchingFromHoldingsToTransactions =
      !needsSetup && initialTrackingMode === "HOLDINGS" && data.trackingMode === "TRANSACTIONS";

    if (isExistingAccount && isSwitchingFromHoldingsToTransactions) {
      // Show confirmation dialog
      setPendingFormData(data);
      setShowModeConfirmation(true);
      return;
    }

    // Otherwise, submit directly
    doSubmit(data);
  }

  // Handle confirmation dialog actions
  const handleConfirmModeSwitch = async () => {
    setShowModeConfirmation(false);
    if (pendingFormData?.id) {
      try {
        // Save all account details including tracking mode
        await doSubmit(pendingFormData, { async: true });
      } finally {
        setPendingFormData(null);
      }
    }
  };

  const handleCancelModeSwitch = () => {
    setShowModeConfirmation(false);
    setPendingFormData(null);
    // Revert the tracking mode in the form
    form.setValue("trackingMode", initialTrackingMode);
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
        <DialogHeader>
          <DialogTitle> {defaultValues?.id ? "Update Account" : "Add Account"}</DialogTitle>
          <DialogDescription>
            {defaultValues?.id
              ? "Update account information"
              : " Add an investment account to track."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 p-4">
          <input type="hidden" name="id" />
          <FormField
            control={form.control}
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Account Name</FormLabel>
                <FormControl>
                  <Input placeholder="Account display name" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="group"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Account Group</FormLabel>
                <FormControl>
                  <Input placeholder="Retirement, 401K, RRSP, TFSA,..." {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="accountType"
            render={({ field }) => (
              <FormItem className="flex flex-col">
                <FormLabel>Account Type</FormLabel>
                <FormControl>
                  <ResponsiveSelect
                    value={field.value}
                    onValueChange={field.onChange}
                    options={accountTypes}
                    placeholder="Select an account type"
                    sheetTitle="Select Account Type"
                    sheetDescription="Choose the account type that best matches."
                    triggerClassName="h-11"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          {!defaultValues?.id ? (
            <FormField
              control={form.control}
              name="currency"
              render={({ field }) => (
                <FormItem className="flex flex-col">
                  <FormLabel>Currency</FormLabel>
                  <FormControl>
                    <CurrencyInput
                      value={field.value}
                      onChange={(value: string) => field.onChange(value)}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : null}

          <FormField
            control={form.control}
            name="trackingMode"
            render={({ field }) => (
              <FormItem className="space-y-2">
                <FormLabel>Tracking Mode</FormLabel>
                {needsSetup && !currentTrackingMode && (
                  <Alert
                    variant="warning"
                    className="px-3 py-2.5 [&>svg]:left-3 [&>svg]:top-2.5 [&>svg~*]:pl-6"
                  >
                    <Icons.AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="text-xs">
                      Choose how to track this account. This affects what data you enter and what
                      metrics are available.{" "}
                      <a
                        href="https://wealthfolio.app/docs/concepts/activity-types"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-foreground underline"
                      >
                        Learn more
                      </a>
                    </AlertDescription>
                  </Alert>
                )}
                <FormControl>
                  <RadioGroup
                    onValueChange={field.onChange}
                    value={field.value}
                    className="grid grid-cols-1 gap-3 sm:grid-cols-2"
                  >
                    <label
                      className={`hover:bg-accent relative flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors ${
                        field.value === "TRANSACTIONS"
                          ? "border-primary bg-primary/5"
                          : "border-muted"
                      }`}
                    >
                      <RadioGroupItem value="TRANSACTIONS" className="mt-0.5" />
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">Transactions</span>
                        <span className="text-muted-foreground text-xs">
                          Track every trade for performance analytics
                        </span>
                      </div>
                    </label>
                    <label
                      className={`hover:bg-accent relative flex cursor-pointer gap-3 rounded-lg border p-3 transition-colors ${
                        field.value === "HOLDINGS" ? "border-primary bg-primary/5" : "border-muted"
                      }`}
                    >
                      <RadioGroupItem value="HOLDINGS" className="mt-0.5" />
                      <div className="flex flex-col">
                        <span className="text-sm font-medium">Holdings</span>
                        <span className="text-muted-foreground text-xs">
                          Add holdings directly as snapshots
                        </span>
                      </div>
                    </label>
                  </RadioGroup>
                </FormControl>
                {field.value === "HOLDINGS" && (
                  <Alert
                    variant="warning"
                    className="px-3 py-2.5 [&>svg]:left-3 [&>svg]:top-2.5 [&>svg~*]:pl-6"
                  >
                    <Icons.AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="text-xs">
                      Performance metrics will be limited without transaction history.{" "}
                      <a
                        href="https://wealthfolio.app/docs/concepts/activity-types"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-foreground underline"
                      >
                        Learn more
                      </a>
                    </AlertDescription>
                  </Alert>
                )}
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="taxTreatment"
            render={({ field }) => (
              <FormItem className="flex flex-col">
                <FormLabel>Tax Treatment</FormLabel>
                <FormControl>
                  <ResponsiveSelect
                    value={field.value}
                    onValueChange={field.onChange}
                    options={[
                      { label: "Taxable", value: "TAXABLE" },
                      { label: "Tax-Free", value: "TAX_FREE" },
                      { label: "Tax-Deferred", value: "TAX_DEFERRED" },
                    ]}
                    placeholder="Select tax treatment"
                    sheetTitle="Select Tax Treatment"
                    sheetDescription="Choose how this account is taxed."
                    triggerClassName="h-11"
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="isActive"
            render={({ field }) => (
              <FormItem className="flex items-center space-x-3 space-y-0 rounded-lg border p-3">
                <FormControl>
                  <Checkbox
                    checked={!field.value}
                    onCheckedChange={(checked) => field.onChange(!checked)}
                  />
                </FormControl>
                <FormLabel className="text-sm font-normal">
                  Hide this account
                  <span className="text-muted-foreground ml-1 text-xs font-normal">
                    — keeps in Total & history
                  </span>
                </FormLabel>
                <FormMessage />
              </FormItem>
            )}
          />

          {defaultValues?.id && (
            <FormField
              control={form.control}
              name="isArchived"
              render={({ field }) => (
                <FormItem className="border-destructive/30 flex items-center space-x-3 space-y-0 rounded-lg border p-3">
                  <FormControl>
                    <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                  </FormControl>
                  <FormLabel className="text-sm font-normal">
                    Archive this account
                    <span className="text-muted-foreground ml-1 text-xs font-normal">
                      — removes from portfolio, can restore later
                    </span>
                  </FormLabel>
                  <FormMessage />
                </FormItem>
              )}
            />
          )}
        </div>
        <DialogFooter className="gap-2">
          <DialogTrigger asChild>
            <Button variant="outline">Cancel</Button>
          </DialogTrigger>
          <Button type="submit" disabled={needsSetup && !currentTrackingMode}>
            {defaultValues?.id ? (
              <Icons.Save className="h-4 w-4" />
            ) : (
              <Icons.Plus className="h-4 w-4" />
            )}
            <span>{defaultValues?.id ? "Update Account" : "Add Account"}</span>
          </Button>
        </DialogFooter>
      </form>

      {/* Mode Switch Confirmation Dialog */}
      <AlertDialog open={showModeConfirmation} onOpenChange={setShowModeConfirmation}>
        <AlertDialogContent className="max-w-105 gap-0 overflow-hidden p-0">
          <div className="px-5 pb-4 pt-5">
            <AlertDialogHeader className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-orange-100/30 dark:bg-orange-100/20">
                  <Icons.ArrowRightLeft className="h-4 w-4 text-orange-500 dark:text-orange-300" />
                </div>
                <AlertDialogTitle className="text-base font-semibold">
                  Switch to Transactions mode
                </AlertDialogTitle>
              </div>
              <AlertDialogDescription>
                Your account value and performance history will be rebuilt entirely from
                transactions. Holdings snapshots will no longer be used.
              </AlertDialogDescription>
            </AlertDialogHeader>

            {/* Checklist */}
            <div className="mt-4 rounded-lg border border-orange-100/40 bg-orange-100/30 p-3 dark:border-orange-100/20 dark:bg-orange-100/20">
              <p className="mb-2 text-xs font-medium text-orange-600 dark:text-orange-200">
                Make sure your transactions are complete
              </p>
              <ul className="space-y-2 text-[13px]">
                <li className="flex items-start gap-2">
                  <Icons.Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-500 dark:text-orange-300" />
                  <span className="text-orange-500 dark:text-orange-200">
                    All buys, sells, deposits &amp; withdrawals are recorded
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <Icons.Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-500 dark:text-orange-300" />
                  <span className="text-orange-500 dark:text-orange-200">
                    Dates, quantities &amp; prices are accurate
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <Icons.AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-orange-600 dark:text-orange-300" />
                  <span className="text-orange-500 dark:text-orange-200">
                    Gaps in history will lead to incorrect balances &amp; returns
                  </span>
                </li>
              </ul>
            </div>
          </div>

          <AlertDialogFooter className="bg-muted/30 border-t px-5 py-3">
            <AlertDialogCancel onClick={handleCancelModeSwitch}>Keep Holdings</AlertDialogCancel>
            <Button onClick={handleConfirmModeSwitch}>Switch to Transactions</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Form>
  );
}
