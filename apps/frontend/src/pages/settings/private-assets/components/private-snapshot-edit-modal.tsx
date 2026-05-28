import { zodResolver } from "@hookform/resolvers/zod";
import { formatDateISO } from "@/lib/utils";
import { useIsMobileViewport } from "@/hooks/use-platform";
import type { PrivateSnapshot } from "@/lib/types";
import { useForm, type Resolver, type SubmitHandler } from "react-hook-form";
import { useEffect, useMemo, useRef } from "react";
import * as z from "zod";

import {
  getPrivateStatementAmountLabel,
  privateSnapshotCashFlowTypeOptions,
  privateSnapshotValueSourceOptions,
} from "../private-assets-utils";
import { usePrivateAssetMutations } from "../use-private-asset-mutations";
import { getZeroValueSelectionProps } from "./private-form-input-utils";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Dialog, DialogContent } from "@wealthfolio/ui/components/ui/dialog";
import {
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@wealthfolio/ui/components/ui/form";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";
import {
  DatePickerInput,
  MoneyInput,
  ResponsiveSelect,
  type ResponsiveSelectOption,
} from "@wealthfolio/ui";

const requiredNumber = z.preprocess((value) => {
  if (value === "" || value === null || value === undefined) {
    return undefined;
  }

  return typeof value === "string" ? Number(value) : value;
}, z.number().finite());

const snapshotSchema = z.object({
  contributedAmount: requiredNumber,
  distributedAmount: requiredNumber,
  cashFlowType: z
    .enum(["TOTAL_TO_DATE", "PERIOD_ONLY"])
    .optional()
    .refine((value) => value !== undefined, "Statement basis is required"),
  currentValue: requiredNumber,
  asOfDate: z.date({
    required_error: "As-of date is required",
  }),
  valueSourceType: z.enum(["MANUAL", "STATEMENT", "ESTIMATED"]),
  notes: z.string().optional(),
});

interface SnapshotFormValues {
  contributedAmount?: number;
  distributedAmount?: number;
  cashFlowType?: "TOTAL_TO_DATE" | "PERIOD_ONLY";
  currentValue?: number;
  asOfDate: Date;
  valueSourceType: "MANUAL" | "STATEMENT" | "ESTIMATED";
  notes?: string;
}

interface PrivateSnapshotEditModalProps {
  privateAssetId: string;
  snapshot?: PrivateSnapshot | null;
  latestSnapshot?: PrivateSnapshot | null;
  latestTotalToDateSnapshot?: PrivateSnapshot | null;
  open: boolean;
  onClose: () => void;
}

export function getLastMonthEnd(referenceDate = new Date()) {
  return new Date(referenceDate.getFullYear(), referenceDate.getMonth(), 0);
}

export function getLastQuarterEnd(referenceDate = new Date()) {
  const currentQuarterStartMonth = Math.floor(referenceDate.getMonth() / 3) * 3;
  return new Date(referenceDate.getFullYear(), currentQuarterStartMonth, 0);
}

export function getDefaultStatementCashFlows(
  cashFlowType: "TOTAL_TO_DATE" | "PERIOD_ONLY",
  latestTotalToDateSnapshot?: PrivateSnapshot | null,
) {
  return {
    contributedAmount:
      cashFlowType === "TOTAL_TO_DATE" ? (latestTotalToDateSnapshot?.contributedAmount ?? 0) : 0,
    distributedAmount:
      cashFlowType === "TOTAL_TO_DATE" ? (latestTotalToDateSnapshot?.distributedAmount ?? 0) : 0,
  };
}

export function buildSnapshotFormValues(
  snapshot?: PrivateSnapshot | null,
  latestSnapshot?: PrivateSnapshot | null,
  latestTotalToDateSnapshot?: PrivateSnapshot | null,
  today = new Date(),
): SnapshotFormValues {
  if (snapshot) {
    return {
      contributedAmount: snapshot.contributedAmount,
      distributedAmount: snapshot.distributedAmount,
      cashFlowType: snapshot.cashFlowType,
      currentValue: snapshot.currentValue,
      asOfDate: new Date(`${snapshot.asOfDate}T00:00:00`),
      valueSourceType: snapshot.valueSourceType,
      notes: snapshot.notes ?? "",
    };
  }

  const cashFlowType = "TOTAL_TO_DATE";
  const cashFlowDefaults = getDefaultStatementCashFlows(cashFlowType, latestTotalToDateSnapshot);

  return {
    contributedAmount: cashFlowDefaults.contributedAmount,
    distributedAmount: cashFlowDefaults.distributedAmount,
    cashFlowType,
    currentValue: latestSnapshot?.currentValue,
    asOfDate: getLastMonthEnd(today),
    valueSourceType: latestSnapshot?.valueSourceType ?? "STATEMENT",
    notes: "",
  };
}

export function PrivateSnapshotEditModal({
  privateAssetId,
  snapshot,
  latestSnapshot,
  latestTotalToDateSnapshot,
  open,
  onClose,
}: PrivateSnapshotEditModalProps) {
  const { createPrivateSnapshotMutation, updatePrivateSnapshotMutation } =
    usePrivateAssetMutations();

  const formValues = useMemo(
    () => buildSnapshotFormValues(snapshot, latestSnapshot, latestTotalToDateSnapshot),
    [latestSnapshot, latestTotalToDateSnapshot, snapshot],
  );

  const form = useForm<SnapshotFormValues>({
    resolver: zodResolver(snapshotSchema) as Resolver<SnapshotFormValues>,
    defaultValues: formValues,
  });

  const isPending =
    createPrivateSnapshotMutation.isPending || updatePrivateSnapshotMutation.isPending;
  const selectedCashFlowType = form.watch("cashFlowType") ?? "TOTAL_TO_DATE";
  const previousCashFlowTypeRef = useRef<SnapshotFormValues["cashFlowType"]>(
    formValues.cashFlowType,
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    form.reset(formValues);
    previousCashFlowTypeRef.current = formValues.cashFlowType;
  }, [form, formValues, open]);

  useEffect(() => {
    if (!open || snapshot?.id || !selectedCashFlowType) {
      return;
    }

    // Ignore the stale watched value from the previous modal session until the
    // reset-on-open values have actually landed in the form state.
    if (selectedCashFlowType !== form.getValues("cashFlowType")) {
      return;
    }

    if (previousCashFlowTypeRef.current === selectedCashFlowType) {
      return;
    }

    const defaultCashFlows = getDefaultStatementCashFlows(
      selectedCashFlowType,
      latestTotalToDateSnapshot,
    );

    form.setValue("contributedAmount", defaultCashFlows.contributedAmount);
    form.setValue("distributedAmount", defaultCashFlows.distributedAmount);

    previousCashFlowTypeRef.current = selectedCashFlowType;
  }, [form, latestTotalToDateSnapshot, open, selectedCashFlowType, snapshot?.id]);

  const handleSubmit: SubmitHandler<SnapshotFormValues> = async (values) => {
    if (!values.cashFlowType) {
      form.setError("cashFlowType", { message: "Statement basis is required" });
      return;
    }

    const payload = {
      contributedAmount: values.contributedAmount ?? 0,
      distributedAmount: values.distributedAmount ?? 0,
      cashFlowType: values.cashFlowType,
      currentValue: values.currentValue ?? 0,
      asOfDate: formatDateISO(values.asOfDate),
      valueSourceType: values.valueSourceType,
      notes: values.notes?.trim() ? values.notes.trim() : null,
    };

    if (snapshot?.id) {
      await updatePrivateSnapshotMutation.mutateAsync({
        privateSnapshotId: snapshot.id,
        privateAssetId,
        payload,
      });
    } else {
      await createPrivateSnapshotMutation.mutateAsync({
        privateAssetId,
        ...payload,
      });
    }

    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      useIsMobile={useIsMobileViewport}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[620px]">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
            <DialogHeader>
              <DialogTitle>{snapshot?.id ? "Edit Statement" : "Add Statement"}</DialogTitle>
              <DialogDescription>
                Record the reported values from this statement. Most private fund statements show
                QTD, YTD, and ITD side by side, so keep the default if you are entering the ITD /
                inception-to-date column and only switch it when you are entering period activity
                instead.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="currentValue"
                render={({ field }) => (
                  <FormItem className="space-y-0 md:col-span-2 md:grid md:grid-cols-2 md:gap-x-4 md:gap-y-2">
                    <div className="space-y-2">
                      <FormLabel>Current Value</FormLabel>
                      <FormControl {...getZeroValueSelectionProps(field.value)}>
                        <MoneyInput {...field} autoFocus={!snapshot?.id} />
                      </FormControl>
                    </div>
                    <div aria-hidden="true" className="hidden md:block" />
                    <FormDescription className="md:col-span-2 md:max-w-[42rem]">
                      Use the partner&apos;s ending capital / ending NAV from the statement, not the
                      gross look-through investment detail.
                    </FormDescription>
                    <FormMessage className="md:col-span-2" />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="contributedAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {getPrivateStatementAmountLabel(selectedCashFlowType, "contributed")}
                    </FormLabel>
                    <FormControl {...getZeroValueSelectionProps(field.value)}>
                      <MoneyInput {...field} />
                    </FormControl>
                    <FormDescription>
                      {selectedCashFlowType === "PERIOD_ONLY"
                        ? "Enter only this statement period's contribution activity."
                        : "Enter the ITD / inception-to-date contribution amount from the statement."}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="distributedAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {getPrivateStatementAmountLabel(selectedCashFlowType, "distributed")}
                    </FormLabel>
                    <FormControl {...getZeroValueSelectionProps(field.value)}>
                      <MoneyInput {...field} />
                    </FormControl>
                    <FormDescription>
                      {selectedCashFlowType === "PERIOD_ONLY"
                        ? "Enter only this statement period's distribution activity."
                        : "Enter the ITD / inception-to-date distribution amount from the statement."}
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="cashFlowType"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>Contribution / Distribution Basis</FormLabel>
                    <FormControl>
                      <ResponsiveSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        options={
                          privateSnapshotCashFlowTypeOptions as unknown as ResponsiveSelectOption[]
                        }
                        placeholder="Choose how this statement reports cash flows"
                        sheetTitle="Contribution / Distribution Basis"
                        sheetDescription="Choose whether these amounts come from the statement's ITD / inception-to-date column or only from the period activity column such as MTD, QTD, or YTD."
                      />
                    </FormControl>
                    <FormDescription>
                      If the statement shows QTD, YTD, and ITD together, use the ITD /
                      inception-to-date column.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="asOfDate"
                render={({ field }) => (
                  <FormItem>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <FormLabel>As-Of Date</FormLabel>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            form.setValue("asOfDate", getLastMonthEnd(), {
                              shouldDirty: true,
                              shouldTouch: true,
                              shouldValidate: true,
                            })
                          }
                        >
                          Last month
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            form.setValue("asOfDate", getLastQuarterEnd(), {
                              shouldDirty: true,
                              shouldTouch: true,
                              shouldValidate: true,
                            })
                          }
                        >
                          Last quarter
                        </Button>
                      </div>
                    </div>
                    <FormControl>
                      <DatePickerInput value={field.value} onChange={field.onChange} />
                    </FormControl>
                    <FormDescription>
                      Default to the last month-end, since private statements usually arrive on a
                      lag.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="valueSourceType"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>Value Source</FormLabel>
                    <FormControl>
                      <ResponsiveSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        options={
                          privateSnapshotValueSourceOptions as unknown as ResponsiveSelectOption[]
                        }
                        placeholder="Select source"
                        sheetTitle="Value Source"
                        sheetDescription="Estimated values show as estimated; statement and manual values use freshness rules."
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={4}
                        placeholder="Optional notes for this statement"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
                Cancel
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? (
                  <span className="flex items-center gap-2">
                    <Icons.Spinner className="h-4 w-4 animate-spin" />
                    Saving
                  </span>
                ) : snapshot?.id ? (
                  "Save changes"
                ) : (
                  "Save statement"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
