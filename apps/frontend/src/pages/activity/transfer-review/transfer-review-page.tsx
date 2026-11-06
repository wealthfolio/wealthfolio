import { fromDate, toCalendarDate } from "@internationalized/date";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { convertToInternalTransfer, linkTransferPairs, reviewTransferMatches } from "@/adapters";
import {
  isActivityEditCancelled,
  useConvertToTransferSplitReview,
} from "@/features/spending/components/activity-split-review-provider";
import { useAccounts } from "@/hooks/use-accounts";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { QueryKeys } from "@/lib/query-keys";
import type { Account, Activity, TransferMatchCandidate, UnlinkedTransfer } from "@/lib/types";
import { cn, resolveDisplayTimezone } from "@/lib/utils";
import { useBackNavigation } from "@/pages/layouts/mobile-stack/use-mobile-stack";
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icons,
  Page,
  PageContent,
  PageHeader,
  Progress,
  Skeleton,
  Spinner,
  buttonVariants,
  statusSurfaceVariants,
  useDateFormatting,
  useLocalizationSettings,
  useNumberFormatting,
} from "@wealthfolio/ui";
import { cardSurfaceClassName } from "@wealthfolio/ui/components/ui/card";

import {
  ActivitySummaryRow,
  TransferMatchDialog,
  externalTransferUpdatePayload,
} from "../components/transfer-match-dialog";
import { useActivityMutations } from "../hooks/use-activity-mutations";
import {
  LINK_BATCH_SIZE,
  REVIEW_REASONS,
  accountRoutes,
  candidateReasons,
  candidateWarnings,
  chunk,
  isMarkedExternal,
  needsConversion,
  pairInFlowOrder,
  reviewReason,
  timingReason,
  type AccountRoute,
  type ReviewReason,
} from "./transfer-review-utils";

/** Rows shown at first in a list, and added by "Show more". */
const ROWS_PER_PAGE = 50;

type ReasonFilter = "all" | Exclude<ReviewReason, "other">;

interface LinkFailure {
  row: UnlinkedTransfer;
  message: string;
}

/** Link all, while it runs and once it is done. Lives for this visit only. */
type LinkRun =
  | { status: "running"; done: number; total: number; stopping: boolean }
  | { status: "finished"; linked: number; failures: LinkFailure[]; notSent: number };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pairRequest(row: UnlinkedTransfer) {
  return { activityAId: row.activity.id, activityBId: row.candidates[0].activity.id };
}

/** "Show more" over a long list. */
function useVisibleCount() {
  const [count, setCount] = useState(ROWS_PER_PAGE);
  return {
    count,
    showMore: () => setCount((current) => current + ROWS_PER_PAGE),
    reset: () => setCount(ROWS_PER_PAGE),
  };
}

function ShowMoreButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex justify-center p-2">
      <Button variant="ghost" size="sm" onClick={onClick}>
        {t("activity:transfer_review.show_more")}
      </Button>
    </div>
  );
}

function CandidateNotes({
  candidate,
  withReasons = true,
  className,
}: {
  candidate: TransferMatchCandidate;
  withReasons?: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const reasons = withReasons ? candidateReasons(t, candidate) : [];
  const warnings = candidateWarnings(t, candidate);
  const external = isMarkedExternal(candidate.activity);
  const converts = needsConversion(candidate);
  if (reasons.length === 0 && warnings.length === 0 && !external && !converts) return null;
  return (
    <div className={cn("space-y-1.5", className)}>
      {reasons.length > 0 || external ? (
        <div className="text-2xs flex flex-wrap gap-1">
          {reasons.map((reason) => (
            <Badge key={reason} variant="secondary" className="rounded-sm px-1.5 py-0">
              {reason}
            </Badge>
          ))}
          {external ? (
            <Badge variant="outline" className="rounded-sm px-1.5 py-0">
              {t("activity:transfer_review.marked_external_badge")}
            </Badge>
          ) : null}
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div className="text-2xs text-warning flex items-start gap-1.5">
          <Icons.AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{warnings.join(" ")}</span>
        </div>
      ) : null}
      {converts ? (
        <div className="text-2xs text-muted-foreground flex items-start gap-1.5">
          <Icons.Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span>{t("activity:transfer_review.converts_hint")}</span>
        </div>
      ) : null}
    </div>
  );
}

function CandidateOption({
  candidate,
  accountMap,
  selected,
  onSelect,
}: {
  candidate: TransferMatchCandidate;
  accountMap: Map<string, Account>;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "hover:bg-muted/50 flex w-full items-start rounded-md border text-start transition-colors",
        selected && "border-primary bg-primary/5 hover:bg-primary/5",
      )}
      onClick={onSelect}
      aria-pressed={selected}
    >
      <div className="py-3 ps-3">
        {selected ? (
          <Icons.CheckCircle className="text-primary h-4 w-4" />
        ) : (
          <Icons.Circle className="text-muted-foreground/30 h-4 w-4" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <ActivitySummaryRow activity={candidate.activity} accountMap={accountMap} />
        <CandidateNotes candidate={candidate} className="px-3 pb-2.5" />
      </div>
    </button>
  );
}

/** Points from one side of a transfer to the other: down when stacked, along the row when not. */
function FlowArrow({ className }: { className?: string }) {
  return (
    <div className={cn("text-muted-foreground flex items-center justify-center", className)}>
      <Icons.ArrowDown className="h-4 w-4 sm:hidden" aria-hidden="true" />
      <Icons.ArrowRight className="hidden h-4 w-4 sm:block rtl:rotate-180" aria-hidden="true" />
    </div>
  );
}

/** The two sides of a pair, the one money leaves first. */
function PairLegs({
  source,
  counterpart,
  accountMap,
  className,
}: {
  source: Activity;
  counterpart: Activity;
  accountMap: Map<string, Account>;
  className?: string;
}) {
  const [from, to] = pairInFlowOrder(source, counterpart);
  return (
    <div className={cn("flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-2", className)}>
      <ActivitySummaryRow
        compact
        activity={from}
        accountMap={accountMap}
        className="bg-muted/30 min-w-0 border sm:flex-1"
      />
      <FlowArrow />
      <ActivitySummaryRow
        compact
        activity={to}
        accountMap={accountMap}
        className="bg-muted/30 min-w-0 border sm:flex-1"
      />
    </div>
  );
}

function CertainPairRow({
  row,
  accountMap,
  disabled,
  onSkip,
}: {
  row: UnlinkedTransfer;
  accountMap: Map<string, Account>;
  disabled: boolean;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  const candidate = row.candidates[0];
  if (!candidate) return null;
  const timing = timingReason(t, candidate);
  return (
    <li
      className="flex flex-col gap-2 px-3 py-2.5 lg:flex-row lg:items-center lg:gap-3"
      data-testid="transfer-review-certain-row"
    >
      <PairLegs
        source={row.activity}
        counterpart={candidate.activity}
        accountMap={accountMap}
        className="min-w-0 lg:flex-1"
      />
      <div className="flex items-center justify-between gap-2 lg:justify-end">
        {timing ? (
          <Badge variant="secondary" className="text-2xs rounded-sm px-1.5 py-0">
            {timing}
          </Badge>
        ) : (
          <span />
        )}
        <Button variant="ghost" size="sm" onClick={onSkip} disabled={disabled}>
          {t("activity:transfer_review.skip")}
        </Button>
      </div>
    </li>
  );
}

/** First to last out-leg month of a route, in the display timezone. */
function useRouteDates() {
  const dateFormatting = useDateFormatting();
  const { timezone } = useLocalizationSettings();
  const zone = resolveDisplayTimezone(timezone);
  return (route: AccountRoute) => {
    const day = (time: number) => toCalendarDate(fromDate(new Date(time), zone));
    return dateFormatting.formatCalendarDateRange(day(route.first), day(route.last), {
      month: "short",
      year: "numeric",
    });
  };
}

function RouteList({
  routes,
  accountMap,
}: {
  routes: AccountRoute[];
  accountMap: Map<string, Account>;
}) {
  const { t } = useTranslation();
  const routeDates = useRouteDates();
  const name = (id: string) => accountMap.get(id)?.name ?? id;
  return (
    <ul className="divide-y border-t px-4 md:px-5" data-testid="transfer-review-routes">
      {routes.map((route) => (
        <li
          key={`${route.fromAccountId}-${route.toAccountId}`}
          className="flex flex-wrap items-center gap-x-4 gap-y-0.5 py-2.5 text-sm"
        >
          <span className="flex min-w-0 flex-1 basis-48 items-center gap-1.5 font-medium">
            <span className="truncate">{name(route.fromAccountId)}</span>
            <Icons.ArrowRight
              className="text-muted-foreground h-3.5 w-3.5 shrink-0 rtl:rotate-180"
              aria-hidden="true"
            />
            <span className="truncate">{name(route.toAccountId)}</span>
          </span>
          <span className="text-muted-foreground">{routeDates(route)}</span>
          <span className="w-20 text-end font-medium tabular-nums">
            {t("activity:transfer_review.pair_count", { count: route.count })}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Certain pairs as a summary: count, routes, Link all, and the pairs on request. */
function ReadyToLinkCard({
  rows,
  accountMap,
  disabled,
  onLinkAll,
  onSkip,
}: {
  rows: UnlinkedTransfer[];
  accountMap: Map<string, Account>;
  disabled: boolean;
  onLinkAll: () => void;
  onSkip: (row: UnlinkedTransfer) => void;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobileViewport();
  const [expanded, setExpanded] = useState(false);
  const visible = useVisibleCount();
  const routes = useMemo(() => accountRoutes(rows), [rows]);

  const linkAllButton = (
    <Button
      onClick={onLinkAll}
      disabled={disabled}
      className={cn(isMobile && "w-full")}
      data-testid="transfer-review-link-all"
    >
      <Icons.Link className="me-2 h-4 w-4" />
      {t("activity:transfer_review.link_all", { count: rows.length })}
    </Button>
  );

  return (
    <section aria-labelledby="transfer-review-ready" className={cardSurfaceClassName}>
      <div className="flex flex-wrap items-start justify-between gap-4 p-4 md:p-5">
        <div className="min-w-0 flex-1 basis-80 space-y-1">
          <h2
            id="transfer-review-ready"
            className="text-muted-foreground text-xs font-semibold tracking-wide uppercase"
          >
            {t("activity:transfer_review.certain_title")}
          </h2>
          <p className="text-2xl font-semibold tabular-nums">
            {t("activity:transfer_review.pair_count", { count: rows.length })}
          </p>
          <p className="text-muted-foreground max-w-2xl text-sm">
            {t("activity:transfer_review.certain_desc")}
          </p>
        </div>
        {isMobile ? null : linkAllButton}
      </div>

      <RouteList routes={routes} accountMap={accountMap} />

      <div className="border-t px-2 py-1 md:px-3">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded
            ? t("activity:transfer_review.hide_pairs")
            : t("activity:transfer_review.show_pairs", { count: rows.length })}
          <Icons.ChevronDown className={cn("ms-1 h-4 w-4", expanded && "rotate-180")} />
        </Button>
      </div>

      {expanded ? (
        <div className="border-t">
          <ul className="divide-y">
            {rows.slice(0, visible.count).map((row) => (
              <CertainPairRow
                key={row.activity.id}
                row={row}
                accountMap={accountMap}
                disabled={disabled}
                onSkip={() => onSkip(row)}
              />
            ))}
          </ul>
          {rows.length > visible.count ? <ShowMoreButton onClick={visible.showMore} /> : null}
        </div>
      ) : null}

      {isMobile ? (
        // Pinned above the tab bar while the pairs scroll past.
        <div className="bg-card/95 sticky bottom-(--mobile-nav-total-offset) z-10 rounded-b-(--card-radius) border-t p-3 backdrop-blur-md">
          {linkAllButton}
        </div>
      ) : null}
    </section>
  );
}

function LinkProgressCard({
  done,
  total,
  stopping,
  onStop,
}: {
  done: number;
  total: number;
  stopping: boolean;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  const numbers = useNumberFormatting();
  const fraction = total > 0 ? done / total : 0;
  const title = t("activity:transfer_review.linking", { done, count: total });
  return (
    <section
      className={cn(cardSurfaceClassName, "space-y-3 p-4 md:p-5")}
      data-testid="transfer-review-progress"
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold" aria-live="polite">
          {title}
        </h2>
        <span className="text-muted-foreground text-sm tabular-nums">
          {numbers.formatPercent(fraction, { digits: 0 })}
        </span>
      </div>
      <Progress value={fraction * 100} aria-label={title} className="h-2" />
      <p className="text-muted-foreground text-sm">{t("activity:transfer_review.linking_hint")}</p>
      <Button variant="outline" size="sm" onClick={onStop} disabled={stopping}>
        {stopping ? <Spinner className="me-2 h-4 w-4" /> : null}
        {stopping
          ? t("activity:transfer_review.stopping")
          : t("activity:transfer_review.stop_after_batch")}
      </Button>
    </section>
  );
}

function LinkResultCard({
  linked,
  failures,
  notSent,
  accountMap,
  onDismiss,
}: {
  linked: number;
  failures: LinkFailure[];
  notSent: number;
  accountMap: Map<string, Account>;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const [showFailures, setShowFailures] = useState(false);
  const visible = useVisibleCount();
  return (
    <section
      className={cn(cardSurfaceClassName, "space-y-3 p-4 md:p-5")}
      role="status"
      data-testid="transfer-review-result"
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-current/15",
            linked > 0 ? "text-success-subtle-foreground" : "text-warning-subtle-foreground",
          )}
        >
          {linked > 0 ? (
            <Icons.Check className="h-4 w-4" />
          ) : (
            <Icons.AlertTriangle className="h-4 w-4" />
          )}
        </span>
        <h2 className="text-base font-semibold">
          {t("activity:transfer_review.result_linked", { count: linked })}
        </h2>
      </div>
      {notSent > 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("activity:transfer_review.result_stopped", { count: notSent })}
        </p>
      ) : null}
      {failures.length > 0 ? (
        <div className={cn(statusSurfaceVariants({ status: "warning" }), "rounded-md")}>
          <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
            <p className="text-warning-subtle-foreground text-sm font-medium">
              {t("activity:transfer_review.result_failed", { count: failures.length })}
            </p>
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showFailures}
              onClick={() => setShowFailures((open) => !open)}
            >
              {showFailures
                ? t("activity:transfer_review.hide_failed")
                : t("activity:transfer_review.show_failed")}
            </Button>
          </div>
          {showFailures ? (
            <div className="border-t">
              <ul className="divide-y" data-testid="transfer-review-failures">
                {failures.slice(0, visible.count).map(({ row, message }) => (
                  <li key={row.activity.id} className="space-y-1.5 px-3 py-2.5">
                    <PairLegs
                      source={row.activity}
                      counterpart={row.candidates[0].activity}
                      accountMap={accountMap}
                    />
                    <p className="text-muted-foreground text-xs">{message}</p>
                  </li>
                ))}
              </ul>
              {failures.length > visible.count ? (
                <ShowMoreButton onClick={visible.showMore} />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <Button variant="outline" size="sm" onClick={onDismiss}>
        {t("activity:done")}
      </Button>
    </section>
  );
}

function RowMenu({
  disabled,
  onNotTransfer,
  onFindMatch,
  onSkip,
}: {
  disabled: boolean;
  /** Absent when Not a transfer is already the row's main action. */
  onNotTransfer?: () => void;
  onFindMatch: () => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            size="icon-sm"
            disabled={disabled}
            aria-label={t("activity:transfer_review.more_actions")}
          >
            <Icons.MoreHorizontal className="h-4 w-4" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {onNotTransfer ? (
          <DropdownMenuItem onClick={onNotTransfer}>
            {t("activity:transfer_review.not_transfer")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={onFindMatch}>
          {t("activity:transfer_review.find_match")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onSkip}>{t("activity:transfer_review.skip")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ReviewRow({
  row,
  accountMap,
  busy,
  disabled,
  onLink,
  onNotTransfer,
  onFindMatch,
  onSkip,
}: {
  row: UnlinkedTransfer;
  accountMap: Map<string, Account>;
  busy: boolean;
  disabled: boolean;
  onLink: (candidate: TransferMatchCandidate) => void;
  onNotTransfer: () => void;
  onFindMatch: () => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [choosing, setChoosing] = useState(false);
  const selected =
    row.candidates.find((candidate) => candidate.activity.id === selectedId) ?? row.candidates[0];
  const otherCount = row.candidates.length - 1;
  const converts = selected ? needsConversion(selected) : false;

  return (
    <li className="space-y-2 p-3" data-testid="transfer-review-row">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-2">
        <div className="min-w-0 space-y-1 sm:flex-1">
          {row.linkState === "broken_link" ? (
            <Badge variant="outline" className="text-2xs rounded-sm px-1.5 py-0 font-normal">
              {t("activity:transfer_review.state_broken_link")}
            </Badge>
          ) : null}
          <ActivitySummaryRow
            compact
            activity={row.activity}
            accountMap={accountMap}
            className="bg-muted/30 border"
          />
        </div>
        {selected ? <FlowArrow className="sm:h-14" /> : null}
        <div className="min-w-0 space-y-1.5 sm:flex-1">
          {selected ? (
            <>
              <ActivitySummaryRow
                compact
                activity={selected.activity}
                accountMap={accountMap}
                className="bg-muted/30 border"
              />
              <CandidateNotes candidate={selected} withReasons={false} className="px-1" />
              {otherCount > 0 ? (
                <button
                  type="button"
                  className="text-2xs hover:text-foreground text-muted-foreground flex items-center gap-1 px-1 font-medium underline-offset-2 hover:underline"
                  aria-expanded={choosing}
                  onClick={() => setChoosing((open) => !open)}
                >
                  {t("activity:transfer_review.other_matches", { count: otherCount })}
                  <Icons.ChevronDown className={cn("h-3 w-3", choosing && "rotate-180")} />
                </button>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground px-1 py-2 text-sm">
              {t("activity:transfer_review.no_match")}
            </p>
          )}
        </div>
        <div className="flex gap-2 sm:shrink-0">
          {selected ? (
            <Button
              size="sm"
              className="flex-1 sm:flex-none"
              onClick={() => onLink(selected)}
              disabled={disabled}
            >
              {busy ? (
                <Spinner className="me-2 h-4 w-4" />
              ) : converts ? (
                <Icons.ArrowLeftRight className="me-2 h-4 w-4" />
              ) : (
                <Icons.Link className="me-2 h-4 w-4" />
              )}
              {converts
                ? t("activity:transfer_review.make_transfer")
                : t("activity:transfer_review.link")}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="flex-1 sm:flex-none"
              onClick={onNotTransfer}
              disabled={disabled}
            >
              {busy ? <Spinner className="me-2 h-4 w-4" /> : null}
              {t("activity:transfer_review.not_transfer")}
            </Button>
          )}
          <RowMenu
            disabled={disabled}
            onNotTransfer={selected ? onNotTransfer : undefined}
            onFindMatch={onFindMatch}
            onSkip={onSkip}
          />
        </div>
      </div>

      {choosing ? (
        <div className="space-y-2">
          {row.candidates.map((candidate) => (
            <CandidateOption
              key={candidate.activity.id}
              candidate={candidate}
              accountMap={accountMap}
              selected={candidate.activity.id === selected?.activity.id}
              onSelect={() => setSelectedId(candidate.activity.id)}
            />
          ))}
        </div>
      ) : null}
    </li>
  );
}

function SectionHeading({
  title,
  description,
  count,
}: {
  title: string;
  description: string;
  count: number;
}) {
  return (
    <div className="min-w-0 space-y-1">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        {title}
        <Badge variant="secondary" className="text-2xs h-5 px-1.5 font-medium">
          {count}
        </Badge>
      </h2>
      <p className="text-muted-foreground max-w-2xl text-sm">{description}</p>
    </div>
  );
}

const REASON_LABEL_KEYS: Record<ReasonFilter, string> = {
  all: "activity:transfer_review.filter_all",
  more_than_one: "activity:transfer_review.reason_more_than_one",
  dates_differ: "activity:transfer_review.reason_dates_differ",
  cash_flow: "activity:transfer_review.reason_cash_flow",
  no_match: "activity:transfer_review.reason_no_match",
};

function ReasonFilters({
  counts,
  total,
  value,
  onChange,
}: {
  counts: Record<Exclude<ReviewReason, "other">, number>;
  total: number;
  value: ReasonFilter;
  onChange: (value: ReasonFilter) => void;
}) {
  const { t } = useTranslation();
  const chips: { value: ReasonFilter; count: number }[] = [
    { value: "all", count: total },
    ...REVIEW_REASONS.filter((reason) => counts[reason] > 0).map((reason) => ({
      value: reason,
      count: counts[reason],
    })),
  ];
  // Every row shares one reason, or has none of these: the chips add nothing.
  if (chips.length < 2 || chips.some((chip) => chip.value !== "all" && chip.count === total)) {
    return null;
  }
  return (
    <div
      role="group"
      aria-label={t("activity:transfer_review.filter_label")}
      className="flex flex-wrap gap-2"
    >
      {chips.map((chip) => {
        const active = chip.value === value;
        return (
          <Button
            key={chip.value}
            size="xs"
            variant={active ? "default" : "outline"}
            className="rounded-full"
            aria-pressed={active}
            onClick={() => onChange(chip.value)}
          >
            {t(REASON_LABEL_KEYS[chip.value])}
            <span className={cn("tabular-nums", !active && "text-muted-foreground")}>
              {chip.count}
            </span>
          </Button>
        );
      })}
    </div>
  );
}

/**
 * Match transfers: pairs certain enough to link together in one action, and
 * the other unlinked transfers the Health Center reports, each with its likely
 * other side. The core decides which pairs are certain, and its codes say why
 * the rest need a look.
 */
export function TransferReviewPage() {
  const { t } = useTranslation();
  const goBack = useBackNavigation("/activities");
  const queryClient = useQueryClient();
  const reviewConversion = useConvertToTransferSplitReview();
  const { updateActivityMutation } = useActivityMutations();
  const { accounts } = useAccounts({ filterActive: false, includeArchived: true });
  const accountMap = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  const {
    data: review,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: [QueryKeys.TRANSFER_REVIEW],
    queryFn: reviewTransferMatches,
  });

  // Skipping hides a row for this visit only.
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [findMatchFor, setFindMatchFor] = useState<Activity | null>(null);
  const [linkRun, setLinkRun] = useState<LinkRun | null>(null);
  const stopRequested = useRef(false);
  const [filter, setFilter] = useState<ReasonFilter>("all");
  const visibleRows = useVisibleCount();

  const certain = useMemo(
    () => (review?.certain ?? []).filter((row) => !skipped.has(row.activity.id)),
    [review, skipped],
  );
  const needsReview = useMemo(
    () => (review?.needsReview ?? []).filter((row) => !skipped.has(row.activity.id)),
    [review, skipped],
  );
  const reasons = useMemo(
    () => new Map(needsReview.map((row) => [row.activity.id, reviewReason(row)])),
    [needsReview],
  );
  const reasonCounts = useMemo(() => {
    const counts = { more_than_one: 0, dates_differ: 0, cash_flow: 0, no_match: 0, other: 0 };
    for (const reason of reasons.values()) counts[reason] += 1;
    return counts;
  }, [reasons]);
  // A reason whose rows are all handled falls back to All.
  const activeFilter: ReasonFilter = filter !== "all" && reasonCounts[filter] > 0 ? filter : "all";
  const filteredRows =
    activeFilter === "all"
      ? needsReview
      : needsReview.filter((row) => reasons.get(row.activity.id) === activeFilter);

  const skippedCount =
    (review?.certain.length ?? 0) +
    (review?.needsReview.length ?? 0) -
    certain.length -
    needsReview.length;
  const skip = (id: string) => setSkipped((current) => new Set(current).add(id));
  const linking = linkRun?.status === "running";
  const disabled = busy !== null || linking;

  const selectFilter = (value: ReasonFilter) => {
    setFilter(value);
    visibleRows.reset();
  };

  const linkAll = async () => {
    const rows = certain;
    stopRequested.current = false;
    setLinkRun({ status: "running", done: 0, total: rows.length, stopping: false });
    let linked = 0;
    let sent = 0;
    const failures: LinkFailure[] = [];
    for (const batch of chunk(rows, LINK_BATCH_SIZE)) {
      if (stopRequested.current) break;
      sent += batch.length;
      try {
        const result = await linkTransferPairs(batch.map(pairRequest));
        linked += result.linked.length;
        for (const failure of result.errors) {
          const row = batch[failure.index];
          if (row) failures.push({ row, message: failure.message });
        }
      } catch (failure) {
        // The call itself failed: none of this batch is known to be linked.
        const message = errorMessage(failure);
        failures.push(...batch.map((row) => ({ row, message })));
        break;
      }
      const done = sent;
      setLinkRun((run) => (run?.status === "running" ? { ...run, done } : run));
    }
    // Refresh before showing the result, so Ready to link never offers a
    // pair that was just linked.
    await queryClient.invalidateQueries();
    setLinkRun({ status: "finished", linked, failures, notSent: rows.length - sent });
  };

  const stopLinking = () => {
    stopRequested.current = true;
    setLinkRun((run) => (run?.status === "running" ? { ...run, stopping: true } : run));
  };

  const linkRow = async (row: UnlinkedTransfer, candidate: TransferMatchCandidate) => {
    setBusy(row.activity.id);
    try {
      if (needsConversion(candidate)) {
        const request = await reviewConversion({
          activityId: row.activity.id,
          counterpartActivityId: candidate.activity.id,
        });
        await convertToInternalTransfer(request);
        toast.success(t("activity:transfer_match.convert_success"));
      } else {
        const result = await linkTransferPairs([
          { activityAId: row.activity.id, activityBId: candidate.activity.id },
        ]);
        if (result.errors.length > 0) throw new Error(result.errors[0].message);
        toast.success(t("activity:transfer_review.linked", { count: 1 }));
      }
      await queryClient.invalidateQueries();
    } catch (failure) {
      if (isActivityEditCancelled(failure)) return;
      toast.error(t("activity:transfer_review.link_failed", { count: 1 }), {
        description: errorMessage(failure),
      });
    } finally {
      setBusy(null);
    }
  };

  const markNotTransfer = async (row: UnlinkedTransfer) => {
    setBusy(row.activity.id);
    try {
      // The same update as the activity form's "external" switch.
      await updateActivityMutation.mutateAsync(externalTransferUpdatePayload(row.activity));
      toast.success(t("activity:transfer_review.marked_external"));
    } catch {
      // The mutation reports its own failure.
    } finally {
      setBusy(null);
    }
  };

  const isEmpty = !!review && review.certain.length === 0 && review.needsReview.length === 0;

  return (
    <Page>
      <PageHeader
        heading={t("activity:transfer_review.title")}
        text={t("activity:transfer_review.description")}
        onBack={goBack}
      />
      <PageContent className="mt-6 space-y-8 pb-8">
        {linkRun?.status === "finished" ? (
          <LinkResultCard
            linked={linkRun.linked}
            failures={linkRun.failures}
            notSent={linkRun.notSent}
            accountMap={accountMap}
            onDismiss={() => setLinkRun(null)}
          />
        ) : null}
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-8 w-48 rounded-lg" />
            <Skeleton className="h-28 rounded-lg" />
            <Skeleton className="h-28 rounded-lg" />
          </div>
        ) : error ? (
          <div className="flex min-h-60 flex-col items-center justify-center text-center">
            <div className="text-destructive-subtle-foreground mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-current/15">
              <Icons.AlertCircle className="h-6 w-6" />
            </div>
            <h2 className="mb-1 text-base font-medium">
              {t("activity:transfer_review.load_error")}
            </h2>
            <p className="text-muted-foreground mb-4 text-sm">{errorMessage(error)}</p>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              <Icons.RefreshCw className="me-2 h-3.5 w-3.5" />
              {t("common:retry")}
            </Button>
          </div>
        ) : isEmpty ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="text-success-subtle-foreground mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-current/15">
              <Icons.CheckCircle className="h-8 w-8" />
            </div>
            <h2 className="mb-2 text-lg font-semibold">
              {t("activity:transfer_review.empty_title")}
            </h2>
            <p className="text-muted-foreground mb-6 max-w-sm text-sm">
              {t("activity:transfer_review.empty_desc")}
            </p>
            <Link to="/activities" className={buttonVariants({ variant: "outline", size: "sm" })}>
              {t("activity:activities")}
            </Link>
          </div>
        ) : review ? (
          <>
            {linkRun?.status === "running" ? (
              <LinkProgressCard
                done={linkRun.done}
                total={linkRun.total}
                stopping={linkRun.stopping}
                onStop={stopLinking}
              />
            ) : certain.length > 0 ? (
              <ReadyToLinkCard
                rows={certain}
                accountMap={accountMap}
                disabled={disabled}
                onLinkAll={() => void linkAll()}
                onSkip={(row) => skip(row.activity.id)}
              />
            ) : null}

            {needsReview.length > 0 ? (
              <section className="space-y-3">
                <SectionHeading
                  title={t("activity:transfer_review.needs_review_title")}
                  description={t("activity:transfer_review.needs_review_desc")}
                  count={needsReview.length}
                />
                <ReasonFilters
                  counts={reasonCounts}
                  total={needsReview.length}
                  value={activeFilter}
                  onChange={selectFilter}
                />
                <ul className={cn(cardSurfaceClassName, "divide-y")}>
                  {filteredRows.slice(0, visibleRows.count).map((row) => (
                    <ReviewRow
                      key={row.activity.id}
                      row={row}
                      accountMap={accountMap}
                      busy={busy === row.activity.id}
                      disabled={disabled}
                      onLink={(candidate) => void linkRow(row, candidate)}
                      onNotTransfer={() => void markNotTransfer(row)}
                      onFindMatch={() => setFindMatchFor(row.activity)}
                      onSkip={() => skip(row.activity.id)}
                    />
                  ))}
                </ul>
                {filteredRows.length > visibleRows.count ? (
                  <ShowMoreButton onClick={visibleRows.showMore} />
                ) : null}
              </section>
            ) : null}

            {skippedCount > 0 ? (
              <div className="text-muted-foreground flex flex-wrap items-center justify-center gap-2 text-sm">
                <span>{t("activity:transfer_review.skipped", { count: skippedCount })}</span>
                <Button variant="ghost" size="sm" onClick={() => setSkipped(new Set())}>
                  <Icons.RotateCcw className="me-2 h-3.5 w-3.5" />
                  {t("activity:transfer_review.show_skipped")}
                </Button>
              </div>
            ) : null}
          </>
        ) : null}
      </PageContent>

      <TransferMatchDialog
        open={findMatchFor !== null}
        mode="link"
        sourceActivity={findMatchFor}
        accounts={accounts}
        onOpenChange={(open) => {
          if (!open) setFindMatchFor(null);
        }}
      />
    </Page>
  );
}
