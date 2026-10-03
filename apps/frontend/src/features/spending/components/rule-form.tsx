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

import type { CategorizationRule, RuleAmountOp, RuleMatchType } from "../types/rule";
import { QuickCategorizePopover } from "./quick-categorize-popover";

export interface RuleFormValues {
  name: string;
  pattern: string;
  matchType: RuleMatchType;
  taxonomyId?: string;
  categoryId?: string;
  activityType?: string;
  /** "" = no amount condition ("Any amount"). */
  amountOp: "" | RuleAmountOp;
  /** Raw input strings; converted to numbers by the save handler. */
  amountValue: string;
  amountValue2: string;
  priority: number;
  /** null applies the rule to every account; a value scopes it to that account. */
  accountId: string | null;
}

const parseAmount = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
};

/** Map form amount values to the wire payload. "" ("Any amount") sends
 * explicit nulls so an existing condition is cleared on update. */
export function ruleAmountPayload(
  values: Pick<RuleFormValues, "amountOp" | "amountValue" | "amountValue2">,
): {
  amountOp: RuleAmountOp | null;
  amountValue: number | null;
  amountValue2: number | null;
} {
  const amountOp = values.amountOp || null;
  return {
    amountOp,
    amountValue: amountOp ? parseAmount(values.amountValue) : null,
    amountValue2: amountOp === "between" ? parseAmount(values.amountValue2) : null,
  };
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

export const buildRuleFormSchema = (t: Translate) =>
  z
    .object({
      name: z.string().min(1, t("spending:rules.nameRequired")),
      pattern: z.string().min(1, t("spending:rules.patternRequired")),
      matchType: z.enum(["contains", "starts_with", "exact", "regex"]),
      taxonomyId: z.string().optional(),
      categoryId: z.string().optional(),
      activityType: z.string().optional(),
      amountOp: z.enum(["", "eq", "gt", "gte", "lt", "lte", "between"]),
      amountValue: z.string(),
      amountValue2: z.string(),
      priority: z.coerce.number().int().min(0),
      accountId: z.string().nullable(),
    })
    .refine((data) => data.categoryId || data.activityType, {
      message: t("spending:rules.categoryOrTypeRequired"),
      path: ["categoryId"],
    })
    .superRefine((data, ctx) => {
      if (!data.amountOp) return;
      const value = parseAmount(data.amountValue);
      if (value === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t("spending:rules.amountValueRequired"),
          path: ["amountValue"],
        });
      } else if (value < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t("spending:rules.amountValueInvalid"),
          path: ["amountValue"],
        });
      }
      if (data.amountOp !== "between") return;
      const value2 = parseAmount(data.amountValue2);
      if (value2 === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t("spending:rules.amountValueRequired"),
          path: ["amountValue2"],
        });
      } else if (value2 < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t("spending:rules.amountValueInvalid"),
          path: ["amountValue2"],
        });
      } else if (value !== null && value >= 0 && value > value2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t("spending:rules.amountFromToError"),
          path: ["amountValue2"],
        });
      }
    });

export interface RuleFormCategoryOption {
  /** Composite "<taxonomyId>:<categoryId>" so the form can encode both. */
  value: string;
  label: string;
  taxonomyId: string;
  categoryId: string;
  color?: string | null;
  parentName?: string | null;
}

export interface RuleFormAccountOption {
  id: string;
  name: string;
}

interface RuleFormProps {
  rule?: CategorizationRule;
  /** Flat list of activity-scope categories from spending, income, and savings taxonomies. */
  categoryOptions: RuleFormCategoryOption[];
  /** Tracked spending accounts the rule can be scoped to. */
  accountOptions: RuleFormAccountOption[];
  onSubmit: (values: RuleFormValues) => void;
  onCancel: () => void;
  isLoading?: boolean;
}

const NONE = "__none__";
const ALL_ACCOUNTS = "__all__";

const composite = (rule?: CategorizationRule): string => {
  if (rule?.taxonomyId && rule?.categoryId) return `${rule.taxonomyId}:${rule.categoryId}`;
  return "";
};

export function RuleForm({
  rule,
  categoryOptions,
  accountOptions,
  onSubmit,
  onCancel,
  isLoading,
}: RuleFormProps) {
  const { t } = useTranslation();

  const ruleFormSchema = useMemo(() => buildRuleFormSchema(t), [t]);

  const AMOUNT_OP_OPTIONS = useMemo<{ value: RuleAmountOp; label: string }[]>(
    () => [
      { value: "eq", label: t("spending:rules.amountExactly") },
      { value: "gt", label: t("spending:rules.amountGreaterThan") },
      { value: "gte", label: t("spending:rules.amountGreaterOrEqual") },
      { value: "lt", label: t("spending:rules.amountLessThan") },
      { value: "lte", label: t("spending:rules.amountLessOrEqual") },
      { value: "between", label: t("spending:rules.amountBetween") },
    ],
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
      amountOp: rule?.amountOp ?? "",
      amountValue: rule?.amountValue != null ? String(rule.amountValue) : "",
      amountValue2: rule?.amountValue2 != null ? String(rule.amountValue2) : "",
      priority: rule?.priority ?? 0,
      accountId: rule && !rule.isGlobal ? (rule.accountId ?? null) : null,
    },
  });

  const amountOp = form.watch("amountOp");

  // A rule can reference an account that is no longer tracked (or is archived and
  // so absent from accountOptions). Keep it in the list so the trigger isn't blank
  // and the id survives a save untouched.
  const scopeOptions = useMemo(() => {
    const scopedId = rule && !rule.isGlobal ? rule.accountId : null;
    if (!scopedId || accountOptions.some((account) => account.id === scopedId)) {
      return accountOptions;
    }
    return [...accountOptions, { id: scopedId, name: t("spending:rules.unknownAccount") }];
  }, [accountOptions, rule, t]);

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
                    scope="all"
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

        <div className="space-y-2">
          <div className="flex items-baseline gap-1.5">
            <FormLabel>{t("spending:rules.amountLabel")}</FormLabel>
            <span className="text-muted-foreground text-xs">
              {t("spending:rules.amountOptional")}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <FormField
              control={form.control as never}
              name="amountOp"
              render={({ field }) => (
                <FormItem>
                  <Select
                    onValueChange={(val) => field.onChange(val === NONE ? "" : val)}
                    value={field.value || NONE}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={NONE}>{t("spending:rules.amountAnyAmount")}</SelectItem>
                      {AMOUNT_OP_OPTIONS.map((opt) => (
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
            {amountOp && amountOp !== "between" && (
              <FormField
                control={form.control as never}
                name="amountValue"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input type="number" min={0} step="any" inputMode="decimal" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}
          </div>
          {amountOp === "between" && (
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control as never}
                name="amountValue"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-muted-foreground text-xs font-normal">
                      {t("spending:rules.amountFrom")}
                    </FormLabel>
                    <FormControl>
                      <Input type="number" min={0} step="any" inputMode="decimal" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control as never}
                name="amountValue2"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-muted-foreground text-xs font-normal">
                      {t("spending:rules.amountTo")}
                    </FormLabel>
                    <FormControl>
                      <Input type="number" min={0} step="any" inputMode="decimal" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          )}
          {amountOp && (
            <FormDescription>
              {t("spending:rules.amountHint")}
              {amountOp === "between" ? ` ${t("spending:rules.amountBetweenHint")}` : ""}
            </FormDescription>
          )}
        </div>

        <FormField
          control={form.control as never}
          name="accountId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("spending:rules.scopeLabel")}</FormLabel>
              <Select
                onValueChange={(val) => field.onChange(val === ALL_ACCOUNTS ? null : val)}
                value={(field.value as string | null) ?? ALL_ACCOUNTS}
              >
                <FormControl>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  <SelectItem value={ALL_ACCOUNTS}>{t("common:component.all_accounts")}</SelectItem>
                  {scopeOptions.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>{t("spending:rules.scopeHint")}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

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
