import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
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

const ruleFormSchema = z
  .object({
    name: z.string().min(1, "Name is required"),
    pattern: z.string().min(1, "Pattern is required"),
    matchType: z.enum(["contains", "starts_with", "exact", "regex"]),
    taxonomyId: z.string().optional(),
    categoryId: z.string().optional(),
    activityType: z.string().optional(),
    priority: z.coerce.number().int().min(0),
    isGlobal: z.boolean(),
  })
  .refine((data) => data.categoryId || data.activityType, {
    message: "At least a category or activity type is required",
    path: ["categoryId"],
  });

export type RuleFormValues = z.infer<typeof ruleFormSchema>;

const ACTIVITY_TYPE_OPTIONS = [
  { value: "DEPOSIT", label: "Deposit" },
  { value: "WITHDRAWAL", label: "Withdrawal" },
  { value: "CREDIT", label: "Credit / Refund" },
  { value: "INTEREST", label: "Interest" },
  { value: "DIVIDEND", label: "Dividend" },
  { value: "FEE", label: "Fee" },
  { value: "TAX", label: "Tax" },
  { value: "TRANSFER_IN", label: "Transfer In" },
  { value: "TRANSFER_OUT", label: "Transfer Out" },
];

const MATCH_TYPE_OPTIONS: { value: RuleMatchType; label: string; description: string }[] = [
  { value: "contains", label: "Contains", description: "Pattern found anywhere in text" },
  { value: "starts_with", label: "Starts with", description: "Text begins with pattern" },
  { value: "exact", label: "Exact match", description: "Text matches pattern exactly" },
  { value: "regex", label: "Regex", description: "Use | for OR (e.g., walmart|costco|target)" },
];

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
  /** Flat list of activity-scope categories from spending_categories + income_sources. */
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
    if (values.categoryId && values.categoryId.includes(":")) {
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
              <FormLabel>Rule Name</FormLabel>
              <FormControl>
                <Input placeholder="e.g., Grocery stores" {...field} />
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
              <FormLabel>Match Type</FormLabel>
              <Select onValueChange={field.onChange} defaultValue={field.value}>
                <FormControl>
                  <SelectTrigger>
                    <SelectValue placeholder="Select match type" />
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
              <FormLabel>Pattern</FormLabel>
              <FormControl>
                <Input
                  placeholder={
                    form.watch("matchType") === "regex"
                      ? "e.g., walmart|costco|target"
                      : "e.g., walmart"
                  }
                  {...field}
                />
              </FormControl>
              {form.watch("matchType") === "regex" && (
                <FormDescription>
                  Use | for OR matching (e.g., netflix|spotify|hulu).
                </FormDescription>
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
                <FormLabel>Activity Type</FormLabel>
                <Select
                  onValueChange={(val) => field.onChange(val === NONE ? "" : val)}
                  value={field.value || ""}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue placeholder="Select activity type" />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={NONE}>
                      <span className="text-muted-foreground">None</span>
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
                  <FormLabel>Category</FormLabel>
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
                              ? `Change category (${currentOption.label})`
                              : "Select category"
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
                            <span className="text-muted-foreground">Select category</span>
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
              <FormLabel>Priority</FormLabel>
              <FormControl>
                <Input type="number" min={0} {...field} />
              </FormControl>
              <FormDescription>Higher priority rules are checked first (0-100).</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex justify-end gap-2 pt-4">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={isLoading}>
            {isLoading ? (
              <>
                <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : rule ? (
              "Update Rule"
            ) : (
              "Create Rule"
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
