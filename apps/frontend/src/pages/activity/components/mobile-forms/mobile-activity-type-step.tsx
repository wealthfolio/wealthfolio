import { FormControl, FormField, FormItem } from "@wealthfolio/ui/components/ui/form";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { RadioGroup, RadioGroupItem } from "@wealthfolio/ui/components/ui/radio-group";
import { ActivityType } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useId } from "react";
import { useFormContext } from "react-hook-form";
import { useTranslation } from "react-i18next";

interface MobileActivityTypeStepProps {
  includeReclassificationTypes?: boolean;
  /** Offers a conversion, which the sheet form records as its two rows. */
  onSelectConversion?: () => void;
}

// A picker choice with no type of its own: it hands over to the sheet form.
const CONVERSION_CHOICE = "CONVERSION";

export function MobileActivityTypeStep({
  includeReclassificationTypes = false,
  onSelectConversion,
}: MobileActivityTypeStepProps) {
  const { control } = useFormContext();
  const pickerId = useId();
  const { t } = useTranslation();

  const activityTypes = [
    {
      value: ActivityType.BUY,
      label: t("activity:type_buy"),
      icon: "TrendingUp" as const,
      description: t("activity:mobile_type_buy_desc"),
    },
    {
      value: ActivityType.SELL,
      label: t("activity:type_sell"),
      icon: "TrendingDown" as const,
      description: t("activity:mobile_type_sell_desc"),
    },
    {
      value: ActivityType.DEPOSIT,
      label: t("activity:type_deposit"),
      icon: "ArrowDownLeft" as const,
      description: t("activity:mobile_type_deposit_desc"),
    },
    {
      value: ActivityType.WITHDRAWAL,
      label: t("activity:type_withdrawal"),
      icon: "ArrowUpRight" as const,
      description: t("activity:mobile_type_withdrawal_desc"),
    },
    {
      value: ActivityType.TRANSFER_OUT,
      label: t("activity:form.button_transfer"),
      icon: "ArrowLeftRight" as const,
      description: t("activity:mobile_type_transfer_desc"),
    },
    {
      value: ActivityType.DIVIDEND,
      label: t("activity:type_dividend"),
      icon: "Income" as const,
      description: t("activity:mobile_type_dividend_desc"),
    },
    {
      value: ActivityType.INTEREST,
      label: t("activity:type_interest"),
      icon: "Percent" as const,
      description: t("activity:mobile_type_interest_desc"),
    },
    {
      value: ActivityType.FEE,
      label: t("activity:type_fee"),
      icon: "DollarSign" as const,
      description: t("activity:mobile_type_fee_desc"),
    },
    {
      value: ActivityType.TAX,
      label: t("activity:type_tax"),
      icon: "Receipt" as const,
      description: t("activity:mobile_type_tax_desc"),
    },
    {
      value: ActivityType.SPLIT,
      label: t("activity:type_split"),
      icon: "Split" as const,
      description: t("activity:mobile_type_split_desc"),
    },
    // Reclassifying edits one stored row; a conversion is two rows.
    ...(onSelectConversion && !includeReclassificationTypes
      ? [
          {
            value: CONVERSION_CHOICE,
            label: t("activity:picker.conversion"),
            icon: "RefreshCw" as const,
            description: t("activity:mobile_type_conversion_desc"),
          },
        ]
      : []),
    ...(includeReclassificationTypes
      ? [
          {
            value: ActivityType.ADJUSTMENT,
            label: t("activity:mobile_type_adjustment_label"),
            icon: "RefreshCw" as const,
            description: t("activity:mobile_type_adjustment_desc"),
          },
          {
            value: ActivityType.CREDIT,
            label: t("activity:type_credit"),
            icon: "Coins" as const,
            description: t("activity:type_credit"),
          },
        ]
      : []),
  ];

  return (
    <div className="flex flex-col">
      <div className="mb-4">
        <h3 id={`${pickerId}-title`} className="text-lg font-semibold">
          {t("activity:mobile_select_transaction_type")}
        </h3>
      </div>

      <FormField
        control={control}
        name="activityType"
        render={({ field }) => (
          <FormItem>
            <FormControl>
              <RadioGroup
                aria-labelledby={`${pickerId}-title`}
                className="grid-cols-2 gap-2 pb-1"
                onValueChange={(value) =>
                  value === CONVERSION_CHOICE ? onSelectConversion?.() : field.onChange(value)
                }
                value={field.value as string}
              >
                {activityTypes.map((type) => {
                  const Icon = Icons[type.icon];
                  const optionId = `${pickerId}-${type.value}`;
                  return (
                    <div key={type.value} className="relative min-w-0">
                      <RadioGroupItem
                        value={type.value}
                        id={optionId}
                        aria-describedby={`${optionId}-description`}
                        className="peer sr-only absolute"
                      />
                      <label
                        htmlFor={optionId}
                        className={cn(
                          "relative flex h-full min-h-16 cursor-pointer items-center gap-2 rounded-xl border px-3 py-3 text-sm transition-colors",
                          "hover:bg-muted/50",
                          "peer-data-checked:border-primary peer-data-checked:bg-primary/5",
                          "peer-focus-visible:outline-ring peer-focus-visible:outline-solid peer-focus-visible:outline-2 peer-focus-visible:-outline-offset-2",
                        )}
                      >
                        <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden />
                        <span className="min-w-0 font-medium break-words whitespace-normal">
                          {type.label}
                        </span>
                        {/* Inline at the end: in the card's corner the rounding clipped it. */}
                        {field.value === type.value && (
                          <Icons.Check
                            className="text-primary ms-auto size-4 shrink-0"
                            aria-hidden
                          />
                        )}
                      </label>
                      <span id={`${optionId}-description`} className="sr-only">
                        {type.description}
                      </span>
                    </div>
                  );
                })}
              </RadioGroup>
            </FormControl>
          </FormItem>
        )}
      />
    </div>
  );
}
