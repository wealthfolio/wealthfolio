import { useEffect } from "react";
import { useForm, type Resolver } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { zodResolver } from "@hookform/resolvers/zod";
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
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { MoneyInput, DatePickerInput } from "@wealthfolio/ui";

import {
  updateValuationSchema,
  type UpdateValuationFormValues,
  getUpdateValuationDefaultValues,
} from "./update-valuation-schema";
import { useAlternativeAssetMutations } from "../hooks/use-alternative-asset-mutations";
import { formatAmount } from "@/lib/utils";

interface UpdateValuationModalProps {
  /** Whether the modal is open */
  open: boolean;
  /** Callback when the modal open state changes */
  onOpenChange: (open: boolean) => void;
  /** The asset ID to update valuation for */
  assetId: string;
  /** The asset name for display */
  assetName: string;
  /** Current recorded value as decimal string */
  currentValue: string;
  /** Last updated date as ISO string (YYYY-MM-DD) */
  lastUpdatedDate: string;
  /** Currency code (e.g., "USD") */
  currency: string;
}

/**
 * Modal for updating the valuation of an alternative asset.
 * Shows current value with last updated date and allows entering a new value.
 */
export function UpdateValuationModal({
  open,
  onOpenChange,
  assetId,
  assetName,
  currentValue,
  lastUpdatedDate,
  currency,
}: UpdateValuationModalProps) {
  const { t } = useTranslation();
  const { updateValuationMutation } = useAlternativeAssetMutations({
    onUpdateSuccess: () => {
      handleClose();
    },
  });

  const form = useForm<UpdateValuationFormValues>({
    resolver: zodResolver(updateValuationSchema) as Resolver<UpdateValuationFormValues>,
    defaultValues: getUpdateValuationDefaultValues(currentValue),
  });

  // Reset form when modal opens with current values
  useEffect(() => {
    if (open) {
      form.reset(getUpdateValuationDefaultValues(currentValue));
    }
  }, [open, currentValue, form]);

  const handleClose = () => {
    form.reset();
    onOpenChange(false);
  };

  const onSubmit = async (data: UpdateValuationFormValues) => {
    await updateValuationMutation.mutateAsync({
      assetId,
      request: {
        value: data.value.toString(),
        date: formatDateToISO(data.date),
        notes: data.notes || undefined,
      },
    });
  };

  const isLoading = updateValuationMutation.isPending;

  // Format the current value for display
  const formattedCurrentValue = formatAmount(parseFloat(currentValue) || 0, currency);

  // Format the last updated date for display
  const formattedLastUpdatedDate = formatDisplayDate(lastUpdatedDate);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <DialogHeader>
              <DialogTitle>{t("asset:updateValuation.title", { name: assetName })}</DialogTitle>
              <DialogDescription>{t("asset:updateValuation.description")}</DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {/* Current Value Display */}
              <div className="bg-muted rounded-md p-4">
                <div className="text-muted-foreground text-sm">
                  {t("asset:updateValuation.current_recorded_value")}
                </div>
                <div className="text-xl font-semibold">{formattedCurrentValue}</div>
                <div className="text-muted-foreground mt-1 text-xs">
                  {t("asset:updateValuation.last_updated", { date: formattedLastUpdatedDate })}
                </div>
              </div>

              {/* New Value Input */}
              <FormField
                control={form.control}
                name="value"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("asset:updateValuation.new_value")}</FormLabel>
                    <FormControl>
                      <MoneyInput
                        ref={field.ref}
                        name={field.name}
                        value={field.value}
                        onValueChange={field.onChange}
                        placeholder="0.00"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* As of Date Input */}
              <FormField
                control={form.control}
                name="date"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("asset:updateValuation.as_of_date")}</FormLabel>
                    <FormControl>
                      <DatePickerInput value={field.value} onChange={field.onChange} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Notes Field (optional) */}
              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      {t("asset:updateValuation.notes")}{" "}
                      <span className="text-muted-foreground">
                        {t("asset:updateValuation.optional")}
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Textarea
                        rows={3}
                        placeholder={t("asset:updateValuation.notes_placeholder")}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={handleClose} disabled={isLoading}>
                {t("common:cancel")}
              </Button>
              <Button type="submit" disabled={isLoading}>
                {isLoading ? (
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Icons.Check className="mr-2 h-4 w-4" />
                )}
                {t("asset:updateValuation.update_value")}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Helper to format date to ISO string (YYYY-MM-DD)
 */
function formatDateToISO(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Helper to format ISO date string for display
 */
function formatDisplayDate(isoDate: string): string {
  if (!isoDate) return "N/A";
  try {
    const date = new Date(isoDate + "T00:00:00");
    return date.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return isoDate;
  }
}
