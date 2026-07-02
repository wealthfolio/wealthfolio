import { useState, useMemo, useCallback, useEffect } from "react";
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
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  CurrencyInput,
  DatePickerInput,
  ResponsiveSelect,
  MoneyInput,
  QuantityInput,
} from "@wealthfolio/ui";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/i18n-provider";
import { translateUiText } from "@/i18n/ui-text";
import { useSettingsContext } from "@/lib/settings-provider";

import { METAL_TYPES, LIABILITY_TYPES, WEIGHT_UNITS } from "./alternative-asset-quick-add-schema";
import { useAlternativeAssetMutations } from "../hooks/use-alternative-asset-mutations";
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

// Asset type configuration using theme colors
const ASSET_TYPES = [
  {
    kind: AlternativeAssetKind.PROPERTY,
    label: "Property",
    description: "Real estate & land",
    icon: Icons.RealEstateDuotone,
    iconColor: "text-green-400",
    selectedBg: "bg-green-400/15",
    borderColor: "border-green-400/50",
  },
  {
    kind: AlternativeAssetKind.VEHICLE,
    label: "Vehicle",
    description: "Cars, boats & more",
    icon: Icons.VehicleDuotone,
    iconColor: "text-blue-400",
    selectedBg: "bg-blue-400/15",
    borderColor: "border-blue-400/50",
  },
  {
    kind: AlternativeAssetKind.COLLECTIBLE,
    label: "Collectible",
    description: "Art, watches & rare items",
    icon: Icons.CollectibleDuotone,
    iconColor: "text-purple-400",
    selectedBg: "bg-purple-400/15",
    borderColor: "border-purple-400/50",
  },
  {
    kind: AlternativeAssetKind.PRECIOUS_METAL,
    label: "Precious Metal",
    description: "Gold, silver & platinum",
    icon: Icons.PreciousDuotone,
    iconColor: "text-orange-400",
    selectedBg: "bg-orange-400/15",
    borderColor: "border-orange-400/50",
  },
  {
    kind: AlternativeAssetKind.LIABILITY,
    label: "Liability",
    description: "Loans & debt",
    icon: Icons.LiabilityDuotone,
    iconColor: "text-red-400",
    selectedBg: "bg-red-400/15",
    borderColor: "border-red-400/50",
  },
  {
    kind: AlternativeAssetKind.OTHER,
    label: "Other Asset",
    description: "Custom assets",
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
}

interface AlternativeAssetQuickAddModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultKind?: AlternativeAssetKind;
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
  linkableAssets = [],
  linkedAssetId: initialLinkedAssetId,
  defaultLiabilityType,
  defaultOriginationDate,
  defaultName,
  onAssetCreated,
  onOpenLiabilityQuickAdd,
}: AlternativeAssetQuickAddModalProps) {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
  const { settings } = useSettingsContext();
  const baseCurrency = settings?.baseCurrency ?? "USD";

  const [step, setStep] = useState<1 | 2>(1);
  const [hasMortgageChecked, setHasMortgageChecked] = useState(false);
  const [savedPurchaseDate, setSavedPurchaseDate] = useState<Date | undefined>(undefined);
  const [savedPropertyName, setSavedPropertyName] = useState<string | undefined>(undefined);
  const [formData, setFormData] = useState<FormData>({
    kind: defaultKind || AlternativeAssetKind.PROPERTY,
    name: "",
    currency: baseCurrency,
    currentValue: "",
    valueDate: new Date(),
    linkedAssetId: initialLinkedAssetId,
  });

  const { createMutation } = useAlternativeAssetMutations({
    onCreateSuccess: (response) => {
      onAssetCreated?.(response);

      // If mortgage checkbox was checked, chain to liability creation
      // Don't close the modal - the callback will reopen it for liability
      if (hasMortgageChecked && onOpenLiabilityQuickAdd) {
        onOpenChange(false);
        // Use setTimeout to ensure modal closes before reopening
        setTimeout(() => {
          onOpenLiabilityQuickAdd(response.assetId, savedPurchaseDate, savedPropertyName);
        }, 100);
      } else {
        onOpenChange(false);
      }
    },
  });

  // Reset form when modal opens
  useEffect(() => {
    if (open) {
      // Skip step 1 if a defaultKind is provided
      setStep(defaultKind ? 2 : 1);
      setHasMortgageChecked(false);
      setSavedPurchaseDate(undefined);
      setSavedPropertyName(undefined);
      setFormData({
        kind: defaultKind || AlternativeAssetKind.PROPERTY,
        name: defaultName || "",
        currency: baseCurrency,
        currentValue: "",
        valueDate: defaultOriginationDate || new Date(),
        linkedAssetId: initialLinkedAssetId,
        liabilityType: defaultLiabilityType,
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

  const canProceed = useMemo(() => {
    if (step === 1) return true;
    return formData.name.trim() && formData.currentValue;
  }, [step, formData.name, formData.currentValue]);

  const handleSubmit = async () => {
    if (!canProceed) return;

    const metadata: Record<string, string> = {};
    const isLiability = formData.kind === AlternativeAssetKind.LIABILITY;

    // Use unified 'sub_type' field for all asset types
    if (formData.kind === AlternativeAssetKind.PRECIOUS_METAL) {
      if (formData.metalType) metadata.sub_type = formData.metalType;
      if (formData.quantity) metadata.quantity = formData.quantity;
      if (formData.unit) metadata.unit = formData.unit;
    }

    if (isLiability) {
      if (formData.liabilityType) metadata.sub_type = formData.liabilityType;
      // For liabilities, store "Original Amount" as original_amount in metadata
      if (formData.purchasePrice) metadata.original_amount = formData.purchasePrice;
      // Store "Origination Date" as origination_date in metadata
      if (formData.purchaseDate) metadata.origination_date = formatDateToISO(formData.purchaseDate);
    }

    const request: CreateAlternativeAssetRequest = {
      kind: kindToApiKind[formData.kind],
      name: formData.name,
      currency: formData.currency,
      currentValue: formData.currentValue,
      valueDate: formatDateToISO(formData.valueDate),
      // Pass purchasePrice/purchaseDate for all asset types (including liabilities) to create historical quotes
      purchasePrice: formData.purchasePrice || undefined,
      purchaseDate: formData.purchaseDate ? formatDateToISO(formData.purchaseDate) : undefined,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      linkedAssetId: formData.linkedAssetId || undefined,
    };

    setHasMortgageChecked(formData.hasMortgage ?? false);
    setSavedPurchaseDate(formData.purchaseDate);
    setSavedPropertyName(formData.name);

    await createMutation.mutateAsync(request);
  };

  // Build linkable assets options for liability form (only actual assets, no "none" option)
  const linkableAssetOptions = useMemo(() => {
    return linkableAssets.map((asset) => ({
      value: asset.id,
      label: asset.name,
    }));
  }, [linkableAssets]);

  const getValueLabel = () => {
    if (formData.kind === AlternativeAssetKind.LIABILITY) {
      return isChinese ? "当前余额" : "Current Balance";
    }
    return isChinese ? "当前价值" : "Current Value";
  };

  const getPlaceholder = () => {
    switch (formData.kind) {
      case AlternativeAssetKind.PROPERTY:
        return isChinese ? "海边别墅、城市公寓..." : "Beach House, City Apartment...";
      case AlternativeAssetKind.VEHICLE:
        return isChinese ? "特斯拉 Model 3、保时捷 911..." : "Tesla Model 3, Porsche 911...";
      case AlternativeAssetKind.PRECIOUS_METAL:
        return isChinese ? "金条、银币..." : "Gold Bars, Silver Coins...";
      case AlternativeAssetKind.LIABILITY:
        return isChinese ? "住房贷款、车贷..." : "Home Mortgage, Car Loan...";
      case AlternativeAssetKind.COLLECTIBLE:
        return isChinese ? "劳力士 Daytona、毕加索版画..." : "Rolex Daytona, Picasso Print...";
      default:
        return isChinese ? "资产名称..." : "Asset name...";
    }
  };

  const isSubmitting = createMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]"
        mobileClassName="flex h-[90vh] flex-col"
      >
        {/* Header with progress indicator */}
        <DialogHeader className="border-b px-6 py-4">
          <div className="flex flex-col items-center space-y-2 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
            <DialogTitle className="text-foreground text-lg font-semibold">
              {step === 1
                ? isChinese
                  ? "添加新资产"
                  : "Add New Asset"
                : selectedAssetType
                  ? translateUiText(language, selectedAssetType.label)
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
              ? isChinese
                ? "选择要添加的资产类型"
                : "Select the type of asset you want to add"
              : formData.kind === AlternativeAssetKind.LIABILITY
                ? isChinese
                  ? "添加负债以跟踪净资产"
                  : "Add a liability to track against your net worth"
                : isChinese
                  ? "输入资产详情"
                  : "Enter the details for your asset"}
          </p>
        </DialogHeader>

        {/* Content area with animations */}
        <div className="relative flex-1 overflow-y-auto">
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
                          {translateUiText(language, type.label)}
                        </span>
                        <span className="text-muted-foreground mt-0.5 text-xs">
                          {translateUiText(language, type.description)}
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
                        {isChinese ? "金属类型" : "Metal Type"}
                      </Label>
                      <ResponsiveSelect
                        value={formData.metalType || "gold"}
                        onValueChange={(v) => updateFormData("metalType", v)}
                        options={METAL_TYPES.map((metal) => ({
                          value: metal.value,
                          label: translateUiText(language, metal.label),
                        }))}
                        placeholder={isChinese ? "选择金属" : "Select metal"}
                        sheetTitle={isChinese ? "选择金属类型" : "Select Metal Type"}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div className="space-y-2">
                        <Label className="text-foreground text-sm font-medium">
                          {isChinese ? "数量" : "Quantity"}
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
                          {isChinese ? "单位" : "Unit"}
                        </Label>
                        <ResponsiveSelect
                          value={formData.unit || "oz"}
                          onValueChange={(v) => updateFormData("unit", v)}
                          options={WEIGHT_UNITS.map((unit) => ({
                            value: unit.value,
                            label: translateUiText(language, unit.label),
                          }))}
                          placeholder={isChinese ? "选择单位" : "Select unit"}
                          sheetTitle={isChinese ? "选择单位" : "Select Unit"}
                        />
                      </div>
                    </div>
                  </>
                )}

                {formData.kind === AlternativeAssetKind.LIABILITY && (
                  <div className="space-y-2">
                    <Label className="text-foreground text-sm font-medium">
                      {isChinese ? "负债类型" : "Liability Type"}
                    </Label>
                    <ResponsiveSelect
                      value={formData.liabilityType || "mortgage"}
                      onValueChange={(v) => updateFormData("liabilityType", v)}
                      options={LIABILITY_TYPES.map((type) => ({
                        value: type.value,
                        label: translateUiText(language, type.label),
                      }))}
                      placeholder={isChinese ? "选择类型" : "Select type"}
                      sheetTitle={isChinese ? "选择负债类型" : "Select Liability Type"}
                    />
                  </div>
                )}

                {/* Name field */}
                <div className="space-y-2">
                  <Label className="text-foreground text-sm font-medium">
                    {isChinese ? "名称" : "Name"}
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
                    {isChinese ? "货币" : "Currency"}
                  </Label>
                  <CurrencyInput
                    value={formData.currency}
                    onChange={(v) => updateFormData("currency", v)}
                    placeholder={isChinese ? "选择货币" : "Select currency"}
                  />
                </div>

                {/* Value and Date row */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-foreground text-sm font-medium">{getValueLabel()}</Label>
                    <MoneyInput
                      value={formData.currentValue}
                      onValueChange={(value) => updateFormData("currentValue", value)}
                      placeholder="0.00"
                      className="h-11"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-foreground text-sm font-medium">
                      {formData.kind === AlternativeAssetKind.LIABILITY
                        ? isChinese
                          ? "余额日期"
                          : "Balance Date"
                        : isChinese
                          ? "估值日期"
                          : "Value Date"}
                    </Label>
                    <DatePickerInput
                      value={formData.valueDate}
                      onChange={(date) => date && updateFormData("valueDate", date)}
                    />
                  </div>
                </div>

                {/* Purchase/Original Amount and Date (optional, for gain/paydown calculation) */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-foreground text-sm font-medium">
                      {formData.kind === AlternativeAssetKind.LIABILITY
                        ? isChinese
                          ? "原始金额"
                          : "Original Amount"
                        : isChinese
                          ? "购买价格"
                          : "Purchase Price"}
                      <span className="text-muted-foreground ml-1 text-xs font-normal">
                        {isChinese ? "（可选）" : "(optional)"}
                      </span>
                    </Label>
                    <MoneyInput
                      value={formData.purchasePrice || ""}
                      onValueChange={(value) => updateFormData("purchasePrice", value)}
                      placeholder="0.00"
                      className="h-11"
                    />
                    <p className="text-muted-foreground text-xs">
                      {formData.kind === AlternativeAssetKind.LIABILITY
                        ? isChinese
                          ? "用于跟踪债务偿还"
                          : "Used to track debt paydown"
                        : isChinese
                          ? "用于计算未实现收益"
                          : "Used to calculate unrealized gain"}
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-foreground text-sm font-medium">
                      {formData.kind === AlternativeAssetKind.LIABILITY
                        ? isChinese
                          ? "起始日期"
                          : "Origination Date"
                        : isChinese
                          ? "购买日期"
                          : "Purchase Date"}
                      <span className="text-muted-foreground ml-1 text-xs font-normal">
                        {isChinese ? "（可选）" : "(optional)"}
                      </span>
                    </Label>
                    <DatePickerInput
                      value={formData.purchaseDate}
                      onChange={(date) => date && updateFormData("purchaseDate", date)}
                    />
                  </div>
                </div>

                {/* Mortgage checkbox for property */}
                {formData.kind === AlternativeAssetKind.PROPERTY && (
                  <div className="flex items-center space-x-3 pt-2">
                    <Checkbox
                      id="hasMortgage"
                      checked={formData.hasMortgage}
                      onCheckedChange={(checked) =>
                        updateFormData("hasMortgage", checked as boolean)
                      }
                    />
                    <label htmlFor="hasMortgage" className="text-foreground cursor-pointer text-sm">
                      {isChinese ? "创建并关联抵押贷款" : "Create and link a mortgage"}
                    </label>
                  </div>
                )}

                {/* Link to asset for liability - show if there are linkable assets and no pre-set link */}
                {formData.kind === AlternativeAssetKind.LIABILITY &&
                  linkableAssets.length > 0 &&
                  !initialLinkedAssetId && (
                    <div className="space-y-2">
                      <Label className="text-foreground text-sm font-medium">
                        {isChinese ? "关联资产（可选）" : "Link to Asset (optional)"}
                      </Label>
                      <ResponsiveSelect
                        value={formData.linkedAssetId}
                        onValueChange={(v) => updateFormData("linkedAssetId", v)}
                        options={linkableAssetOptions}
                        placeholder={
                          isChinese ? "选择要关联的资产（可选）" : "Select asset to link (optional)"
                        }
                        sheetTitle={isChinese ? "关联资产" : "Link to Asset"}
                        sheetDescription={
                          isChinese
                            ? "将此负债关联到房产或车辆，以便分组显示"
                            : "Link this liability to a property or vehicle for grouped display"
                        }
                      />
                    </div>
                  )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer with navigation */}
        <div className="mt-auto border-t px-6 py-4">
          <div className="flex w-full gap-3">
            {step === 2 && (
              <Button
                type="button"
                variant="outline"
                size="default"
                onClick={() => setStep(1)}
                disabled={isSubmitting}
                className="flex-1"
              >
                <Icons.ArrowLeft className="mr-2 h-4 w-4" />
                {isChinese ? "返回" : "Back"}
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
                  {isChinese ? "创建中..." : "Creating..."}
                </>
              ) : step === 1 ? (
                <>
                  {isChinese ? "继续" : "Continue"}
                  <Icons.ArrowRight className="ml-2 h-4 w-4" />
                </>
              ) : formData.kind === AlternativeAssetKind.LIABILITY ? (
                isChinese ? (
                  "添加负债"
                ) : (
                  "Add Liability"
                )
              ) : isChinese ? (
                "创建资产"
              ) : (
                "Create Asset"
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
