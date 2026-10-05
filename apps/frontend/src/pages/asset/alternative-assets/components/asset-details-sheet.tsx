import {
  LoanSheetContent,
  LoanSheetHeader,
  LoanSheetBody,
  LoanSheetFooter,
} from "./loan-sheet-content";
import { LoanInterestMethodSelect } from "./loan-interest-method-select";
import { LoanFieldInfo } from "./loan-field-info";
import { LoanDurationInput } from "./loan-duration-input";
import { useEffect, useMemo, useState } from "react";
import { useAccounts } from "@/hooks/use-accounts";
import { useLoanSchedulePreview } from "../hooks/use-loan-calculation";
import { loanErrorField, loanErrorText, type LoanSetupField } from "./loan-error-text";
import type { LoanSetup } from "@/adapters/shared/alternative-assets";
import { useForm, type Resolver } from "react-hook-form";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@wealthfolio/ui/components/ui/sheet";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  useFormField,
} from "@wealthfolio/ui/components/ui/form";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Textarea } from "@wealthfolio/ui/components/ui/textarea";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  MoneyInput,
  QuantityInput,
  DatePickerInput,
  ResponsiveSelect,
  type ResponsiveSelectOption,
  useDateFormatting,
} from "@wealthfolio/ui";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";

import {
  assetDetailsSchema,
  type AssetDetailsFormValues,
  type LiabilityDetailsFormValues,
  getDefaultDetailsFormValues,
  formValuesToMetadata,
  PROPERTY_TYPES,
  VEHICLE_TYPES,
  COLLECTIBLE_TYPES,
  METAL_TYPES,
  WEIGHT_UNITS,
  LIABILITY_TYPES,
  liabilityLoanSetup,
} from "./asset-details-sheet-schema";
import { paymentAccounts } from "../lib/loan-payments";
import { type LinkableAsset } from "./alternative-asset-quick-add-modal";
import { AlternativeAssetKind, ALTERNATIVE_ASSET_KIND_DISPLAY_NAMES } from "@/lib/types";

/**
 * Asset data required by the sheet.
 * This can be an Asset or a subset of fields from Holding that we need.
 */
export interface AssetDetailsSheetAsset {
  id: string;
  name: string;
  kind: AlternativeAssetKind;
  currency: string;
  metadata?: Record<string, unknown>;
  notes?: string | null;
}

/** Represents a liability that can be linked from a property */
export interface LinkedLiability {
  id: string;
  name: string;
  balance?: string;
}

interface AssetDetailsSheetProps {
  /** Whether the sheet is open */
  open: boolean;
  /** Callback when the sheet open state changes */
  onOpenChange: (open: boolean) => void;
  /** The asset to view/edit */
  asset: AssetDetailsSheetAsset | null;
  /** Callback when the user saves changes */
  onSave: (
    assetId: string,
    metadata: Record<string, string>,
    name?: string,
    notes?: string | null,
    loan?: LoanSetup,
  ) => Promise<void>;
  /** Optional: For displaying linked asset name for liabilities */
  linkedAssetName?: string;
  /** Optional: For liabilities, list of assets that can be linked */
  linkableAssets?: LinkableAsset[];
  /** Optional: For properties, list of liabilities linked to this asset */
  linkedLiabilities?: LinkedLiability[];
  /** Optional: For properties, list of unlinked mortgages that can be linked */
  availableMortgages?: LinkedLiability[];
  /** Optional: Callback to link a mortgage to this property */
  onLinkMortgage?: (mortgageId: string) => Promise<void>;
  /** Optional: Callback to unlink a mortgage from this property */
  onUnlinkMortgage?: (mortgageId: string) => Promise<void>;
  /** Whether the save operation is in progress */
  isSaving?: boolean;
}

/**
 * A sheet/drawer component for viewing and editing asset details.
 * Displays type-specific fields based on the asset kind.
 */
export function AssetDetailsSheet({
  open,
  onOpenChange,
  asset,
  onSave,
  linkedAssetName,
  linkableAssets = [],
  linkedLiabilities = [],
  availableMortgages = [],
  onLinkMortgage,
  onUnlinkMortgage,
  isSaving = false,
}: AssetDetailsSheetProps) {
  const { t } = useTranslation();
  // Use a fallback kind for the form when asset is null (form state won't be used anyway)
  const assetKind = asset?.kind ?? AlternativeAssetKind.OTHER;
  const assetName = asset?.name ?? "";
  const assetMetadata = asset?.metadata;
  const assetNotes = asset?.notes;

  const form = useForm<AssetDetailsFormValues>({
    resolver: zodResolver(assetDetailsSchema) as Resolver<AssetDetailsFormValues>,
    defaultValues: getDefaultDetailsFormValues(assetKind, assetName, assetMetadata, assetNotes),
  });

  // Reset form when asset changes or sheet opens
  useEffect(() => {
    if (open && asset) {
      form.reset(getDefaultDetailsFormValues(asset.kind, asset.name, asset.metadata, asset.notes));
    }
  }, [open, asset, form]);

  // Build linkable assets options for liability linking
  // NOTE: This must be called before any early returns to maintain hook order
  const linkableAssetOptions: ResponsiveSelectOption[] = useMemo(() => {
    return [
      { value: "__none__", label: t("asset:detailsSheet.none_standalone") },
      ...linkableAssets.map((asset) => ({
        value: asset.id,
        label: asset.name,
      })),
    ];
  }, [linkableAssets, t]);

  // Early return if no asset (after all hooks are called)
  if (!asset) {
    return null;
  }

  const handleSubmit = async (values: AssetDetailsFormValues) => {
    try {
      const metadata = formValuesToMetadata(values);
      // Only pass name if it changed
      const nameChanged = values.name !== asset.name ? values.name : undefined;
      // Pass notes separately (it goes to asset.notes, not metadata). A liability's
      // loan section goes with them: the backend saves the edit in one transaction.
      const loan =
        values.kind === AlternativeAssetKind.LIABILITY ? liabilityLoanSetup(values) : undefined;
      await onSave(asset.id, metadata, nameChanged, values.notes, loan);
      toast({
        title: t("asset:detailsSheet.details_saved"),
        variant: "success",
      });
      onOpenChange(false);
    } catch (error) {
      toast({
        title: t("asset:detailsSheet.save_failed"),
        description: loanErrorText(t, error, "asset:detailsSheet.save_failed_description"),
        variant: "destructive",
      });
    }
  };

  const DetailsContent =
    asset.kind === AlternativeAssetKind.LIABILITY ? LoanSheetContent : SheetContent;
  const isLoan = asset.kind === AlternativeAssetKind.LIABILITY;
  const DetailsHeader = isLoan ? LoanSheetHeader : SheetHeader;
  const DetailsBody = isLoan ? LoanSheetBody : "div";
  const DetailsFooter = isLoan ? LoanSheetFooter : SheetFooter;
  const kindDisplayName = ALTERNATIVE_ASSET_KIND_DISPLAY_NAMES[asset.kind] || asset.kind;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <DetailsContent
        className={
          asset.kind === AlternativeAssetKind.LIABILITY
            ? undefined
            : "w-full overflow-y-auto sm:max-w-lg"
        }
      >
        <DetailsHeader className="pb-4">
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 flex h-10 w-10 items-center justify-center rounded-full">
              <AssetKindIcon kind={asset.kind} className="text-primary" size={20} />
            </div>
            <div className="flex flex-col items-start">
              <SheetTitle className="flex items-center gap-2">
                {t("asset:detailsSheet.edit", { kind: kindDisplayName })}
                <Badge variant="secondary" className="text-xs font-normal">
                  {kindDisplayName}
                </Badge>
              </SheetTitle>
              <SheetDescription className="text-left">
                {asset.kind === AlternativeAssetKind.LIABILITY
                  ? t("asset:detailsSheet.liability_description")
                  : t("asset:detailsSheet.asset_description")}
              </SheetDescription>
            </div>
          </div>
        </DetailsHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(handleSubmit)}
            className={isLoan ? "flex min-h-0 flex-1 flex-col" : "space-y-6 pb-8"}
          >
            <DetailsBody className="space-y-6">
              {/* Name Field */}
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{t("asset:detailsSheet.name")}</FormLabel>
                    <FormControl>
                      <Input
                        placeholder={t("asset:detailsSheet.name_placeholder")}
                        value={field.value}
                        onChange={field.onChange}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {!isLoan && <Separator />}

              {/* Purchase Information - only for assets, not liabilities */}
              {asset.kind !== AlternativeAssetKind.LIABILITY && (
                <>
                  <div className="space-y-4">
                    <SectionHeader
                      title={t("asset:detailsSheet.purchase_information")}
                      description={t("asset:detailsSheet.purchase_information_description")}
                    />

                    <div className="grid gap-4 sm:grid-cols-2">
                      <FormField
                        control={form.control}
                        name="purchasePrice"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>
                              {asset.kind === AlternativeAssetKind.PRECIOUS_METAL
                                ? t("asset:detailsSheet.purchase_price_per_unit")
                                : t("asset:detailsSheet.purchase_price")}
                            </FormLabel>
                            <FormControl>
                              <MoneyInput
                                ref={field.ref}
                                name={field.name}
                                value={field.value}
                                onValueChange={(value) => field.onChange(value ?? null)}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={form.control}
                        name="purchaseDate"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>{t("asset:detailsSheet.purchase_date")}</FormLabel>
                            <FormControl>
                              <DatePickerInput
                                value={field.value ?? undefined}
                                onChange={(date) => field.onChange(date ?? null)}
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                    </div>
                  </div>

                  <Separator />
                </>
              )}

              {/* Liability-specific sections */}
              {isLoan && (
                <LiabilityFields
                  form={form}
                  assetId={asset.id}
                  currency={asset.currency}
                  linkableAssetOptions={linkableAssetOptions}
                  linkedAssetName={linkedAssetName}
                />
              )}

              {/* Type-specific Fields */}
              {!isLoan && (
                <div className="space-y-4">
                  <SectionHeader
                    title={t("asset:detailsSheet.kind_details", { kind: kindDisplayName })}
                    description={getTypeSpecificDescription(asset.kind, t)}
                  />

                  {/* Property-specific fields */}
                  {asset.kind === AlternativeAssetKind.PROPERTY && <PropertyFields form={form} />}

                  {/* Vehicle-specific fields */}
                  {asset.kind === AlternativeAssetKind.VEHICLE && <VehicleFields form={form} />}

                  {/* Collectible-specific fields */}
                  {asset.kind === AlternativeAssetKind.COLLECTIBLE && (
                    <CollectibleFields form={form} />
                  )}

                  {/* Precious Metal-specific fields */}
                  {asset.kind === AlternativeAssetKind.PRECIOUS_METAL && (
                    <PreciousMetalFields form={form} />
                  )}

                  {/* Other asset fields */}
                  {asset.kind === AlternativeAssetKind.OTHER && <OtherFields form={form} />}
                </div>
              )}

              {/* Linked Liabilities Display (for properties) */}
              {asset.kind === AlternativeAssetKind.PROPERTY && (
                <PropertyMortgageSection
                  linkedLiabilities={linkedLiabilities}
                  availableMortgages={availableMortgages}
                  onLinkMortgage={onLinkMortgage}
                  onUnlinkMortgage={onUnlinkMortgage}
                />
              )}

              <Separator />

              {/* Notes Section */}
              <div className="space-y-4">
                <SectionHeader
                  title={t("asset:detailsSheet.notes")}
                  description={t(
                    isLoan
                      ? "asset:detailsSheet.notes_description_liability"
                      : "asset:detailsSheet.notes_description",
                  )}
                />

                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Textarea
                          placeholder={t(
                            isLoan
                              ? "asset:detailsSheet.notes_placeholder_liability"
                              : "asset:detailsSheet.notes_placeholder",
                          )}
                          className="min-h-[100px] resize-none"
                          value={field.value ?? ""}
                          onChange={(e) => field.onChange(e.target.value || null)}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </DetailsBody>
            <DetailsFooter className="gap-2 pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={isSaving}
              >
                {t("common:cancel")}
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving ? (
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Icons.Check className="mr-2 h-4 w-4" />
                )}
                {t("asset:detailsSheet.save_details")}
              </Button>
            </DetailsFooter>
          </form>
        </Form>
      </DetailsContent>
    </Sheet>
  );
}

// ============================================================================
// Helper Components
// ============================================================================

function SectionHeader({
  title,
  description,
  info,
}: {
  title: string;
  description?: string;
  info?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5">
        <h4 className="text-sm font-semibold">{title}</h4>
        {info && <LoanFieldInfo label={title}>{info}</LoanFieldInfo>}
      </div>
      {description && <p className="text-muted-foreground text-xs">{description}</p>}
    </div>
  );
}

function AssetKindIcon({
  kind,
  className,
  size = 20,
}: {
  kind: AlternativeAssetKind;
  className?: string;
  size?: number;
}) {
  switch (kind) {
    case AlternativeAssetKind.PROPERTY:
      return <Icons.RealEstateDuotone size={size} className={className} />;
    case AlternativeAssetKind.VEHICLE:
      return <Icons.VehicleDuotone size={size} className={className} />;
    case AlternativeAssetKind.COLLECTIBLE:
      return <Icons.CollectibleDuotone size={size} className={className} />;
    case AlternativeAssetKind.PRECIOUS_METAL:
      return <Icons.PreciousDuotone size={size} className={className} />;
    case AlternativeAssetKind.LIABILITY:
      return <Icons.LiabilityDuotone size={size} className={className} />;
    default:
      return <Icons.OtherAssetDuotone size={size} className={className} />;
  }
}

function getTypeSpecificDescription(kind: AlternativeAssetKind, t: TFunction): string {
  switch (kind) {
    case AlternativeAssetKind.PROPERTY:
      return t("asset:detailsSheet.description.property");
    case AlternativeAssetKind.VEHICLE:
      return t("asset:detailsSheet.description.vehicle");
    case AlternativeAssetKind.COLLECTIBLE:
      return t("asset:detailsSheet.description.collectible");
    case AlternativeAssetKind.PRECIOUS_METAL:
      return t("asset:detailsSheet.description.precious_metal");
    case AlternativeAssetKind.LIABILITY:
      return t("asset:detailsSheet.description.liability");
    default:
      return t("asset:detailsSheet.description.other");
  }
}

// ============================================================================
// Type-Specific Field Components
// ============================================================================

function PropertyFields({ form }: { form: ReturnType<typeof useForm<AssetDetailsFormValues>> }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name="address"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("asset:detailsSheet.address")}</FormLabel>
            <FormControl>
              <Input
                placeholder={t("asset:detailsSheet.address_placeholder")}
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value || null)}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="propertyType"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("asset:detailsSheet.property_type")}</FormLabel>
            <FormControl>
              <ResponsiveSelect
                value={field.value ?? ""}
                onValueChange={(val) => field.onChange(val || null)}
                options={PROPERTY_TYPES.map((opt) => ({ value: opt.value, label: opt.label }))}
                placeholder={t("asset:detailsSheet.select_property_type")}
                sheetTitle={t("asset:detailsSheet.property_type")}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

function VehicleFields({ form }: { form: ReturnType<typeof useForm<AssetDetailsFormValues>> }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name="vehicleType"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("asset:detailsSheet.vehicle_type")}</FormLabel>
            <FormControl>
              <ResponsiveSelect
                value={field.value ?? ""}
                onValueChange={(val) => field.onChange(val || null)}
                options={VEHICLE_TYPES.map((opt) => ({ value: opt.value, label: opt.label }))}
                placeholder={t("asset:detailsSheet.select_vehicle_type")}
                sheetTitle={t("asset:detailsSheet.vehicle_type")}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="description"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("asset:detailsSheet.make_model_year")}</FormLabel>
            <FormControl>
              <Input
                placeholder={t("asset:detailsSheet.make_model_year_placeholder")}
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value || null)}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

function CollectibleFields({ form }: { form: ReturnType<typeof useForm<AssetDetailsFormValues>> }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name="collectibleType"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("asset:detailsSheet.collectible_type")}</FormLabel>
            <FormControl>
              <ResponsiveSelect
                value={field.value ?? ""}
                onValueChange={(val) => field.onChange(val || null)}
                options={COLLECTIBLE_TYPES.map((opt) => ({ value: opt.value, label: opt.label }))}
                placeholder={t("asset:detailsSheet.select_collectible_type")}
                sheetTitle={t("asset:detailsSheet.collectible_type")}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={form.control}
        name="description"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("asset:detailsSheet.description_label")}</FormLabel>
            <FormControl>
              <Input
                placeholder={t("asset:detailsSheet.collectible_description_placeholder")}
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value || null)}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

function PreciousMetalFields({
  form,
}: {
  form: ReturnType<typeof useForm<AssetDetailsFormValues>>;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <FormField
        control={form.control}
        name="metalType"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("asset:detailsSheet.metal_type")}</FormLabel>
            <FormControl>
              <ResponsiveSelect
                value={field.value ?? ""}
                onValueChange={(val) => field.onChange(val || null)}
                options={METAL_TYPES.map((opt) => ({ value: opt.value, label: opt.label }))}
                placeholder={t("asset:detailsSheet.select_metal")}
                sheetTitle={t("asset:detailsSheet.metal_type")}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          control={form.control}
          name="quantity"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("asset:detailsSheet.quantity")}</FormLabel>
              <FormControl>
                <QuantityInput
                  ref={field.ref}
                  name={field.name}
                  value={field.value}
                  onValueChange={(value) => field.onChange(value ?? null)}
                  placeholder="0"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="unit"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("asset:detailsSheet.unit")}</FormLabel>
              <FormControl>
                <ResponsiveSelect
                  value={field.value ?? ""}
                  onValueChange={(val) => field.onChange(val || null)}
                  options={WEIGHT_UNITS.map((opt) => ({ value: opt.value, label: opt.label }))}
                  placeholder={t("asset:detailsSheet.select_unit")}
                  sheetTitle={t("asset:detailsSheet.weight_unit")}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>

      <FormField
        control={form.control}
        name="description"
        render={({ field }) => (
          <FormItem>
            <FormLabel>{t("asset:detailsSheet.description_label")}</FormLabel>
            <FormControl>
              <Input
                placeholder={t("asset:detailsSheet.metal_description_placeholder")}
                value={field.value ?? ""}
                onChange={(e) => field.onChange(e.target.value || null)}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

function LiabilityFields({
  form,
  assetId,
  currency,
  linkableAssetOptions,
  linkedAssetName,
}: {
  form: ReturnType<typeof useForm<AssetDetailsFormValues>>;
  assetId: string;
  currency: string;
  linkableAssetOptions: ResponsiveSelectOption[];
  linkedAssetName?: string;
}) {
  const { t } = useTranslation();
  const { accounts, isLoading: accountsLoading } = useAccounts();
  const eligibleAccounts = useMemo(() => paymentAccounts(accounts, currency), [accounts, currency]);
  const paymentAccountOptions: ResponsiveSelectOption[] = [
    { value: "__none__", label: t("asset:loanPayments.no_account") },
    ...eligibleAccounts.map((account) => ({ value: account.id, label: account.name })),
  ];
  const dates = useDateFormatting();
  const values = form.watch() as LiabilityDetailsFormValues;
  // An account archived or deactivated since it was chosen no longer pays the loan.
  const storedPaymentAccount = values.paymentAccountId;
  useEffect(() => {
    if (accountsLoading || !storedPaymentAccount) return;
    if (!eligibleAccounts.some((account) => account.id === storedPaymentAccount)) {
      form.setValue("paymentAccountId", null, { shouldDirty: true });
    }
  }, [accountsLoading, eligibleAccounts, form, storedPaymentAccount]);
  const automatic = values.automaticLoan === true;
  const isMortgage = values.liabilityType === "mortgage";
  const durationLabel = t(
    isMortgage ? "asset:loanActions.amortization" : "asset:loanActions.loan_term",
  );
  const { data: schedule, error: scheduleError } = useLoanSchedulePreview(
    assetId,
    values.automaticLoan ? liabilityLoanSetup(values) : null,
  );
  const showsMaturity = isMortgage || !!values.renewalMaturity;
  const previewErrorField =
    scheduleError != null
      ? loanErrorField(
          scheduleError,
          [
            "originalAmount",
            "originationDate",
            "interestRate",
            "paymentAmount",
            "firstPaymentDate",
            "amortization",
            ...(showsMaturity ? (["renewalMaturity"] as const) : []),
          ],
          "amortization",
        )
      : null;
  // A field's own validation message comes first; the preview's would repeat it.
  const previewError = (field: LoanSetupField, name: Parameters<typeof form.getFieldState>[0]) =>
    previewErrorField === field &&
    !form.getFieldState(name, form.formState).error && (
      <p className="text-destructive text-xs" role="alert">
        {loanErrorText(t, scheduleError, "asset:loanEvents.invalid")}
      </p>
    );
  const fieldLabel = (label: string, info?: string) => (
    <div className="flex items-center gap-1.5">
      <FormLabel>{label}</FormLabel>
      {info && <LoanFieldInfo label={label}>{info}</LoanFieldInfo>}
    </div>
  );

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          control={form.control}
          name="liabilityType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("asset:detailsSheet.liability_type")}</FormLabel>
              <FormControl>
                <ResponsiveSelect
                  value={field.value ?? ""}
                  onValueChange={(val) => field.onChange(val || null)}
                  options={LIABILITY_TYPES.map((opt) => ({
                    value: opt.value,
                    label: opt.label,
                  }))}
                  placeholder={t("asset:detailsSheet.select_liability_type")}
                  sheetTitle={t("asset:detailsSheet.liability_type")}
                />
              </FormControl>
              <LoanFormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="linkedAssetId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("asset:detailsSheet.linked_asset")}</FormLabel>
              {linkableAssetOptions.length > 1 ? (
                <FormControl>
                  <ResponsiveSelect
                    value={field.value ?? "__none__"}
                    onValueChange={(val) => field.onChange(val === "__none__" ? null : val)}
                    options={linkableAssetOptions}
                    placeholder={t("asset:detailsSheet.select_asset_to_link")}
                    sheetTitle={t("asset:detailsSheet.link_to_asset")}
                    sheetDescription={t("asset:detailsSheet.link_to_asset_description")}
                  />
                </FormControl>
              ) : linkedAssetName ? (
                <div className="bg-muted/30 flex h-9 items-center gap-2 rounded-md border px-3">
                  <Icons.Link className="text-muted-foreground h-4 w-4" />
                  <span className="truncate text-sm font-medium">{linkedAssetName}</span>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  {t("asset:detailsSheet.no_assets_to_link")}
                </p>
              )}
              <LoanFormMessage />
            </FormItem>
          )}
        />
      </div>

      <Separator />

      <div className="space-y-4">
        <SectionHeader
          title={t("asset:loanActions.original_terms")}
          info={automatic ? t("asset:loanActions.edit_terms_hint") : undefined}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="originalAmount"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("asset:detailsSheet.original_amount")}</FormLabel>
                <FormControl>
                  <MoneyInput
                    ref={field.ref}
                    name={field.name}
                    value={field.value}
                    onValueChange={(value) => field.onChange(value ?? null)}
                  />
                </FormControl>
                {previewError("originalAmount", "originalAmount")}
                <LoanFormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="originationDate"
            render={({ field }) => (
              <FormItem>
                {fieldLabel(
                  t("asset:detailsSheet.origination_date"),
                  t("asset:loanActions.origination_hint"),
                )}
                <FormControl>
                  <DatePickerInput
                    value={field.value ?? undefined}
                    onChange={(date) => field.onChange(date ?? null)}
                  />
                </FormControl>
                {previewError("originationDate", "originationDate")}
                <LoanFormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="interestRate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("asset:detailsSheet.interest_rate")}</FormLabel>
                <div className="relative">
                  <FormControl>
                    <QuantityInput
                      ref={field.ref}
                      name={field.name}
                      value={field.value}
                      onValueChange={(value) => field.onChange(value ?? null)}
                      maxDecimalPlaces={2}
                      className="pr-8"
                    />
                  </FormControl>
                  <span className="text-muted-foreground pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm">
                    %
                  </span>
                </div>
                {previewError("interestRate", "interestRate")}
                <LoanFormMessage />
              </FormItem>
            )}
          />
          {automatic && (
            <FormField
              control={form.control}
              name="interestMethod"
              render={({ field }) => (
                <FormItem>
                  {fieldLabel(t("asset:loanInterest.method"), t("asset:loanInterest.hint"))}
                  <LoanInterestMethodSelect value={field.value} onChange={field.onChange} />
                  <LoanFormMessage />
                </FormItem>
              )}
            />
          )}
        </div>
      </div>

      <Separator />

      <div className="space-y-4">
        <SectionHeader title={t("asset:loanActions.payments")} />
        <FormField
          control={form.control}
          name="automaticLoan"
          render={({ field }) => (
            <FormItem className="flex flex-row items-center justify-between gap-4 space-y-0 rounded-lg border p-3">
              <div className="space-y-1">
                <FormLabel>{t("asset:loanActions.automatic_schedule")}</FormLabel>
                <FormDescription className="text-xs">
                  {t("asset:loanActions.automatic_schedule_description")}
                </FormDescription>
              </div>
              <FormControl>
                <Switch
                  checked={field.value === true}
                  onCheckedChange={(checked) => field.onChange(checked)}
                />
              </FormControl>
            </FormItem>
          )}
        />

        {automatic && (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="paymentAmount"
              render={({ field }) => (
                <FormItem>
                  {fieldLabel(t("asset:valueHistory.payment"), t("asset:loanActions.payment_hint"))}
                  <FormControl>
                    <MoneyInput
                      ref={field.ref}
                      name={field.name}
                      value={field.value}
                      onValueChange={(value) => field.onChange(value ?? null)}
                    />
                  </FormControl>
                  {previewError("paymentAmount", "paymentAmount")}
                  <LoanFormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="paymentFrequency"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("asset:loanActions.payment_frequency")}</FormLabel>
                  <FormControl>
                    <ResponsiveSelect
                      value={field.value ?? "monthly"}
                      onValueChange={field.onChange}
                      options={["monthly", "biweekly", "accelerated_biweekly"].map((value) => ({
                        value,
                        label: t(`asset:loanActions.${value}`),
                      }))}
                      sheetTitle={t("asset:loanActions.payment_frequency")}
                    />
                  </FormControl>
                  <LoanFormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="firstPaymentDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("asset:loanActions.first_payment_date")}</FormLabel>
                  <FormControl>
                    <DatePickerInput
                      value={field.value ?? undefined}
                      onChange={(date) => field.onChange(date ?? null)}
                    />
                  </FormControl>
                  {previewError("firstPaymentDate", "firstPaymentDate")}
                  <LoanFormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="amortizationYears"
              render={({ field }) => (
                <FormItem>
                  {fieldLabel(
                    durationLabel,
                    t(
                      isMortgage
                        ? "asset:loanActions.amortization_hint"
                        : "asset:loanActions.loan_term_hint",
                    ),
                  )}
                  <FormControl>
                    <LoanDurationInput
                      label={durationLabel}
                      years={field.value}
                      months={values.amortizationMonths}
                      onYearsChange={(value) => field.onChange(value ?? null)}
                      onMonthsChange={(value) =>
                        form.setValue("amortizationMonths", value ?? null, {
                          shouldDirty: true,
                        })
                      }
                    />
                  </FormControl>
                  {schedule && (
                    <FormDescription className="text-xs">
                      {t("asset:loanActions.last_payment", {
                        count: schedule.paymentCount,
                        date: dates.formatCalendarDate(schedule.lastPaymentDate, {
                          day: "numeric",
                          month: "short",
                          year: "numeric",
                        }),
                      })}
                    </FormDescription>
                  )}
                  {previewError("amortization", "amortizationYears")}
                  <LoanFormMessage />
                </FormItem>
              )}
            />
            {showsMaturity && (
              <FormField
                control={form.control}
                name="renewalMaturity"
                render={({ field }) => (
                  <FormItem>
                    {fieldLabel(
                      t("asset:loanActions.renewal_maturity"),
                      t("asset:loanActions.renewal_maturity_hint"),
                    )}
                    <FormControl>
                      <DatePickerInput
                        value={field.value ?? undefined}
                        onChange={(date) => field.onChange(date ?? null)}
                      />
                    </FormControl>
                    {previewError("renewalMaturity", "renewalMaturity")}
                    <LoanFormMessage />
                  </FormItem>
                )}
              />
            )}
            <FormField
              control={form.control}
              name="paymentAccountId"
              render={({ field }) => (
                <FormItem>
                  {fieldLabel(
                    t("asset:loanPayments.paid_from"),
                    t("asset:loanPayments.paid_from_hint"),
                  )}
                  <FormControl>
                    <ResponsiveSelect
                      // A value missing from the options would be reported back as empty.
                      value={
                        eligibleAccounts.find((account) => account.id === field.value)?.id ??
                        "__none__"
                      }
                      onValueChange={(value) =>
                        field.onChange(value && value !== "__none__" ? value : null)
                      }
                      options={paymentAccountOptions}
                      sheetTitle={t("asset:loanPayments.paid_from")}
                      aria-label={t("asset:loanPayments.paid_from")}
                    />
                  </FormControl>
                  <LoanFormMessage />
                </FormItem>
              )}
            />
            {values.paymentAccountId && (
              <FormField
                control={form.control}
                name="escrowAmount"
                render={({ field }) => (
                  <FormItem>
                    {fieldLabel(
                      t("asset:loanPayments.escrow"),
                      t("asset:loanPayments.escrow_hint"),
                    )}
                    <FormControl>
                      <MoneyInput
                        ref={field.ref}
                        name={field.name}
                        value={field.value}
                        aria-label={t("asset:loanPayments.escrow")}
                        onValueChange={(value) => field.onChange(value ?? null)}
                      />
                    </FormControl>
                    <LoanFormMessage />
                  </FormItem>
                )}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** Shows a field error, translating the loan schema's message keys. */
function LoanFormMessage() {
  const { t } = useTranslation();
  const { error, formMessageId } = useFormField();
  const message = error?.message;
  if (!message) return null;
  return (
    <p id={formMessageId} className="text-destructive text-xs font-light">
      {message.startsWith("asset:") ? t(message) : message}
    </p>
  );
}

function OtherFields({ form }: { form: ReturnType<typeof useForm<AssetDetailsFormValues>> }) {
  const { t } = useTranslation();
  return (
    <FormField
      control={form.control}
      name="description"
      render={({ field }) => (
        <FormItem>
          <FormLabel>{t("asset:detailsSheet.description_label")}</FormLabel>
          <FormControl>
            <Input
              placeholder={t("asset:detailsSheet.other_description_placeholder")}
              value={field.value ?? ""}
              onChange={(e) => field.onChange(e.target.value || null)}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

/**
 * Section for managing mortgage links on a property.
 * Shows linked mortgages with unlink option and allows linking available mortgages.
 */
function PropertyMortgageSection({
  linkedLiabilities,
  availableMortgages,
  onLinkMortgage,
  onUnlinkMortgage,
}: {
  linkedLiabilities: LinkedLiability[];
  availableMortgages: LinkedLiability[];
  onLinkMortgage?: (mortgageId: string) => Promise<void>;
  onUnlinkMortgage?: (mortgageId: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [isLinking, setIsLinking] = useState(false);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);
  const [showLinkSelect, setShowLinkSelect] = useState(false);
  const [selectedMortgageId, setSelectedMortgageId] = useState<string>("");

  const handleLink = async () => {
    if (!selectedMortgageId || !onLinkMortgage) return;
    setIsLinking(true);
    try {
      await onLinkMortgage(selectedMortgageId);
      setSelectedMortgageId("");
      setShowLinkSelect(false);
    } finally {
      setIsLinking(false);
    }
  };

  const handleUnlink = async (mortgageId: string) => {
    if (!onUnlinkMortgage) return;
    setUnlinkingId(mortgageId);
    try {
      await onUnlinkMortgage(mortgageId);
    } finally {
      setUnlinkingId(null);
    }
  };

  // Don't show anything if there are no linked liabilities and no available mortgages
  if (linkedLiabilities.length === 0 && availableMortgages.length === 0) {
    return null;
  }

  return (
    <>
      <Separator />
      <div className="space-y-4">
        <SectionHeader
          title={t("asset:detailsSheet.linked_mortgage")}
          description={t("asset:detailsSheet.linked_mortgage_description")}
        />

        {/* Display linked liabilities with unlink option */}
        {linkedLiabilities.length > 0 && (
          <div className="bg-muted/30 space-y-2 rounded-lg border p-3">
            {linkedLiabilities.map((liability) => (
              <div key={liability.id} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <Icons.Link className="text-muted-foreground h-4 w-4" />
                  <span className="font-medium">{liability.name}</span>
                </div>
                <div className="flex items-center gap-2">
                  {liability.balance && (
                    <span className="text-muted-foreground">-{liability.balance}</span>
                  )}
                  {onUnlinkMortgage && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleUnlink(liability.id)}
                      disabled={unlinkingId === liability.id}
                      className="h-7 px-2"
                    >
                      {unlinkingId === liability.id ? (
                        <Icons.Spinner className="h-3 w-3 animate-spin" />
                      ) : (
                        <Icons.X className="h-3 w-3" />
                      )}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Link existing mortgage section */}
        {availableMortgages.length > 0 && onLinkMortgage && (
          <div className="space-y-3">
            {!showLinkSelect ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowLinkSelect(true)}
                className="w-full"
              >
                <Icons.Link className="mr-2 h-4 w-4" />
                {t("asset:detailsSheet.link_existing_mortgage")}
              </Button>
            ) : (
              <div className="space-y-2">
                <ResponsiveSelect
                  value={selectedMortgageId}
                  onValueChange={setSelectedMortgageId}
                  options={availableMortgages.map((m) => ({
                    value: m.id,
                    label: m.name + (m.balance ? ` (${m.balance})` : ""),
                  }))}
                  placeholder={t("asset:detailsSheet.select_mortgage_to_link")}
                  sheetTitle={t("asset:detailsSheet.link_mortgage")}
                  sheetDescription={t("asset:detailsSheet.link_mortgage_description")}
                />
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setShowLinkSelect(false);
                      setSelectedMortgageId("");
                    }}
                    className="flex-1"
                  >
                    {t("common:cancel")}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleLink}
                    disabled={!selectedMortgageId || isLinking}
                    className="flex-1"
                  >
                    {isLinking ? (
                      <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Icons.Check className="mr-2 h-4 w-4" />
                    )}
                    {t("asset:detailsSheet.link")}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
