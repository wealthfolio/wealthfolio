import { localizeActivityTypeName } from "@/lib/activity-utils";
import type { ContributionActivityDetail } from "@/lib/types";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Button,
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  PrivacyAmount,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  useDateFormatting,
} from "@wealthfolio/ui";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { useContributionActivityExclusion } from "../use-contribution-limit-details";

const treatmentSchema = z.object({ excluded: z.boolean() });

interface ContributionActivityReviewProps {
  limitId: string;
  activity: ContributionActivityDetail;
  accountName: string;
  total: number;
  baseCurrency: string;
}

export function ContributionActivityReview({
  limitId,
  activity,
  accountName,
  total,
  baseCurrency,
}: ContributionActivityReviewProps) {
  const { t } = useTranslation();
  const { formatDate } = useDateFormatting();
  const mutation = useContributionActivityExclusion(limitId);
  const savedExcluded = activity.treatment === "excludedByUser";
  const form = useForm<z.infer<typeof treatmentSchema>>({
    resolver: zodResolver(treatmentSchema),
    defaultValues: { excluded: savedExcluded },
  });
  const excluded = form.watch("excluded");
  const changed = excluded !== savedExcluded;
  // Excluding a counted row has a known converted amount. Restoring a foreign-
  // currency row is priced by the backend, without starting another FX request.
  const potentialAmount = savedExcluded
    ? activity.currency === baseCurrency && activity.amount != null
      ? Number(activity.amount)
      : null
    : Number(activity.countedAmount);
  const nextAmount = excluded || !activity.canExclude ? 0 : potentialAmount;
  const nextTotal = nextAmount == null ? null : total - Number(activity.countedAmount) + nextAmount;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h3 className="font-medium">{localizeActivityTypeName(t, activity.activityType)}</h3>
        <p className="text-muted-foreground text-sm">
          <bdi>{accountName}</bdi>
        </p>
        <p className="text-muted-foreground text-sm">{formatDate(activity.activityInstant)}</p>
      </div>
      <div className="text-2xl font-semibold tabular-nums">
        {activity.amount == null ? (
          "—"
        ) : (
          <PrivacyAmount value={Number(activity.amount)} currency={activity.currency} />
        )}
      </div>
      <Separator />
      {!activity.canExclude ? (
        <p className="text-muted-foreground text-sm">
          {t(`settings:limits_detail.treatments.${activity.treatment}`)}
        </p>
      ) : (
        <Form {...form}>
          <form
            className="space-y-4"
            onSubmit={form.handleSubmit(({ excluded }) =>
              mutation.mutate({ activityId: activity.id, excluded }),
            )}
          >
            <FormField
              control={form.control}
              name="excluded"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{t("settings:limits_detail.treatment")}</FormLabel>
                  <Select
                    items={[
                      { value: "automatic", label: t("settings:limits_detail.automatic") },
                      { value: "excluded", label: t("settings:limits_detail.excluded") },
                    ]}
                    value={field.value ? "excluded" : "automatic"}
                    onValueChange={(value) => field.onChange(value === "excluded")}
                    disabled={mutation.isPending}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="automatic">
                        {t("settings:limits_detail.automatic")}
                      </SelectItem>
                      <SelectItem value="excluded">
                        {t("settings:limits_detail.excluded")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />
            <p className="text-muted-foreground text-xs">
              {t("settings:limits_detail.activity_unchanged")}
            </p>
            <div className="bg-muted/40 space-y-3 rounded-lg p-3 text-sm" aria-live="polite">
              <div className="flex flex-wrap justify-between gap-2">
                <span>{t("settings:limits_detail.counted_amount")}</span>
                {nextAmount == null ? (
                  <span className="text-muted-foreground">
                    {t("settings:limits_detail.recalculate")}
                  </span>
                ) : (
                  <PrivacyAmount value={nextAmount} currency={baseCurrency} />
                )}
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <span>{t("settings:limits_detail.usage_after_save")}</span>
                {nextTotal == null ? (
                  <span className="text-muted-foreground">
                    {t("settings:limits_detail.recalculate")}
                  </span>
                ) : (
                  <PrivacyAmount value={nextTotal} currency={baseCurrency} />
                )}
              </div>
            </div>
            <Button type="submit" className="w-full" disabled={!changed || mutation.isPending}>
              {mutation.isPending ? t("settings:limits_saving") : t("settings:limits_detail.save")}
            </Button>
          </form>
        </Form>
      )}
    </div>
  );
}
