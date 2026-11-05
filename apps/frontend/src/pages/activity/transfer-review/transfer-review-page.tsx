import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import { convertToInternalTransfer, linkTransferPairs, reviewTransferMatches } from "@/adapters";
import {
  isActivityEditCancelled,
  useConvertToTransferSplitReview,
} from "@/features/spending/components/activity-split-review-provider";
import { useAccounts } from "@/hooks/use-accounts";
import { QueryKeys } from "@/lib/query-keys";
import type { Account, Activity, TransferMatchCandidate, UnlinkedTransfer } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useBackNavigation } from "@/pages/layouts/mobile-stack/use-mobile-stack";
import {
  Badge,
  Button,
  Icons,
  Page,
  PageContent,
  PageHeader,
  Skeleton,
  Spinner,
  buttonVariants,
} from "@wealthfolio/ui";
import { cardSurfaceClassName } from "@wealthfolio/ui/components/ui/card";

import {
  ActivitySummaryRow,
  TransferMatchDialog,
  externalTransferUpdatePayload,
} from "../components/transfer-match-dialog";
import { useActivityMutations } from "../hooks/use-activity-mutations";
import {
  MAX_PAIRS_PER_CALL,
  candidateReasons,
  candidateWarnings,
  chunk,
  isMarkedExternal,
  needsConversion,
  pairInFlowOrder,
} from "./transfer-review-utils";

/** Rows needing a look shown at first, and added by "Show more". */
const ROWS_PER_PAGE = 50;
const LINK_ALL = "__all__";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function CandidateNotes({ candidate }: { candidate: TransferMatchCandidate }) {
  const { t } = useTranslation();
  const reasons = candidateReasons(t, candidate);
  const warnings = candidateWarnings(t, candidate);
  const external = isMarkedExternal(candidate.activity);
  const converts = needsConversion(candidate);
  if (reasons.length === 0 && warnings.length === 0 && !external && !converts) return null;
  return (
    <div className="space-y-1.5 px-3 pb-2.5">
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
        <CandidateNotes candidate={candidate} />
      </div>
    </button>
  );
}

/** The two sides of a pair, the one money leaves first. */
function PairLegs({
  source,
  counterpart,
  accountMap,
}: {
  source: Activity;
  counterpart: Activity;
  accountMap: Map<string, Account>;
}) {
  const [from, to] = pairInFlowOrder(source, counterpart);
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-stretch">
      <ActivitySummaryRow
        activity={from}
        accountMap={accountMap}
        className="bg-muted/30 min-w-0 border sm:flex-1"
      />
      <div className="text-muted-foreground flex items-center justify-center">
        <Icons.ArrowDown className="h-4 w-4 sm:hidden" />
        <Icons.ArrowRight className="hidden h-4 w-4 sm:block rtl:rotate-180" />
      </div>
      <ActivitySummaryRow
        activity={to}
        accountMap={accountMap}
        className="bg-muted/30 min-w-0 border sm:flex-1"
      />
    </div>
  );
}

function CertainRow({
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
  const reasons = candidateReasons(t, candidate);
  return (
    <li className="space-y-2 p-3" data-testid="transfer-review-certain-row">
      <PairLegs source={row.activity} counterpart={candidate.activity} accountMap={accountMap} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-2xs flex flex-wrap gap-1">
          {reasons.map((reason) => (
            <Badge key={reason} variant="secondary" className="rounded-sm px-1.5 py-0">
              {reason}
            </Badge>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={onSkip} disabled={disabled}>
          {t("activity:transfer_review.skip")}
        </Button>
      </div>
    </li>
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
  const selected =
    row.candidates.find((candidate) => candidate.activity.id === selectedId) ?? row.candidates[0];

  return (
    <li className="space-y-3 p-3" data-testid="transfer-review-row">
      <div className="space-y-2">
        <Badge variant="outline" className="text-2xs rounded-sm px-1.5 py-0 font-normal">
          {row.linkState === "broken_link"
            ? t("activity:transfer_review.state_broken_link")
            : t("activity:transfer_review.state_needs_counterpart")}
        </Badge>
        <ActivitySummaryRow
          activity={row.activity}
          accountMap={accountMap}
          className="bg-muted/30 border"
        />
      </div>

      {row.candidates.length > 0 ? (
        <div className="space-y-2">
          <div className="text-muted-foreground text-xs font-medium uppercase">
            {t("activity:transfer_match.suggested_matches")}
          </div>
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
      ) : (
        <p className="text-muted-foreground text-sm">{t("activity:transfer_review.no_match")}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {selected ? (
          <Button size="sm" onClick={() => onLink(selected)} disabled={disabled}>
            {busy ? (
              <Spinner className="me-2 h-4 w-4" />
            ) : needsConversion(selected) ? (
              <Icons.ArrowLeftRight className="me-2 h-4 w-4" />
            ) : (
              <Icons.Link className="me-2 h-4 w-4" />
            )}
            {needsConversion(selected)
              ? t("activity:transfer_review.make_transfer")
              : t("activity:transfer_review.link")}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={onFindMatch} disabled={disabled}>
          <Icons.Search className="me-2 h-4 w-4" />
          {t("activity:transfer_review.find_match")}
        </Button>
        <Button size="sm" variant="outline" onClick={onNotTransfer} disabled={disabled}>
          {t("activity:transfer_review.not_transfer")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onSkip} disabled={disabled}>
          {t("activity:transfer_review.skip")}
        </Button>
      </div>
    </li>
  );
}

function SectionHeading({
  title,
  description,
  count,
  action,
}: {
  title: string;
  description: string;
  count: number;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          {title}
          <Badge variant="secondary" className="text-2xs h-5 px-1.5 font-medium">
            {count}
          </Badge>
        </h2>
        <p className="text-muted-foreground max-w-2xl text-sm">{description}</p>
      </div>
      {action}
    </div>
  );
}

/**
 * Match transfers: pairs certain enough to link together in one action, and
 * the other unlinked transfers the Health Center reports, each with its likely
 * other side. The core decides which pairs are certain.
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
  const [visibleCount, setVisibleCount] = useState(ROWS_PER_PAGE);
  const [busy, setBusy] = useState<string | null>(null);
  const [findMatchFor, setFindMatchFor] = useState<Activity | null>(null);

  const certain = (review?.certain ?? []).filter((row) => !skipped.has(row.activity.id));
  const needsReview = (review?.needsReview ?? []).filter((row) => !skipped.has(row.activity.id));
  const skippedCount =
    (review?.certain.length ?? 0) +
    (review?.needsReview.length ?? 0) -
    certain.length -
    needsReview.length;
  const skip = (id: string) => setSkipped((current) => new Set(current).add(id));

  const linkAll = async () => {
    const pairs = certain.map((row) => ({
      activityAId: row.activity.id,
      activityBId: row.candidates[0].activity.id,
    }));
    setBusy(LINK_ALL);
    let linked = 0;
    const errors: string[] = [];
    try {
      for (const batch of chunk(pairs, MAX_PAIRS_PER_CALL)) {
        const result = await linkTransferPairs(batch);
        linked += result.linked.length;
        errors.push(...result.errors.map((failure) => failure.message));
      }
    } catch (failure) {
      errors.push(errorMessage(failure));
    } finally {
      setBusy(null);
    }
    if (linked > 0) {
      toast.success(t("activity:transfer_review.linked", { count: linked }));
    }
    if (errors.length > 0) {
      toast.error(t("activity:transfer_review.link_failed", { count: pairs.length - linked }), {
        description: errors[0],
      });
    }
    await queryClient.invalidateQueries();
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
            {certain.length > 0 ? (
              <section className="space-y-3">
                <SectionHeading
                  title={t("activity:transfer_review.certain_title")}
                  description={t("activity:transfer_review.certain_desc")}
                  count={certain.length}
                  action={
                    <Button
                      onClick={() => void linkAll()}
                      disabled={busy !== null}
                      data-testid="transfer-review-link-all"
                    >
                      {busy === LINK_ALL ? (
                        <Spinner className="me-2 h-4 w-4" />
                      ) : (
                        <Icons.Link className="me-2 h-4 w-4" />
                      )}
                      {t("activity:transfer_review.link_all", { count: certain.length })}
                    </Button>
                  }
                />
                <ul className={cn(cardSurfaceClassName, "divide-y")}>
                  {certain.map((row) => (
                    <CertainRow
                      key={row.activity.id}
                      row={row}
                      accountMap={accountMap}
                      disabled={busy !== null}
                      onSkip={() => skip(row.activity.id)}
                    />
                  ))}
                </ul>
              </section>
            ) : null}

            {needsReview.length > 0 ? (
              <section className="space-y-3">
                <SectionHeading
                  title={t("activity:transfer_review.needs_review_title")}
                  description={t("activity:transfer_review.needs_review_desc")}
                  count={needsReview.length}
                />
                <ul className={cn(cardSurfaceClassName, "divide-y")}>
                  {needsReview.slice(0, visibleCount).map((row) => (
                    <ReviewRow
                      key={row.activity.id}
                      row={row}
                      accountMap={accountMap}
                      busy={busy === row.activity.id}
                      disabled={busy !== null}
                      onLink={(candidate) => void linkRow(row, candidate)}
                      onNotTransfer={() => void markNotTransfer(row)}
                      onFindMatch={() => setFindMatchFor(row.activity)}
                      onSkip={() => skip(row.activity.id)}
                    />
                  ))}
                </ul>
                {needsReview.length > visibleCount ? (
                  <div className="flex justify-center">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setVisibleCount((count) => count + ROWS_PER_PAGE)}
                    >
                      {t("activity:transfer_review.show_more")}
                    </Button>
                  </div>
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
