import { initialLoanProjection } from "../lib/loan-schedule";
import { LoanInterestMethodSelect } from "./loan-interest-method-select";
import { useState, useMemo, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "motion/react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Checkbox } from "@wealthfolio/ui/components/ui/checkbox";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  CurrencyInput,
  DatePickerInput,
  ResponsiveSelect,
  MoneyInput,
  QuantityInput,
  useDateFormatting,
} from "@wealthfolio/ui";
import { cn } from "@/lib/utils";
import { useSettingsContext } from "@/lib/settings-provider";

import {
  METAL_TYPES,
  LIABILITY_TYPES,
  WEIGHT_UNITS,
  liabilityQuickAddSchema,
} from "./alternative-asset-quick-add-schema";
import { useAlternativeAssetMutations } from "../hooks/use-alternative-asset-mutations";
import { addDays, addMonths } from "date-fns";
import { LOAN_PROJECTION_METADATA_KEY, serializeLoanProjectionMetadata } from "../lib/loan-events";
import {
  calculateAmortizationSchedule,
  calculateLoanEndDate,
  calculateLoanPayment,
  calculatePaymentCount,
} from "../lib/loan-calculator";
import { LoanFieldInfo } from "./loan-field-info";
import { LoanDurationInput } from "./loan-duration-input";
import type { LoanInterestMethod, LoanPaymentFrequency } from "../lib/loan-events";
import {
  AlternativeAssetKind,
  type CreateAlternativeAssetRequest,
  type AlternativeAssetKindApi,
} from "@/lib/types";

/** Simple type for assets that can be linked to liabilities */
export interface LinkableAsset {
  id: string;
  name: string;
}

// Asset type configuration using theme colors; labels/descriptions resolved via i18n
const ASSET_TYPES = [
  {
    kind: AlternativeAssetKind.PROPERTY,
    labelKey: "asset:quickAdd.assetType.property_label",
    descriptionKey: "asset:quickAdd.assetType.property_description",
    icon: Icons.RealEstateDuotone,
    iconColor: "text-green-400",
    selectedBg: "bg-green-400/15",
    borderColor: "border-green-400/50",
  },
  {
    kind: AlternativeAssetKind.VEHICLE,
    labelKey: "asset:quickAdd.assetType.vehicle_label",
    descriptionKey: "asset:quickAdd.assetType.vehicle_description",
    icon: Icons.VehicleDuotone,
    iconColor: "text-blue-400",
    selectedBg: "bg-blue-400/15",
    borderColor: "border-blue-400/50",
  },
  {
    kind: AlternativeAssetKind.COLLECTIBLE,
    labelKey: "asset:quickAdd.assetType.collectible_label",
    descriptionKey: "asset:quickAdd.assetType.collectible_description",
    icon: Icons.CollectibleDuotone,
    iconColor: "text-purple-400",
    selectedBg: "bg-purple-400/15",
    borderColor: "border-purple-400/50",
  },
  {
    kind: AlternativeAssetKind.PRECIOUS_METAL,
    labelKey: "asset:quickAdd.assetType.precious_metal_label",
    descriptionKey: "asset:quickAdd.assetType.precious_metal_description",
    icon: Icons.PreciousDuotone,
    iconColor: "text-orange-400",
    selectedBg: "bg-orange-400/15",
    borderColor: "border-orange-400/50",
  },
  {
    kind: AlternativeAssetKind.LIABILITY,
    labelKey: "asset:quickAdd.assetType.liability_label",
    descriptionKey: "asset:quickAdd.assetType.liability_description",
    icon: Icons.LiabilityDuotone,
    iconColor: "text-red-400",
    selectedBg: "bg-red-400/15",
    borderColor: "border-red-400/50",
  },
  {
    kind: AlternativeAssetKind.OTHER,
    labelKey: "asset:quickAdd.assetType.other_label",
    descriptionKey: "asset:quickAdd.assetType.other_description",
    icon: Icons.OtherAssetDuotone,
    iconColor: "text-base-500",
    selectedBg: "bg-base-500/15",
    borderColor: "border-base-500/50",
  },
];

// Map internal kind to API kind
const kindToApiKind: Record<AlternativeAssetKind, AlternativeAssetKindApi> = {
  [AlternativeAssetKind.PROPERTY]: "property",
  [AlternativeAssetKind.VEHICLE]: "vehicle",
  [AlternativeAssetKind.COLLECTIBLE]: "collectible",
  [AlternativeAssetKind.PRECIOUS_METAL]: "precious",
  [AlternativeAssetKind.LIABILITY]: "liability",
  [AlternativeAssetKind.OTHER]: "other",
};

interface FormData {
  kind: AlternativeAssetKind;
  name: string;
  currency: string;
  currentValue: string;
  valueDate: Date;
  purchasePrice?: string;
  purchaseDate?: Date;
  metalType?: string;
  quantity?: string;
  unit?: string;
  liabilityType?: string;
  hasMortgage?: boolean;
  linkedAssetId?: string;
  /** Amortization or loan term, entered as years plus months. */
  loanTerm?: string;
  loanTermMonths?: string;
  interestRate?: string;
  paymentFrequency?: LoanPaymentFrequency;
  interestMethod?: LoanInterestMethod;
  automaticSchedule?: boolean;
  firstPaymentDate?: Date;
}

interface AlternativeAssetQuickAddModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultKind?: AlternativeAssetKind;
  /** Keep creation scoped to the preset kind in contextual flows. */
  allowKindChange?: boolean;
  linkableAssets?: LinkableAsset[];
  linkedAssetId?: string;
  /** Default liability type (e.g., "mortgage" when chained from property) */
  defaultLiabilityType?: string;
  /** Default origination date for liability (e.g., from property purchase date) */
  defaultOriginationDate?: Date;
  /** Default name for liability (e.g., "Beach House Mortgage") */
  defaultName?: string;
  onAssetCreated?: (response: { assetId: string }) => void;
  /** Callback to open liability creation modal (chained from property with mortgage checkbox) */
  onOpenLiabilityQuickAdd?: (
    linkedAssetId: string,
    purchaseDate?: Date,
    propertyName?: string,
  ) => void;
}

export function AlternativeAssetQuickAddModal({
  open,
  onOpenChange,
  defaultKind,
  allowKindChange = true,
  linkableAssets = [],
  linkedAssetId: initialLinkedAssetId,
  defaultLiabilityType,
  defaultOriginationDate,
  defaultName,
  onAssetCreated,
  onOpenLiabilityQuickAdd,
}: AlternativeAssetQuickAddModalProps) {
  const { t } = useTranslation();
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";

  const [step, setStep] = useState<1 | 2>(1);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [formData, setFormData] = useState<FormData>({
    kind: defaultKind || AlternativeAssetKind.PROPERTY,
    name: "",
    currency: baseCurrency,
    currentValue: "",
    valueDate: new Date(),
    linkedAssetId: initialLinkedAssetId,
    liabilityType: defaultLiabilityType ?? "mortgage",
    automaticSchedule: true,
    paymentFrequency: "monthly",
  });

  const { createMutation } = useAlternativeAssetMutations();

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      // Skip step 1 if a defaultKind is provided
      setStep(defaultKind ? 2 : 1);
      setValidationError(null);
      setFormData({
        kind: defaultKind || AlternativeAssetKind.PROPERTY,
        name: defaultName || "",
        currency: baseCurrency,
        currentValue: "",
        valueDate: defaultOriginationDate || new Date(),
        // A mortgage added for a property starts when the property was bought.
        purchaseDate: defaultOriginationDate,
        linkedAssetId: initialLinkedAssetId,
        liabilityType: defaultLiabilityType ?? "mortgage",
        automaticSchedule: true,
        paymentFrequency: "monthly",
      });
    }
  }, [
    open,
    defaultKind,
    initialLinkedAssetId,
    defaultLiabilityType,
    defaultOriginationDate,
    defaultName,
    baseCurrency,
  ]);

  const selectedAssetType = useMemo(
    () => ASSET_TYPES.find((t) => t.kind === formData.kind),
    [formData.kind],
  );

  const handleAssetTypeSelect = useCallback((kind: AlternativeAssetKind) => {
    setFormData((prev) => ({
      ...prev,
      kind,
    }));
  }, []);

  const updateFormData = useCallback(
    (field: keyof FormData, value: string | boolean | Date | number | undefined) => {
      // Convert numbers to strings for numeric fields
      const finalValue =
        typeof value === "number" ? String(value) : value === undefined ? "" : value;
      setFormData((prev) => ({ ...prev, [field]: finalValue }));
    },
    [],
  );

  const dates = useDateFormatting();
  const automaticSchedule = formData.automaticSchedule !== false;
  const isMortgage = (formData.liabilityType || "mortgage") === "mortgage";
  const durationLabel = t(
    isMortgage ? "asset:loanActions.amortization" : "asset:loanActions.loan_term",
  );
  const loanTermMonths =
    (Number(formData.loanTerm) || 0) * 12 + (Number(formData.loanTermMonths) || 0);
  const paymentFrequency = formData.paymentFrequency ?? "monthly";
  const firstPaymentDate =
    formData.firstPaymentDate ??
    (formData.purchaseDate
      ? paymentFrequency === "monthly"
        ? addMonths(formData.purchaseDate, 1)
        : addDays(formData.purchaseDate, 14)
      : undefined);
  const amortizationSchedule = calculateAmortizationSchedule(
    firstPaymentDate,
    loanTermMonths,
    paymentFrequency,
  );

  const canProceed = useMemo(() => {
    if (step === 1) return true;
    const isLiability = formData.kind === AlternativeAssetKind.LIABILITY;
    if (isLiability) {
      const hasBalance = Boolean(formData.currentValue || formData.purchasePrice);
      const hasRequiredDates = Boolean(formData.purchaseDate || formData.valueDate);
      const hasAutomaticTerms =
        !formData.automaticSchedule ||
        Boolean(formData.purchasePrice && formData.purchaseDate && loanTermMonths > 0);
      return formData.name.trim() && hasBalance && hasRequiredDates && hasAutomaticTerms;
    }
    return formData.name.trim() && formData.currentValue;
  }, [
    step,
    formData.name,
    formData.currentValue,
    formData.kind,
    formData.purchasePrice,
    formData.purchaseDate,
    formData.valueDate,
    loanTermMonths,
    formData.automaticSchedule,
  ]);

  const [resolvingPayment, setResolvingPayment] = useState(false);
  const handleSubmit = async () => {
    if (!canProceed || resolvingPayment || createMutation.isPending) return;

    const metadata: Record<string, string> = {};
    const isLiability = formData.kind === AlternativeAssetKind.LIABILITY;
    const annualRate = formData.interestRate ? parseFloat(formData.interestRate) : 0;
    let currentValue =
      isLiability && !formData.currentValue
        ? (formData.purchasePrice ?? formData.currentValue)
        : formData.currentValue;
    let totalPaymentCount = 0;
    let balanceQuoteDate = formData.valueDate;

    if (isLiability) {
      const validation = liabilityQuickAddSchema.safeParse({
        originalAmount: formData.automaticSchedule
          ? formData.purchasePrice
          : formData.purchasePrice || formData.currentValue,
        currentBalance: formData.currentValue || undefined,
        originationDate: formData.purchaseDate || formData.valueDate,
        balanceDate: formData.valueDate,
        loanTermMonths: loanTermMonths || undefined,
        interestRate: formData.interestRate || undefined,
      });
      if (!validation.success) {
        const issue = validation.error.issues[0]?.message;
        setValidationError(
          issue?.startsWith("asset:") ? issue : "asset:quickAdd.validation.invalid",
        );
        return;
      }
      if (
        formData.automaticSchedule &&
        (!formData.purchasePrice || !formData.purchaseDate || loanTermMonths <= 0)
      ) {
        setValidationError("asset:quickAdd.validation.invalid");
        return;
      }
    }
    setValidationError(null);

    // Use unified 'sub_type' field for all asset types
    if (formData.kind === AlternativeAssetKind.PRECIOUS_METAL) {
      if (formData.metalType) metadata.sub_type = formData.metalType;
      if (formData.quantity) metadata.quantity = formData.quantity;
      if (formData.unit) metadata.unit = formData.unit;
    }

    if (isLiability) {
      if (!formData.automaticSchedule) metadata.tracking_mode = "manual";
      metadata.sub_type = formData.liabilityType ?? "mortgage";
      if (formData.purchasePrice) metadata.original_amount = formData.purchasePrice;
      if (formData.purchaseDate && formData.automaticSchedule) {
        metadata.origination_date = formatDateToISO(formData.purchaseDate);
      }
      if (formData.interestRate) metadata.interest_rate = formData.interestRate;
      if (formData.automaticSchedule && loanTermMonths > 0 && formData.purchaseDate) {
        const frequency = paymentFrequency;
        totalPaymentCount = calculatePaymentCount(loanTermMonths / 12, frequency) ?? 0;
        if (totalPaymentCount === 0 || !firstPaymentDate) {
          setValidationError("asset:quickAdd.validation.invalid");
          return;
        }
        if (firstPaymentDate <= formData.purchaseDate) {
          setValidationError("asset:quickAdd.validation.invalid");
          return;
        }
        const computedEndDate = calculateLoanEndDate(
          firstPaymentDate,
          totalPaymentCount,
          frequency,
        );
        if (!computedEndDate) return;
        // An omitted balance is not a confirmed estimate. Anchor at the original
        // principal; shared core derives today's balance without storing payments.
        if (!formData.currentValue.trim()) {
          currentValue = formData.purchasePrice!;
          balanceQuoteDate = formData.purchaseDate;
        }
        const effectivePayment = calculateLoanPayment({
          principal: parseFloat(formData.purchasePrice!),
          annualRate,
          paymentCount: totalPaymentCount,
          frequency,
          interestMethod: formData.interestMethod,
        });
        if (effectivePayment === null) {
          setValidationError("asset:quickAdd.validation.invalid");
          return;
        }
        setResolvingPayment(true);
        try {
          const projection = await initialLoanProjection(metadata, {
            version: 1,
            annualRate,
            paymentAmount: effectivePayment,
            frequency,
            interestMethod: formData.interestMethod ?? "nominal_periodic",
            firstPaymentDate: formatDateToISO(firstPaymentDate),
            paymentCount: totalPaymentCount,
            amortizationEndDate: formatDateToISO(computedEndDate),
          });
          metadata[LOAN_PROJECTION_METADATA_KEY] = serializeLoanProjectionMetadata(projection);
        } catch {
          setValidationError("asset:quickAdd.validation.invalid");
          return;
        } finally {
          setResolvingPayment(false);
        }
      }
    }

    const request: CreateAlternativeAssetRequest = {
      kind: kindToApiKind[formData.kind],
      name: formData.name,
      currency: formData.currency,
      currentValue,
      valueDate: formatDateToISO(balanceQuoteDate),
      // Only entered opening/current balances create liability quotes.
      // Historical and future instalments are calculated from metadata.
      purchasePrice: !isLiability ? formData.purchasePrice || undefined : undefined,
      purchaseDate:
        !isLiability && formData.purchaseDate ? formatDateToISO(formData.purchaseDate) : undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      linkedAssetId: formData.linkedAssetId || undefined,
    };

    const response = await createMutation.mutateAsync(request);

    onAssetCreated?.(response);
    onOpenChange(false);
    if (formData.hasMortgage && onOpenLiabilityQuickAdd) {
      setTimeout(() => {
        onOpenLiabilityQuickAdd(response.assetId, formData.purchaseDate, formData.name);
      }, 100);
    }
  };

  // Build linkable assets options for liability form (only actual assets, no "none" option)
  const linkableAssetOptions = useMemo(() => {
    return linkableAssets.map((asset) => ({
      value: asset.id,
      label: asset.name,
    }));
  }, [linkableAssets]);

  const getValueLabel = () => {
    if (formData.kind === AlternativeAssetKind.LIABILITY)
      return t("asset:quickAdd.current_balance");
    return t("asset:quickAdd.current_value");
  };

  const getPlaceholder = () => {
    switch (formData.kind) {
      case AlternativeAssetKind.PROPERTY:
        return t("asset:quickAdd.placeholder.property");
      case AlternativeAssetKind.VEHICLE:
        return t("asset:quickAdd.placeholder.vehicle");
      case AlternativeAssetKind.PRECIOUS_METAL:
        return t("asset:quickAdd.placeholder.precious_metal");
      case AlternativeAssetKind.LIABILITY:
        return t("asset:quickAdd.placeholder.liability");
      case AlternativeAssetKind.COLLECTIBLE:
        return t("asset:quickAdd.placeholder.collectible");
      default:
        return t("asset:quickAdd.placeholder.default");
    }
  };

  const isSubmitting = createMutation.isPending || resolvingPayment;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]"
        mobileClassName="flex h-[90vh] flex-col"
      >
        {/* Header with progress indicator */}
        <DialogHeader className="shrink-0 border-b px-6 py-4">
          <div className="flex flex-col items-center space-y-2 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
            <DialogTitle className="text-foreground text-lg font-semibold">
              {step === 1
                ? t("asset:quickAdd.add_new_asset")
                : selectedAssetType
                  ? t(selectedAssetType.labelKey)
                  : ""}
            </DialogTitle>
            <div className="flex items-center gap-1.5">
              <div
                className={cn(
                  "h-1.5 w-10 rounded-full transition-colors duration-300",
                  step >= 1 ? "bg-primary" : "bg-muted",
                )}
              />
              <div
                className={cn(
                  "h-1.5 w-10 rounded-full transition-colors duration-300",
                  step >= 2 ? "bg-primary" : "bg-muted",
                )}
              />
            </div>
          </div>
          <p className="text-muted-foreground text-sm">
            {step === 1
              ? t("asset:quickAdd.select_type_subtitle")
              : formData.kind === AlternativeAssetKind.LIABILITY
                ? t("asset:quickAdd.liability_subtitle")
                : t("asset:quickAdd.asset_details_subtitle")}
          </p>
        </DialogHeader>

        {/* Content area with animations */}
        <div className="relative min-h-0 flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            {step === 1 ? (
              <motion.div
                key="step1"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.2 }}
                className="p-4"
              >
                {/* Asset Type Grid */}
                <div className="grid grid-cols-2 gap-3">
                  {ASSET_TYPES.map((type) => {
                    const Icon = type.icon;
                    const isSelected = formData.kind === type.kind;

                    return (
                      <motion.button
                        key={type.kind}
                        type="button"
                        onClick={() => handleAssetTypeSelect(type.kind)}
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        className={cn(
                          "relative flex flex-col items-start rounded-xl border-2 p-4 text-left transition-all duration-200",
                          "hover:shadow-md",
                          isSelected
                            ? cn(type.borderColor, type.selectedBg)
                            : "border-border/50 bg-secondary/30 hover:border-border hover:bg-secondary/50",
                        )}
                      >
                        {isSelected && (
                          <motion.div
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            className="absolute right-2 top-2"
                          >
                            <div className="bg-primary flex h-5 w-5 items-center justify-center rounded-full">
                              <Icons.Check className="text-primary-foreground h-3 w-3" />
                            </div>
                          </motion.div>
                        )}
                        <div
                          className={cn(
                            "mb-3 flex h-10 w-10 items-center justify-center rounded-lg",
                            isSelected ? type.selectedBg : "bg-muted",
                          )}
                        >
                          <Icon size={20} className={type.iconColor} />
                        </div>
                        <span
                          className={cn(
                            "text-sm font-medium",
                            isSelected ? "text-foreground" : "text-foreground/80",
                          )}
                        >
                          {t(type.labelKey)}
                        </span>
                        <span className="text-muted-foreground mt-0.5 text-xs">
                          {t(type.descriptionKey)}
                        </span>
                      </motion.button>
                    );
                  })}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="step2"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.2 }}
                className="space-y-3 p-4"
              >
                {/* Type-specific fields */}
                {formData.kind === AlternativeAssetKind.PRECIOUS_METAL && (
                  <>
                    <div className="space-y-2">
                      <Label className="text-foreground text-sm font-medium">
                        {t("asset:quickAdd.metal_type")}
                      </Label>
                      <ResponsiveSelect
                        value={formData.metalType || "gold"}
                        onValueChange={(v) => updateFormData("metalType", v)}
                        options={METAL_TYPES.map((metal) => ({
                          value: metal.value,
                          label: metal.label,
                        }))}
                        placeholder={t("asset:quickAdd.select_metal")}
                        sheetTitle={t("asset:quickAdd.select_metal_title")}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label className="text-foreground text-sm font-medium">
                          {t("asset:quickAdd.quantity")}
                        </Label>
                        <QuantityInput
                          value={formData.quantity || ""}
                          onValueChange={(v) => updateFormData("quantity", v)}
                          placeholder="0"
                          className="h-11"
                        />
                      </div>
                      <div className="space-y-2">
                        <Label className="text-foreground text-sm font-medium">
                          {t("asset:quickAdd.unit")}
                        </Label>
                        <ResponsiveSelect
                          value={formData.unit || "oz"}
                          onValueChange={(v) => updateFormData("unit", v)}
                          options={WEIGHT_UNITS.map((unit) => ({
                            value: unit.value,
                            label: unit.label,
                          }))}
                          placeholder={t("asset:quickAdd.select_unit")}
                          sheetTitle={t("asset:quickAdd.select_unit_title")}
                        />
                      </div>
                    </div>
                  </>
                )}

                {formData.kind === AlternativeAssetKind.LIABILITY && (
                  <div className="space-y-2">
                    <Label className="text-foreground text-sm font-medium">
                      {t("asset:quickAdd.liability_type")}
                    </Label>
                    <ResponsiveSelect
                      value={formData.liabilityType || "mortgage"}
                      onValueChange={(v) => updateFormData("liabilityType", v)}
                      options={LIABILITY_TYPES.map((type) => ({
                        value: type.value,
                        label: type.label,
                      }))}
                      placeholder={t("asset:quickAdd.select_type")}
                      sheetTitle={t("asset:quickAdd.select_liability_type_title")}
                    />
                  </div>
                )}

                {/* Name field */}
                <div className="space-y-2">
                  <Label className="text-foreground text-sm font-medium">
                    {t("asset:quickAdd.name")}
                  </Label>
                  <Input
                    value={formData.name}
                    onChange={(e) => updateFormData("name", e.target.value)}
                    placeholder={getPlaceholder()}
                    className="h-11"
                  />
                </div>

                {/* Currency row */}
                <div className="space-y-2">
                  <Label className="text-foreground text-sm font-medium">
                    {t("asset:quickAdd.currency")}
                  </Label>
                  <CurrencyInput
                    value={formData.currency}
                    onChange={(v) => updateFormData("currency", v)}
                    placeholder={t("asset:quickAdd.select_currency")}
                  />
                </div>

                {/* For liabilities: how the balance is tracked, then the original terms */}
                {formData.kind === AlternativeAssetKind.LIABILITY && (
                  <>
                    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
                      <div className="space-y-1">
                        <Label
                          htmlFor="automaticSchedule"
                          className="text-foreground cursor-pointer text-sm font-medium"
                        >
                          {t("asset:loanActions.automatic_schedule")}
                        </Label>
                        <p className="text-muted-foreground text-xs">
                          {t("asset:loanActions.automatic_schedule_description")}
                        </p>
                      </div>
                      <Switch
                        id="automaticSchedule"
                        checked={automaticSchedule}
                        onCheckedChange={(checked) => updateFormData("automaticSchedule", checked)}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label className="text-foreground text-sm font-medium">
                          {t("asset:quickAdd.original_amount")}
                        </Label>
                        <MoneyInput
                          value={formData.purchasePrice || ""}
                          onValueChange={(value) => updateFormData("purchasePrice", value)}
                          className="h-11"
                        />
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5">
                          <Label className="text-foreground text-sm font-medium">
                            {t("asset:quickAdd.origination_date")}
                          </Label>
                          <LoanFieldInfo label={t("asset:quickAdd.origination_date")}>
                            {t("asset:loanActions.origination_hint")}
                          </LoanFieldInfo>
                        </div>
                        <DatePickerInput
                          value={formData.purchaseDate}
                          onChange={(date) => date && updateFormData("purchaseDate", date)}
                        />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label className="text-foreground text-sm font-medium">
                          {t("asset:quickAdd.interest_rate")}
                          <span className="text-muted-foreground ml-1 text-xs font-normal">
                            {t("asset:quickAdd.optional")}
                          </span>
                        </Label>
                        <div className="relative">
                          <QuantityInput
                            value={formData.interestRate || ""}
                            onValueChange={(v) => updateFormData("interestRate", v)}
                            placeholder="0"
                            className="h-11 pr-8"
                          />
                          <span className="text-muted-foreground pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm">
                            %
                          </span>
                        </div>
                      </div>
                      {automaticSchedule && (
                        <div className="space-y-2">
                          <div className="flex items-center gap-1.5">
                            <Label className="text-foreground text-sm font-medium">
                              {t("asset:loanInterest.method")}
                            </Label>
                            <LoanFieldInfo label={t("asset:loanInterest.method")}>
                              {t("asset:loanInterest.hint")}
                            </LoanFieldInfo>
                          </div>
                          <LoanInterestMethodSelect
                            value={formData.interestMethod}
                            onChange={(value) => updateFormData("interestMethod", value)}
                          />
                        </div>
                      )}
                    </div>
                    {automaticSchedule && (
                      <>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <div className="flex items-center gap-1.5">
                              <Label className="text-foreground text-sm font-medium">
                                {durationLabel}
                              </Label>
                              <LoanFieldInfo label={durationLabel}>
                                {t(
                                  isMortgage
                                    ? "asset:loanActions.amortization_hint"
                                    : "asset:loanActions.loan_term_hint",
                                )}
                              </LoanFieldInfo>
                            </div>
                            <LoanDurationInput
                              label={durationLabel}
                              years={formData.loanTerm}
                              months={formData.loanTermMonths}
                              onYearsChange={(value) => updateFormData("loanTerm", value)}
                              onMonthsChange={(value) => updateFormData("loanTermMonths", value)}
                              className="h-11"
                            />
                          </div>
                          <div className="space-y-2">
                            <Label className="text-foreground text-sm font-medium">
                              {t("asset:loanActions.payment_frequency")}
                            </Label>
                            <ResponsiveSelect
                              value={paymentFrequency}
                              onValueChange={(value) =>
                                updateFormData("paymentFrequency", value as LoanPaymentFrequency)
                              }
                              options={(
                                ["monthly", "biweekly", "accelerated_biweekly"] as const
                              ).map((value) => ({
                                value,
                                label: t(`asset:loanActions.${value}`),
                              }))}
                              sheetTitle={t("asset:loanActions.payment_frequency")}
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label>{t("asset:loanActions.first_payment_date")}</Label>
                          <DatePickerInput
                            value={firstPaymentDate}
                            onChange={(date) => updateFormData("firstPaymentDate", date)}
                          />
                          {amortizationSchedule && (
                            <p className="text-muted-foreground text-xs">
                              {t("asset:loanActions.last_payment", {
                                count: amortizationSchedule.paymentCount,
                                date: dates.formatCalendarDate(
                                  formatDateToISO(amortizationSchedule.lastPaymentDate),
                                  { day: "numeric", month: "short", year: "numeric" },
                                ),
                              })}
                            </p>
                          )}
                        </div>
                      </>
                    )}
                  </>
                )}

                {/* Value and Date row */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-foreground text-sm font-medium">
                      {getValueLabel()}
                      {formData.kind === AlternativeAssetKind.LIABILITY && (
                        <span className="text-muted-foreground ml-1 text-xs font-normal">
                          {t("asset:quickAdd.optional")}
                        </span>
                      )}
                    </Label>
                    <MoneyInput
                      value={formData.currentValue}
                      onValueChange={(value) => updateFormData("currentValue", value)}
                      className="h-11"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-foreground text-sm font-medium">
                      {formData.kind === AlternativeAssetKind.LIABILITY
                        ? t("asset:quickAdd.balance_date")
                        : t("asset:quickAdd.value_date")}
                      {formData.kind === AlternativeAssetKind.LIABILITY && (
                        <span className="text-muted-foreground ml-1 text-xs font-normal">
                          {t("asset:quickAdd.optional")}
                        </span>
                      )}
                    </Label>
                    <DatePickerInput
                      value={formData.valueDate}
                      onChange={(date) => date && updateFormData("valueDate", date)}
                    />
                  </div>
                </div>

                {/* Purchase/Original Amount and Date — non-liabilities only (optional) */}
                {formData.kind !== AlternativeAssetKind.LIABILITY && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label className="text-foreground text-sm font-medium">
                        {t("asset:quickAdd.purchase_price")}
                        <span className="text-muted-foreground ml-1 text-xs font-normal">
                          {t("asset:quickAdd.optional")}
                        </span>
                      </Label>
                      <MoneyInput
                        value={formData.purchasePrice || ""}
                        onValueChange={(value) => updateFormData("purchasePrice", value)}
                        className="h-11"
                      />
                      <p className="text-muted-foreground text-xs">
                        {t("asset:quickAdd.calculate_gain")}
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Label className="text-foreground text-sm font-medium">
                        {t("asset:quickAdd.purchase_date")}
                        <span className="text-muted-foreground ml-1 text-xs font-normal">
                          {t("asset:quickAdd.optional")}
                        </span>
                      </Label>
                      <DatePickerInput
                        value={formData.purchaseDate}
                        onChange={(date) => date && updateFormData("purchaseDate", date)}
                      />
                    </div>
                  </div>
                )}

                {validationError && (
                  <p className="text-destructive text-sm" role="alert">
                    {t(validationError)}
                  </p>
                )}

                {/* Mortgage checkbox for property */}
                {formData.kind === AlternativeAssetKind.PROPERTY && onOpenLiabilityQuickAdd && (
                  <div className="flex items-center space-x-3 pt-2">
                    <Checkbox
                      id="hasMortgage"
                      checked={formData.hasMortgage}
                      onCheckedChange={(checked) =>
                        updateFormData("hasMortgage", checked as boolean)
                      }
                    />
                    <label htmlFor="hasMortgage" className="text-foreground cursor-pointer text-sm">
                      {t("asset:quickAdd.create_link_mortgage")}
                    </label>
                  </div>
                )}

                {/* Link to asset for liability - show if there are linkable assets and no pre-set link */}
                {formData.kind === AlternativeAssetKind.LIABILITY &&
                  linkableAssets.length > 0 &&
                  !initialLinkedAssetId && (
                    <div className="space-y-2">
                      <Label className="text-foreground text-sm font-medium">
                        {t("asset:quickAdd.link_to_asset_optional")}
                      </Label>
                      <ResponsiveSelect
                        value={formData.linkedAssetId}
                        onValueChange={(v) => updateFormData("linkedAssetId", v)}
                        options={linkableAssetOptions}
                        placeholder={t("asset:quickAdd.select_asset_to_link")}
                        sheetTitle={t("asset:quickAdd.link_to_asset")}
                        sheetDescription={t("asset:quickAdd.link_to_asset_description")}
                      />
                    </div>
                  )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer with navigation */}
        <div className="mt-auto shrink-0 border-t px-6 py-4">
          <div className="flex w-full gap-3">
            {step === 2 && allowKindChange && (
              <Button
                type="button"
                variant="outline"
                size="default"
                onClick={() => setStep(1)}
                disabled={isSubmitting}
                className="flex-1"
              >
                <Icons.ArrowLeft className="mr-2 h-4 w-4" />
                {t("asset:quickAdd.back")}
              </Button>
            )}
            <Button
              onClick={() => (step === 1 ? setStep(2) : handleSubmit())}
              disabled={!canProceed || isSubmitting}
              size="default"
              className="flex-1 font-medium"
            >
              {isSubmitting ? (
                <>
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                  {t("asset:quickAdd.creating")}
                </>
              ) : step === 1 ? (
                <>
                  {t("asset:quickAdd.continue")}
                  <Icons.ArrowRight className="ml-2 h-4 w-4" />
                </>
              ) : formData.kind === AlternativeAssetKind.LIABILITY ? (
                t("asset:quickAdd.add_liability")
              ) : (
                t("asset:quickAdd.create_asset")
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// Helper to format date to ISO string (YYYY-MM-DD)
function formatDateToISO(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
