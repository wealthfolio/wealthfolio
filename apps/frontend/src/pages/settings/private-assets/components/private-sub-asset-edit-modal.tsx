import { zodResolver } from "@hookform/resolvers/zod";
import { useIsMobileViewport } from "@/hooks/use-platform";
import type { PrivateSubAsset } from "@/lib/types";
import { useForm, type Resolver, type SubmitHandler } from "react-hook-form";
import * as z from "zod";

import {
  privateAssetStrategyOptions,
  privateSubAssetReportingBasisOptions,
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
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@wealthfolio/ui/components/ui/form";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";
import { MoneyInput, ResponsiveSelect, type ResponsiveSelectOption } from "@wealthfolio/ui";

const optionalNumber = z.preprocess((value) => {
  if (value === "" || value === null || value === undefined) {
    return undefined;
  }

  return typeof value === "string" ? Number(value) : value;
}, z.number().finite().optional());

const privateSubAssetSchema = z.object({
  name: z.string().trim().min(1, "Sub-asset name is required"),
  reportingBasis: z.enum(["UNKNOWN", "GROSS", "NET"]),
  strategyType: z
    .enum([
      "VENTURE",
      "PRIVATE_EQUITY",
      "HEDGE_FUND",
      "PRIVATE_CREDIT",
      "FUND_OF_FUNDS",
      "ENERGY",
      "REAL_ESTATE",
      "OTHER",
    ])
    .optional()
    .or(z.literal("")),
  costBasis: optionalNumber,
  currentValue: optionalNumber,
  ownershipPercent: optionalNumber,
  notes: z.string().optional(),
});

type PrivateSubAssetFormValues = z.infer<typeof privateSubAssetSchema>;

interface PrivateSubAssetEditModalProps {
  privateAssetId: string;
  subAsset?: PrivateSubAsset | null;
  open: boolean;
  onClose: () => void;
}

export function PrivateSubAssetEditModal({
  privateAssetId,
  subAsset,
  open,
  onClose,
}: PrivateSubAssetEditModalProps) {
  const { createPrivateSubAssetMutation, updatePrivateSubAssetMutation } =
    usePrivateAssetMutations();

  const form = useForm<PrivateSubAssetFormValues>({
    resolver: zodResolver(privateSubAssetSchema) as Resolver<PrivateSubAssetFormValues>,
    values: {
      name: subAsset?.name ?? "",
      reportingBasis: subAsset?.reportingBasis ?? "UNKNOWN",
      strategyType: subAsset?.strategyType ?? "",
      costBasis: subAsset?.costBasis ?? undefined,
      currentValue: subAsset?.currentValue ?? undefined,
      ownershipPercent: subAsset?.ownershipPercent ?? undefined,
      notes: subAsset?.notes ?? "",
    },
  });

  const isPending =
    createPrivateSubAssetMutation.isPending || updatePrivateSubAssetMutation.isPending;

  const handleSubmit: SubmitHandler<PrivateSubAssetFormValues> = async (values) => {
    const payload = {
      privateAssetId,
      name: values.name.trim(),
      reportingBasis: values.reportingBasis,
      strategyType: values.strategyType || null,
      costBasis: values.costBasis ?? null,
      currentValue: values.currentValue ?? null,
      ownershipPercent: values.ownershipPercent ?? null,
      notes: values.notes?.trim() ? values.notes.trim() : null,
    };

    if (subAsset?.id) {
      await updatePrivateSubAssetMutation.mutateAsync({
        privateSubAssetId: subAsset.id,
        privateAssetId,
        payload: {
          name: payload.name,
          reportingBasis: payload.reportingBasis,
          strategyType: payload.strategyType,
          costBasis: payload.costBasis,
          currentValue: payload.currentValue,
          ownershipPercent: payload.ownershipPercent,
          notes: payload.notes,
        },
      });
    } else {
      await createPrivateSubAssetMutation.mutateAsync(payload);
    }

    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => !nextOpen && onClose()}
      useIsMobile={useIsMobileViewport}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[640px]">
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6">
            <DialogHeader>
              <DialogTitle>{subAsset?.id ? "Edit Sub-Asset" : "Add Sub-Asset"}</DialogTitle>
              <DialogDescription>
                Sub-assets are optional one-level look-through detail only. They do not roll into
                totals in v1.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 md:grid-cols-2">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem className="md:col-span-2">
                    <FormLabel>Sub-Asset Name</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Portfolio Company A" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="reportingBasis"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Reporting Basis</FormLabel>
                    <FormControl>
                      <ResponsiveSelect
                        value={field.value}
                        onValueChange={field.onChange}
                        options={
                          privateSubAssetReportingBasisOptions as unknown as ResponsiveSelectOption[]
                        }
                        placeholder="Select reporting basis"
                        sheetTitle="Reporting Basis"
                        sheetDescription="Track whether the statement reports gross, net, or unknown detail."
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
                        value={field.value || undefined}
                        onValueChange={field.onChange}
                        options={privateAssetStrategyOptions as unknown as ResponsiveSelectOption[]}
                        placeholder="Optional strategy"
                        sheetTitle="Strategy"
                        sheetDescription="Add this only if the statement gives a clear sub-asset strategy."
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="costBasis"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Cost Basis</FormLabel>
                    <FormControl {...getZeroValueSelectionProps(field.value)}>
                      <MoneyInput {...field} placeholder="Optional" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="currentValue"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Current Value</FormLabel>
                    <FormControl {...getZeroValueSelectionProps(field.value)}>
                      <MoneyInput {...field} placeholder="Optional" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="ownershipPercent"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ownership %</FormLabel>
                    <FormControl {...getZeroValueSelectionProps(field.value)}>
                      <Input type="number" step="0.01" placeholder="Optional" {...field} />
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
                        placeholder="Optional notes about this sub-asset"
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
                ) : subAsset?.id ? (
                  "Save changes"
                ) : (
                  "Add sub-asset"
                )}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
