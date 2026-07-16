import { zodResolver } from "@hookform/resolvers/zod";
import { useMemo } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import * as z from "zod";

import {
  Button,
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Icons,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui";

import type { CategorizationRule, RuleMatchType } from "../types/rule";
import { QuickCategorizePopover } from "./quick-categorize-popover";

export interface RuleFormValues {
  name: string;
  pattern: string;
  matchType: RuleMatchType;
  taxonomyId?: string;
  categoryId?: string;
  activityType?: string;
  priority: number;
  isGlobal: boolean;
}

export interface RuleFormCategoryOption {
  /** Composite "<taxonomyId>:<categoryId>" so the form can encode both. */
  value: string;
  label: string;
  taxonomyId: string;
  categoryId: string;
  color?: string | null;
  parentName?: string | null;
}

interface RuleFormProps {
  rule?: CategorizationRule;
  /** Flat list of activity-scope categories from spending, income, and savings taxonomies. */
  categoryOptions: RuleFormCategoryOption[];
  onSubmit: (values: RuleFormValues) => void;
  onCancel: () => void;
  isLoading?: boolean;
}

const NONE = "__none__";

const composite = (rule?: CategorizationRule): string => {
  if (rule?.taxonomyId && rule?.categoryId) return `${rule.taxonomyId}:${rule.categoryId}`;
  return "";
};

export function RuleForm({ rule, categoryOptions, onSubmit, onCancel, isLoading }: RuleFormProps) {
  const { t } = useTranslation();

  const ruleFormSchema = useMemo(
    () =>
      z
        .object({
          name: z.string().min(1, t("spending:rules.nameRequired")),
          pattern: z.string().min(1, t("spending:rules.patternRequired")),
          matchType: z.enum(["contains", "starts_with", "exact", "regex"]),
          taxonomyId: z.string().optional(),
          categoryId: z.string().optional(),
          activityType: z.string().optional(),
          priority: z.coerce.number().int().min(0),
          isGlobal: z.boolean(),
        })
        .refine((data) => data.categoryId || data.activityType, {
          message: t("spending:rules.categoryOrTypeRequired"),
          path: ["categoryId"],
        }),
    [t],
  );

  const ACTIVITY_TYPE_OPTIONS = useMemo(
    () => [
      { value: "DEPOSIT", label: t("spending:rules.activityDeposit") },
      { value: "WITHDRAWAL", label: t("spending:rules.activityWithdrawal") },
      { value: "CREDIT", label: t("spending:rules.activityCredit") },
      { value: "INTEREST", label: t("spending:rules.activityInterest") },
      { value: "DIVIDEND", label: t("spending:rules.activityDividend") },
      { value: "FEE", label: t("spending:rules.activityFee") },
      { value: "TAX", label: t("spending:rules.activityTax") },
      { value: "TRANSFER_IN", label: t("spending:rules.activityTransferIn") },
      { value: "TRANSFER_OUT", label: t("spending:rules.activityTransferOut") },
    ],
    [t],
  );

  const MATCH_TYPE_OPTIONS = useMemo<{ value: RuleMatchType; label: string }[]>(
    () => [
      { value: "contains", label: t("spending:rules.matchContainsLabel") },
      { value: "starts_with", label: t("spending:rules.matchStartsWithLabel") },
      { value: "exact", label: t("spending:rules.matchExactLabel") },
      { value: "regex", label: t("spending:rules.matchRegexLabel") },
    ],
    [t],
  );

  const form = useForm<RuleFormValues>({
    resolver: zodResolver(ruleFormSchema) as never,
    defaultValues: {
      name: rule?.name ?? "",
      pattern: rule?.pattern ?? "",
      matchType: rule?.matchType ?? "contains",
      taxonomyId: rule?.taxonomyId ?? "",
      categoryId: composite(rule), // we encode taxonomyId:categoryId in this single field
      activityType: rule?.activityType ?? "",
      priority: rule?.priority ?? 0,
      isGlobal: rule ? Boolean(rule.isGlobal) : true,
    },
  });

  const handleSubmit = (values: RuleFormValues) => {
    // Decode composite categoryId back into taxonomyId + categoryId
    let taxonomyId = "";
    let categoryId = "";
    if (values.categoryId?.includes(":")) {
      const [tax, cat] = values.categoryId.split(":");
      taxonomyId = tax;
      categoryId = cat;
    }
    onSubmit({
      ...values,
      taxonomyId,
      categoryId,
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(handleSubmit as never)} className="space-y-4">
        <FormField
          control={form.control as never}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("spending:rules.ruleName")}</FormLabel>
              <FormControl>
                <Input placeholder={t("spending:rules.ruleNamePlaceholder")} {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control as never}
          name="matchType"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("spending:rules.matchType")}</FormLabel>
              <Select onValueChange={field.onChange} defaultValue={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder={t("spending:rules.selectMatchType")} />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {MATCH_TYPE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control as never}
          name="pattern"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("spending:rules.pattern")}</FormLabel>
              <FormControl>
                <Input
                  placeholder={
                    form.watch("matchType") === "regex"
                      ? t("spending:rules.patternPlaceholderRegex")
                      : t("spending:rules.patternPlaceholder")
                  }
                  {...field}
                />
              </FormControl>
              {form.watch("matchType") === "regex" && (
                <FormDescription>{t("spending:rules.patternRegexHint")}</FormDescription>
              )}
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control as never}
            name="activityType"
            render={({ field }) => (
              <FormItem>
                <FormLabel>{t("spending:rules.activityType")}</FormLabel>
                <Select
                  onValueChange={(val) => field.onChange(val === NONE ? "" : val)}
                  value={field.value || ""}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder={t("spending:rules.selectActivityType")} />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NONE}>
                      <span className="text-muted-foreground">{t("spending:rules.none")}</span>
                    </SelectItem>
                    {ACTIVITY_TYPE_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control as never}
            name="categoryId"
            render={({ field }) => {
              const fieldValue = (field.value as string | undefined) ?? "";
              const [, currentCatId] = fieldValue.split(":");
              const currentOption = currentCatId
                ? categoryOptions.find((opt) => opt.categoryId === currentCatId)
                : undefined;
              return (
                <FormItem>
                  <FormLabel>{t("spending:filters.category")}</FormLabel>
                  <QuickCategorizePopover
                    scope="both"
                    selectedCategoryId={currentCatId ?? null}
                    onSelect={(tax, catId) => field.onChange(`${tax}:${catId}`)}
                    onClear={() => field.onChange("")}
                    trigger={
                      <FormControl>
                        <button
                          type="button"
                          className="border-input bg-input-bg dark:bg-input/30 hover:bg-accent/30 ring-offset-background focus:ring-ring h-input-height flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2"
                          aria-label={
                            currentOption
                              ? t("spending:transactions.changeCategory", {
                                  name: currentOption.label,
                                })
                              : t("spending:rules.selectCategory")
                          }
                        >
                          {currentOption ? (
                            <span className="flex min-w-0 items-center gap-2">
                              {currentOption.color && (
                                <span
                                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                                  style={{ backgroundColor: currentOption.color }}
                                  aria-hidden="true"
                                />
                              )}
                              <span className="truncate">
                                {currentOption.parentName ? `${currentOption.parentName} / ` : ""}
                                {currentOption.label}
                              </span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              {t("spending:rules.selectCategory")}
                            </span>
                          )}
                          <Icons.ChevronDown
                            className="ml-2 h-4 w-4 shrink-0 opacity-50"
                            aria-hidden="true"
                          />
                        </button>
                      </FormControl>
                    }
                  />
                  <FormMessage />
                </FormItem>
              );
            }}
          />
        </div>

        <FormField
          control={form.control as never}
          name="priority"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("spending:rules.priorityLabel")}</FormLabel>
              <FormControl>
                <Input type="number" min={0} {...field} />
              </FormControl>
              <FormDescription>{t("spending:rules.priorityHint")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-2 pt-4">
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("common:cancel")}
          </Button>
          <Button type="submit" disabled={isLoading}>
            {isLoading ? (
              <>
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                {t("spending:common.saving")}
              </>
            ) : rule ? (
              t("spending:rules.updateRule")
            ) : (
              t("spending:rules.createRule")
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
