import { FormControl, FormField, FormItem } from "@wealthfolio/ui/components/ui/form";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { RadioGroup, RadioGroupItem } from "@wealthfolio/ui/components/ui/radio-group";
import { ScrollArea } from "@wealthfolio/ui/components/ui/scroll-area";
import { ActivityType } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useFormContext } from "react-hook-form";
import { useTranslation } from "react-i18next";

export function MobileActivityTypeStep() {
  const { control } = useFormContext();
  const { t } = useTranslation();

  const activityTypes = [
    {
      category: t("activity:mobile_type_category.trade"),
      types: [
        {
          value: ActivityType.BUY,
          label: t("activity:type_buy"),
          icon: "ArrowDown" as const,
          description: t("activity:mobile_type_buy_desc"),
        },
        {
          value: ActivityType.SELL,
          label: t("activity:type_sell"),
          icon: "ArrowUp" as const,
          description: t("activity:mobile_type_sell_desc"),
        },
      ],
    },
    {
      category: t("activity:mobile_type_category.cash"),
      types: [
        {
          value: ActivityType.DEPOSIT,
          label: t("activity:type_deposit"),
          icon: "ArrowDown" as const,
          description: t("activity:mobile_type_deposit_desc"),
        },
        {
          value: ActivityType.WITHDRAWAL,
          label: t("activity:type_withdrawal"),
          icon: "ArrowUp" as const,
          description: t("activity:mobile_type_withdrawal_desc"),
        },
        {
          value: ActivityType.TRANSFER_OUT,
          label: t("activity:form.button_transfer"),
          icon: "ArrowLeftRight" as const,
          description: t("activity:mobile_type_transfer_desc"),
        },
      ],
    },
    {
      category: t("activity:mobile_type_category.income"),
      types: [
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
      ],
    },
    {
      category: t("activity:mobile_type_category.other"),
      types: [
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
        {
          value: ActivityType.ADJUSTMENT,
          label: t("activity:mobile_type_adjustment_label"),
          icon: "RefreshCw" as const,
          description: t("activity:mobile_type_adjustment_desc"),
        },
      ],
    },
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="mb-4">
        <h3 className="text-lg font-semibold">{t("activity:mobile_select_transaction_type")}</h3>
      </div>

      <ScrollArea>
        <FormField
          control={control}
          name="activityType"
          render={({ field }) => (
            <FormItem>
              <FormControl>
                <RadioGroup onValueChange={field.onChange} value={field.value as string}>
                  <div className="space-y-6 pb-4">
                    {activityTypes.map((category) => (
                      <div key={category.category}>
                        <h4 className="text-muted-foreground mb-3 text-sm font-medium">
                          {category.category}
                        </h4>
                        <div className="space-y-2">
                          {category.types.map((type) => {
                            const Icon = Icons[type.icon];
                            return (
                              <div key={type.value}>
                                <RadioGroupItem
                                  value={type.value}
                                  id={type.value}
                                  className="peer sr-only"
                                />
                                <label
                                  htmlFor={type.value}
                                  className={cn(
                                    "flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition-all",
                                    "hover:bg-muted/50",
                                    "peer-data-[state=checked]:border-primary peer-data-[state=checked]:bg-primary/5",
                                    "active:scale-[0.98]",
                                  )}
                                >
                                  <div className="mt-0.5 flex-shrink-0">
                                    <div
                                      className={cn(
                                        "flex h-10 w-10 items-center justify-center rounded-full",
                                        "bg-muted transition-colors",
                                        "peer-data-[state=checked]:bg-primary/10",
                                      )}
                                    >
                                      <Icon className="h-5 w-5" />
                                    </div>
                                  </div>
                                  <div className="min-w-0 flex-1">
                                    <div className="font-medium">{type.label}</div>
                                    <div className="text-muted-foreground mt-0.5 text-sm">
                                      {type.description}
                                    </div>
                                  </div>
                                  {field.value === type.value && (
                                    <Icons.Check className="text-primary mt-0.5 h-5 w-5 flex-shrink-0" />
                                  )}
                                </label>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </RadioGroup>
              </FormControl>
            </FormItem>
          )}
        />
      </ScrollArea>
    </div>
  );
}
