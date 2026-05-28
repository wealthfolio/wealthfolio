import { zodResolver } from "@hookform/resolvers/zod";
import { listFundManagers } from "@/adapters";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { QueryKeys } from "@/lib/query-keys";
import { useSettingsContext } from "@/lib/settings-provider";
import type { FundManager, PrivateAsset } from "@/lib/types";
import { useQuery } from "@tanstack/react-query";
import { useForm, type Resolver, type SubmitHandler } from "react-hook-form";
import * as z from "zod";

import {
  privateAssetStatusOptions,
  privateAssetStrategyOptions,
  privateAssetVehicleKindOptions,
} from "../private-assets-utils";
import { usePrivateAssetMutations } from "../use-private-asset-mutations";
import { getZeroValueSelectionProps } from "./private-form-input-utils";
import { FundManagerEditModal } from "./fund-manager-edit-modal";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Checkbox } from "@wealthfolio/ui/components/ui/checkbox";
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
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";
import { MoneyInput, ResponsiveSelect, type ResponsiveSelectOption } from "@wealthfolio/ui";
import { useEffect, useMemo, useState } from "react";

const optionalNumber = z.preprocess((value) => {
  if (value === "" || value === null || value === undefined) {
    return undefined;
  }

  return typeof value === "string" ? Number(value) : value;
}, z.number().finite().optional());

const privateAssetSchema = z
  .object({
    name: z.string().trim().min(1, "Vehicle name is required"),
    isDirectInvestment: z.boolean(),
    fundManagerId: z.string().optional(),
    vehicleKind: z.enum(["FUND", "CO_INVESTMENT", "REAL_ESTATE", "OTHER"]),
    strategyType: z.enum([
      "VENTURE",
      "PRIVATE_EQUITY",
      "HEDGE_FUND",
      "PRIVATE_CREDIT",
      "FUND_OF_FUNDS",
      "ENERGY",
      "REAL_ESTATE",
      "OTHER",
    ]),
    currency: z.string().trim().min(1, "Currency is required"),
    status: z.enum(["ACTIVE", "REALIZED", "ARCHIVED"]),
    commitmentAmount: optionalNumber,
    notes: z.string().optional(),
  })
  .superRefine((values, ctx) => {
    if (!values.isDirectInvestment && !values.fundManagerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Select a fund manager or mark this asset as direct.",
        path: ["fundManagerId"],
      });
    }
  });

type PrivateAssetFormValues = z.infer<typeof privateAssetSchema>;

function getFormValues(
  asset: PrivateAsset | null | undefined,
  baseCurrency: string,
): PrivateAssetFormValues {
  return {
    name: asset?.name ?? "",
    isDirectInvestment: asset?.vehicleKind === "DIRECT",
    fundManagerId: asset?.fundManagerId ?? "",
    vehicleKind: asset?.vehicleKind && asset.vehicleKind !== "DIRECT" ? asset.vehicleKind : "FUND",
    strategyType: asset?.strategyType ?? "VENTURE",
    currency: baseCurrency,
    status: asset?.status ?? "ACTIVE",
    commitmentAmount: asset?.commitmentAmount ?? undefined,
    notes: asset?.notes ?? "",
  };
}

interface PrivateAssetEditModalProps {
  asset?: PrivateAsset | null;
  open: boolean;
  onClose: () => void;
  onSaved?: (asset: PrivateAsset) => void;
}

export function PrivateAssetEditModal({
  asset,
  open,
  onClose,
  onSaved,
}: PrivateAssetEditModalProps) {
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";
  const { createPrivateAssetMutation, updatePrivateAssetMutation } = usePrivateAssetMutations();
  const [managerModalOpen, setManagerModalOpen] = useState(false);
  const [pendingManagerId, setPendingManagerId] = useState<string | null>(null);

  const { data: fundManagers = [] } = useQuery<FundManager[], Error>({
    queryKey: [QueryKeys.FUND_MANAGERS],
    queryFn: listFundManagers,
  });

  const formValues = useMemo(() => getFormValues(asset, baseCurrency), [asset, baseCurrency]);

  const form = useForm<PrivateAssetFormValues>({
    resolver: zodResolver(privateAssetSchema) as Resolver<PrivateAssetFormValues>,
    defaultValues: formValues,
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    form.reset(formValues);
    setPendingManagerId(null);
  }, [form, formValues, open]);

  useEffect(() => {
    if (!pendingManagerId) {
      return;
    }

    if (!fundManagers.some((manager) => manager.id === pendingManagerId)) {
      return;
    }

    form.setValue("fundManagerId", pendingManagerId, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
    form.clearErrors("fundManagerId");
    setPendingManagerId(null);
  }, [form, fundManagers, pendingManagerId]);

  const isPending = createPrivateAssetMutation.isPending || updatePrivateAssetMutation.isPending;
  const isDirectInvestment = form.watch("isDirectInvestment");

  const fundManagerOptions: ResponsiveSelectOption[] = fundManagers.map((manager) => ({
    label: manager.name,
    value: manager.id,
  }));

  const handleSubmit: SubmitHandler<PrivateAssetFormValues> = async (values) => {
    const normalizedCurrency = values.currency.trim().toUpperCase();
    if (normalizedCurrency !== baseCurrency.toUpperCase()) {
      form.setError("currency", {
        message: `Private assets must use the portfolio base currency (${baseCurrency}) in v1.`,
      });
      return;
    }

    const payload = {
      name: values.name.trim(),
      fundManagerId: values.isDirectInvestment ? null : values.fundManagerId || null,
      vehicleKind: values.isDirectInvestment ? "DIRECT" : values.vehicleKind,
      strategyType: values.strategyType,
      currency: normalizedCurrency,
      status: values.status,
      commitmentAmount: values.commitmentAmount ?? null,
      notes: values.notes?.trim() ? values.notes.trim() : null,
    } as const;

    const saved = asset?.id
      ? await updatePrivateAssetMutation.mutateAsync({
          privateAssetId: asset.id,
          payload,
        })
      : await createPrivateAssetMutation.mutateAsync(payload);

    onSaved?.(saved);
    onClose();
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => !nextOpen && onClose()}
        useIsMobile={useIsMobileViewport}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[680px]">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
              <DialogHeader>
                <DialogTitle>{asset?.id ? "Edit Private Asset" : "Add Private Asset"}</DialogTitle>
                <DialogDescription>
                  Capture the real owned vehicle, not a public-market stand-in. The latest update
                  gets added separately from the detail page.
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-4 md:grid-cols-2">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem className="md:col-span-2">
                      <FormLabel>Vehicle Name</FormLabel>
                      <FormControl>
                        <Input placeholder="e.g. HarbourVest Fund XII" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="isDirectInvestment"
                  render={({ field }) => (
                    <FormItem className="md:col-span-2">
                      <div className="flex items-start gap-3 rounded-md border p-3">
                        <Checkbox
                          checked={field.value}
                          onCheckedChange={(checked) => {
                            const nextValue = checked === true;
                            field.onChange(nextValue);
                            if (nextValue) {
                              form.setValue("fundManagerId", "");
                            }
                          }}
                          className="mt-1"
                        />
                        <div className="space-y-1">
                          <FormLabel className="cursor-pointer">Direct investment</FormLabel>
                          <FormDescription>
                            Use this when the vehicle should not point at a fund manager. Direct
                            assets save with `vehicle_kind = DIRECT`.
                          </FormDescription>
                        </div>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="fundManagerId"
                  render={({ field }) => (
                    <FormItem className="md:col-span-2">
                      <div className="flex items-center justify-between gap-2">
                        <FormLabel>Fund Manager</FormLabel>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => setManagerModalOpen(true)}
                        >
                          <Icons.Plus className="mr-2 h-4 w-4" />
                          New manager
                        </Button>
                      </div>
                      <FormControl>
                        <ResponsiveSelect
                          value={field.value || undefined}
                          onValueChange={field.onChange}
                          options={fundManagerOptions}
                          placeholder={
                            isDirectInvestment
                              ? "Direct investment selected"
                              : fundManagers.length > 0
                                ? "Select a fund manager"
                                : "Create a fund manager first"
                          }
                          sheetTitle="Fund Manager"
                          sheetDescription="Choose the manager tied to this private asset."
                          disabled={isDirectInvestment || fundManagers.length === 0}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="vehicleKind"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Vehicle Kind</FormLabel>
                      <FormControl>
                        <ResponsiveSelect
                          value={field.value}
                          onValueChange={field.onChange}
                          options={
                            privateAssetVehicleKindOptions as unknown as ResponsiveSelectOption[]
                          }
                          placeholder="Select vehicle kind"
                          sheetTitle="Vehicle Kind"
                          sheetDescription="Choose the top-level owned vehicle type."
                          disabled={isDirectInvestment}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="strategyType"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Strategy</FormLabel>
                      <FormControl>
                        <ResponsiveSelect
                          value={field.value}
                          onValueChange={field.onChange}
                          options={
                            privateAssetStrategyOptions as unknown as ResponsiveSelectOption[]
                          }
                          placeholder="Select strategy"
                          sheetTitle="Strategy Type"
                          sheetDescription="Choose the strategy used in the locked v1 contract."
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="currency"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Currency</FormLabel>
                      <FormControl>
                        <Input placeholder="USD" readOnly {...field} />
                      </FormControl>
                      <FormDescription>
                        Private assets use the portfolio base currency in v1. Multi-currency private
                        assets are intentionally out of scope for this slice.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Status</FormLabel>
                      <FormControl>
                        <ResponsiveSelect
                          value={field.value}
                          onValueChange={field.onChange}
                          options={privateAssetStatusOptions as unknown as ResponsiveSelectOption[]}
                          placeholder="Select status"
                          sheetTitle="Status"
                          sheetDescription="Archived assets stay hidden by default in the list."
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="commitmentAmount"
                  render={({ field }) => (
                    <FormItem className="md:col-span-2">
                      <FormLabel>Current Commitment</FormLabel>
                      <FormControl {...getZeroValueSelectionProps(field.value)}>
                        <MoneyInput {...field} placeholder="Optional current commitment" />
                      </FormControl>
                      <FormDescription>
                        Leave blank when commitment is not part of the current v1 record.
                      </FormDescription>
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
                          placeholder="Optional notes about the asset"
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
                  ) : asset?.id ? (
                    "Save changes"
                  ) : (
                    "Create asset"
                  )}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <FundManagerEditModal
        open={managerModalOpen}
        onClose={() => setManagerModalOpen(false)}
        onSaved={(manager) => {
          setPendingManagerId(manager.id);
          form.setValue("fundManagerId", manager.id, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          });
          form.clearErrors("fundManagerId");
          setManagerModalOpen(false);
        }}
      />
    </>
  );
}
