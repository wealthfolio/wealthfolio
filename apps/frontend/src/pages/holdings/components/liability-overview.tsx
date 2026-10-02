import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  Card,
  cn,
  Skeleton,
  useAmountFormatting,
  useDateFormatting,
  useNumberFormatting,
} from "@wealthfolio/ui";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import { Icons, type Icon } from "@wealthfolio/ui/components/ui/icons";
import { ProgressBar } from "@/features/goals/components/goal-card";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useQuoteHistory } from "@/hooks/use-quote-history";
import type { AlternativeAssetHolding } from "@/lib/types";
import { formatDateISO } from "@/lib/utils";
import { useLoanCalculation } from "@/pages/asset/alternative-assets/hooks/use-loan-calculation";
import { loanPayoffDate } from "@/pages/asset/alternative-assets/lib/loan-presentation";
import {
  liabilityCardModel,
  liabilitySummary,
  type LiabilityCardModel,
  type LiabilityStatus,
} from "./liability-overview-model";

const TYPE_ICONS: Record<string, Icon> = {
  mortgage: Icons.House,
  heloc: Icons.HouseLineDuotone,
  auto_loan: Icons.VehicleDuotone,
  student_loan: Icons.GraduationCapDuotone,
  personal_loan: Icons.HandCoinsDuotone,
  credit_card: Icons.LiabilityDuotone,
};

const STATUS_STYLES: Record<LiabilityStatus, string> = {
  paid_off: "bg-success text-success-foreground",
  renewal_due: "bg-warning text-warning-foreground",
  renew_soon: "bg-warning text-warning-foreground",
  update_balance: "bg-warning text-warning-foreground",
};

interface LiabilityOverviewProps {
  holdings: AlternativeAssetHolding[];
  isLoading: boolean;
  onEdit: (holding: AlternativeAssetHolding) => void;
  onViewHistory: (holding: AlternativeAssetHolding) => void;
  onDelete: (holding: AlternativeAssetHolding) => void;
  isDeleting?: boolean;
}

/** Liabilities as cards in the style of the goals dashboard, largest balance first. */
export function LiabilityOverview({
  holdings,
  isLoading,
  onEdit,
  onViewHistory,
  onDelete,
  isDeleting = false,
}: LiabilityOverviewProps) {
  const { t } = useTranslation();
  const [toDelete, setToDelete] = useState<AlternativeAssetHolding | null>(null);
  const today = formatDateISO(new Date());
  const cards = useMemo(
    () =>
      holdings
        .map((holding) => ({ holding, model: liabilityCardModel(holding, today) }))
        .sort((left, right) => right.model.balance - left.model.balance),
    [holdings, today],
  );

  if (isLoading) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[1, 2, 3].map((index) => (
          <Skeleton key={index} className="h-44 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  return (
    <>
      <LiabilitySummaryStats cards={cards} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map(({ holding, model }) => (
          <LiabilityCard
            key={holding.id}
            holding={holding}
            model={model}
            onEdit={onEdit}
            onViewHistory={onViewHistory}
            onDelete={setToDelete}
          />
        ))}
      </div>
      <AlertDialog open={toDelete !== null} onOpenChange={(open) => !open && setToDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("holdings:delete_asset")}</AlertDialogTitle>
            <AlertDialogDescription>
              <Trans
                i18nKey="holdings:delete_asset_confirm"
                values={{ name: toDelete?.name }}
                components={{ bold: <span className="font-semibold" /> }}
              />
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{t("common:cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (toDelete) onDelete(toDelete);
                setToDelete(null);
              }}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("common:delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function StatBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="text-muted-foreground text-[10px] uppercase tracking-[0.15em]">{label}</span>
      <span className="text-foreground text-sm font-semibold tabular-nums">{value}</span>
    </div>
  );
}

/** Totals only when every liability shares a currency; they cannot be added up otherwise. */
function LiabilitySummaryStats({
  cards,
}: {
  cards: { holding: AlternativeAssetHolding; model: LiabilityCardModel }[];
}) {
  const { t } = useTranslation();
  const amounts = useAmountFormatting();
  const numbers = useNumberFormatting();
  const { isBalanceHidden } = useBalancePrivacy();
  const currency = cards[0]?.holding.currency;
  if (!currency || cards.some(({ holding }) => holding.currency !== currency)) return null;
  const summary = liabilitySummary(cards.map(({ model }) => model));
  const money = (value: number) =>
    isBalanceHidden ? "••••" : amounts.formatCompactAmount(value, currency);
  return (
    <div className="mb-6 flex flex-wrap items-baseline gap-x-8 gap-y-2">
      <StatBlock label={t("holdings:liability_cards.owed")} value={money(summary.owed)} />
      <StatBlock label={t("holdings:liability_cards.paid_down")} value={money(summary.paidDown)} />
      {summary.overall != null && (
        <StatBlock
          label={t("holdings:liability_cards.overall")}
          value={numbers.formatPercent(summary.overall)}
        />
      )}
      {summary.monthly > 0 && (
        <StatBlock
          label={t("holdings:liability_cards.monthly")}
          value={`≈ ${money(summary.monthly)}`}
        />
      )}
    </div>
  );
}

function LiabilityCard({
  holding,
  model,
  onEdit,
  onViewHistory,
  onDelete,
}: {
  holding: AlternativeAssetHolding;
  model: LiabilityCardModel;
  onEdit: (holding: AlternativeAssetHolding) => void;
  onViewHistory: (holding: AlternativeAssetHolding) => void;
  onDelete: (holding: AlternativeAssetHolding) => void;
}) {
  const { t } = useTranslation();
  const amounts = useAmountFormatting();
  const numbers = useNumberFormatting();
  const dates = useDateFormatting();
  const { isBalanceHidden } = useBalancePrivacy();
  // Only the payoff date needs the engine; both queries are shared with the loan page.
  const { data: quotes } = useQuoteHistory({ assetId: holding.id, enabled: model.scheduled });
  const { data: calculation } = useLoanCalculation(
    holding.id,
    holding.metadata ?? {},
    quotes ?? [],
    model.scheduled && quotes !== undefined,
  );
  const payoff = loanPayoffDate(calculation);
  const money = (value: number) =>
    isBalanceHidden ? "••••" : amounts.formatAmount(value, holding.currency);
  const TypeIcon = TYPE_ICONS[model.type] ?? Icons.ReceiptDuotone;
  const typeKey = `asset:altContent.liabilityType.${model.type}`;
  const meta = [
    t(typeKey, { defaultValue: t("asset:altContent.liabilityType.other") }),
    model.rate != null
      ? `${numbers.formatDecimal(model.rate, { maximumFractionDigits: 2 })}%`
      : null,
    model.scheduled
      ? payoff &&
        t("holdings:liability_cards.debt_free", {
          date: dates.formatCalendarDate(payoff, { month: "short", year: "numeric" }),
        })
      : t("holdings:liability_cards.updated", {
          date: dates.formatCalendarDate(holding.valuationDate.slice(0, 10), {
            month: "short",
            day: "numeric",
            year: "numeric",
          }),
        }),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Card className="relative overflow-hidden p-0 transition-shadow hover:shadow-md">
      <div className="px-4 pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="bg-muted/60 flex size-10 items-center justify-center rounded-lg">
              <TypeIcon size={22} className="text-foreground/80" />
            </div>
            {model.status && (
              <span
                className={cn(
                  "inline-flex h-5 items-center px-2 text-[9px] font-medium uppercase leading-none tracking-[0.14em]",
                  STATUS_STYLES[model.status],
                )}
              >
                {t(`holdings:liability_cards.status_${model.status}`)}
              </span>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="hover:bg-muted text-muted-foreground relative z-10 inline-flex size-8 items-center justify-center rounded-md transition"
                aria-label={t("holdings:open_actions")}
              >
                <Icons.MoreVertical className="size-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {/* Confirming on the loan page keeps its validation and balance provenance. */}
              <DropdownMenuItem asChild>
                <Link to={`/holdings/${encodeURIComponent(holding.id)}?action=confirm-balance`}>
                  <Icons.DollarSign className="mr-2 size-4" />
                  {t("holdings:liability_cards.update_balance")}
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onViewHistory(holding)}>
                <Icons.History className="mr-2 size-4" />
                {t("holdings:liability_cards.schedule")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onEdit(holding)}>
                <Icons.Pencil className="mr-2 size-4" />
                {t("holdings:edit_details")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => onDelete(holding)}
              >
                <Icons.Trash className="mr-2 size-4" />
                {t("common:delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="mt-3 flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {/* The title's link covers the card; the actions button sits above it. */}
            <h3 className="truncate text-base font-semibold leading-tight">
              <Link
                to={`/holdings/${encodeURIComponent(holding.id)}`}
                className="focus-visible:ring-ring rounded-sm after:absolute after:inset-0 focus-visible:outline-none focus-visible:ring-2"
              >
                {holding.name}
              </Link>
            </h3>
            <p className="text-muted-foreground mt-0.5 truncate text-[9px] uppercase tracking-[0.15em]">
              {meta}
            </p>
          </div>
          {model.paidShare != null && (
            <div className="text-right">
              <div className="text-success text-lg font-semibold tabular-nums leading-none">
                {numbers.formatPercent(model.paidShare, { digits: 1 })}
              </div>
              <div className="text-muted-foreground mt-0.5 text-[9px] uppercase tracking-[0.15em]">
                {t("holdings:liability_cards.paid_off")}
              </div>
            </div>
          )}
        </div>

        <div className="mt-2.5 flex items-end justify-between gap-3">
          <div>
            <div className="text-sm font-semibold tabular-nums">{money(model.balance)}</div>
            <div className="text-muted-foreground mt-0.5 text-[10px]">
              {model.original != null
                ? t("holdings:liability_cards.owed_of", { amount: money(model.original) })
                : t("holdings:liability_cards.owed_now")}
            </div>
          </div>
          <div className="text-right">
            {model.payment != null && model.frequency ? (
              <>
                <div className="text-sm font-semibold tabular-nums">{money(model.payment)}</div>
                <div className="text-muted-foreground mt-0.5 text-[10px]">
                  {t(`asset:loanActions.${model.frequency}`)}
                </div>
              </>
            ) : (
              <>
                <div className="text-muted-foreground text-sm font-semibold">
                  {t("holdings:liability_cards.manual")}
                </div>
                <div className="text-muted-foreground mt-0.5 text-[10px]">
                  {t("holdings:liability_cards.manual_hint")}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <div className="mt-2.5">
        <ProgressBar progress={model.paidShare ?? 0} fillClass="bg-success" />
      </div>
    </Card>
  );
}
