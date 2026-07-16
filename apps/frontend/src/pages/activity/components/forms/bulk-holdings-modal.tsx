import { ActivityType, QuoteMode } from "@/lib/constants";
import { buildAssetResolutionInput } from "@/lib/asset-resolution-input";
import { useSettingsContext } from "@/lib/settings-provider";
import { Account, ActivityBulkMutationRequest, ActivityCreate } from "@/lib/types";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Form,
} from "@wealthfolio/ui";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { FormProvider, useForm, type Resolver, type SubmitHandler } from "react-hook-form";
import { z } from "zod";
import { useActivityMutations } from "../../hooks/use-activity-mutations";
import { BulkHoldingsForm } from "./bulk-holdings-form";
import { bulkHoldingsFormSchema } from "./schemas";

type BulkHoldingsFormValues = z.infer<typeof bulkHoldingsFormSchema>;

interface BulkHoldingsModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
  defaultAccount?: Account;
}

export const BulkHoldingsModal = ({
  open,
  onClose,
  onSuccess,
  defaultAccount,
}: BulkHoldingsModalProps) => {
  const { t } = useTranslation(["activity"]);
  const { saveActivitiesMutation } = useActivityMutations();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";

  const form = useForm<BulkHoldingsFormValues>({
    resolver: zodResolver(bulkHoldingsFormSchema) as Resolver<BulkHoldingsFormValues>,
    mode: "onSubmit",
    defaultValues: {
      accountId: "",
      activityDate: new Date(),
      currency: baseCurrency,
      comment: "",
      holdings: [
        {
          id: "1",
          ticker: "",
          name: "",
          assetId: "",
          quoteMode: QuoteMode.MARKET,
        },
      ],
    },
  });

  // Watch holdings for UI state management
  const watchedHoldings = form.watch("holdings");
  const hasValidHoldings =
    watchedHoldings?.some(
      (holding) =>
        holding.ticker && Number(holding.sharesOwned) > 0 && Number(holding.averageCost) > 0,
    ) || false;

  // Reset form when modal is closed and handle initial focus
  useEffect(() => {
    if (!open) {
      form.reset();
      return;
    }

    if (defaultAccount) {
      form.setValue("accountId", defaultAccount.id, { shouldValidate: true });
      form.setValue("currency", defaultAccount.currency, { shouldValidate: true });
    } else if (!form.getValues("currency")) {
      form.setValue("currency", baseCurrency, { shouldValidate: false });
    }

    // When modal opens, focus the account field with proper timing (only if no default)
    const timeoutId = setTimeout(() => {
      if (!defaultAccount) {
        form.setFocus("accountId");
      }
    }, 150);

    return () => clearTimeout(timeoutId);
  }, [open, baseCurrency, defaultAccount, form]);

  // Account change handler
  const handleAccountChange = useCallback(
    (account: Account | null) => {
      form.setValue("accountId", account?.id || "", {
        shouldValidate: true,
        shouldDirty: true,
      });
      form.setValue("currency", account?.currency || baseCurrency, {
        shouldValidate: true,
        shouldDirty: true,
      });
    },
    [baseCurrency, form],
  );

  const handleSubmit: SubmitHandler<BulkHoldingsFormValues> = useCallback(
    async (data) => {
      // Validate holdings data
      const validHoldings = data.holdings.filter(
        (holding) =>
          holding.ticker?.trim() &&
          Number(holding.sharesOwned) > 0 &&
          Number(holding.averageCost) > 0,
      );

      if (!validHoldings.length) {
        toast({
          title: t("activity:form.toast_no_valid_holdings"),
          description: t("activity:form.toast_no_valid_holdings_desc"),
          variant: "destructive",
        });
        return;
      }

      const activityDate =
        data.activityDate instanceof Date ? data.activityDate : new Date(data.activityDate);
      const currency = data.currency || baseCurrency;

      const creates: ActivityCreate[] = validHoldings.map((holding) => ({
        accountId: data.accountId,
        activityType: ActivityType.TRANSFER_IN,
        activityDate: activityDate.toISOString(),
        asset: buildAssetResolutionInput({
          id: holding.assetId,
          symbol: (holding.ticker || holding.assetId || "").toUpperCase().trim(),
          exchangeMic: holding.exchangeMic || undefined,
          name: holding.name?.trim() || undefined,
          kind: holding.assetKind?.trim() || undefined,
          quoteMode: holding.quoteMode ?? QuoteMode.MARKET,
          quoteCcy: holding.symbolQuoteCcy || undefined,
          instrumentType: holding.symbolInstrumentType || undefined,
        }),
        quantity: Number(holding.sharesOwned),
        unitPrice: Number(holding.averageCost),
        // Unit price is book cost basis. Transfer-date market value is derived
        // from quotes by the valuation resolver; do not persist a synthetic
        // amount here.
        amount: null,
        currency,
        fee: 0,
        comment: data.comment?.trim() || undefined,
        // Mark as external transfer (affects net_contribution like add holding)
        metadata: { flow: { is_external: true } },
      }));

      const request: ActivityBulkMutationRequest = { creates };

      try {
        const result = await saveActivitiesMutation.mutateAsync(request);

        const hasErrors = (result.errors?.length ?? 0) > 0;
        const hasSuccesses = (result.created?.length ?? 0) > 0;

        if (hasErrors) {
          const description = result.errors
            .slice(0, 3)
            .map((err) => err.message)
            .join("\n");

          toast({
            title: hasSuccesses
              ? t("activity:form.toast_some_holdings_failed")
              : t("activity:form.toast_failed_to_save_holdings"),
            description,
            variant: "destructive",
          });

          if (!hasSuccesses) {
            return;
          }
        }

        toast({
          title: t("activity:form.toast_holdings_saved"),
          description: t("activity:form.toast_holdings_saved_desc"),
          variant: "success",
        });
        form.reset();
        onSuccess?.();
        onClose();
      } catch {
        // Error handling is managed by the mutation hook toast.
      }
    },
    [baseCurrency, form, onClose, onSuccess, saveActivitiesMutation, t],
  );

  const handleFormError = useCallback(
    (errors: Record<string, any>) => {
      const findFirstMessage = (value: unknown): string | null => {
        if (!value || typeof value !== "object") return null;

        if (Array.isArray(value)) {
          for (const item of value) {
            const msg = findFirstMessage(item);
            if (msg) return msg;
          }
          return null;
        }

        const record = value as Record<string, unknown>;
        if (typeof record.message === "string" && record.message.trim()) {
          return record.message;
        }

        for (const nested of Object.values(record)) {
          const msg = findFirstMessage(nested);
          if (msg) return msg;
        }

        return null;
      };

      const errorMessage = findFirstMessage(errors) || t("activity:form.toast_check_form_errors");

      toast({
        title: t("activity:form.toast_form_validation_failed"),
        description: errorMessage,
        variant: "destructive",
      });
    },
    [t],
  );

  const isSubmitDisabled =
    saveActivitiesMutation.isPending || !hasValidHoldings || !form.watch("accountId");

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="max-h-[90vh] w-full overflow-y-auto sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>{t("activity:form.bulk_add_existing_title")}</DialogTitle>
          <DialogDescription>{t("activity:form.bulk_add_existing_desc")}</DialogDescription>
        </DialogHeader>

        <FormProvider {...form}>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit, handleFormError)} className="space-y-6">
              <div className="py-4">
                <BulkHoldingsForm
                  onAccountChange={handleAccountChange}
                  defaultAccount={defaultAccount}
                />
              </div>

              {/* Display validation errors */}
              {Object.keys(form.formState.errors).length > 0 && (
                <div className="border-destructive/50 bg-destructive/10 rounded-lg border p-4">
                  <h4 className="text-destructive mb-2 text-sm font-medium">
                    {t("activity:form.bulk_fix_errors")}
                  </h4>
                  <ul className="text-destructive/80 space-y-1 text-sm">
                    {form.formState.errors.accountId && (
                      <li>• {form.formState.errors.accountId.message}</li>
                    )}
                    {form.formState.errors.activityDate && (
                      <li>• {form.formState.errors.activityDate.message}</li>
                    )}
                    {form.formState.errors.holdings && (
                      <li>• {form.formState.errors.holdings.message}</li>
                    )}
                  </ul>
                </div>
              )}

              <DialogFooter>
                <Button type="button" variant="outline" onClick={onClose}>
                  {t("activity:cancel")}
                </Button>
                <Button
                  type="submit"
                  disabled={isSubmitDisabled}
                  data-testid="bulk-holdings-confirm"
                >
                  {saveActivitiesMutation.isPending
                    ? t("activity:form.button_saving")
                    : t("activity:confirm")}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </FormProvider>
      </DialogContent>
    </Dialog>
  );
};
