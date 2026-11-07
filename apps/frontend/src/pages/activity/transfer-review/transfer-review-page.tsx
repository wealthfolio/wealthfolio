import { fromDate, toCalendarDate } from "@internationalized/date";
import type { TFunction } from "i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { toast } from "sonner";

import {
  convertToInternalTransfer,
  getAssets,
  linkTransferPairs,
  reviewTransferMatches,
} from "@/adapters";
import {
  isActivityEditCancelled,
  useConvertToTransferSplitReview,
} from "@/features/spending/components/activity-split-review-provider";
import { useAccounts } from "@/hooks/use-accounts";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { ActivityType } from "@/lib/constants";
import { QueryKeys } from "@/lib/query-keys";
import {
  getEffectiveType,
  type Account,
  type Activity,
  type TransferMatchCandidate,
  type UnlinkedTransfer,
} from "@/lib/types";
import { cn, formatDateTime, resolveDisplayTimezone } from "@/lib/utils";
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
  useAmountFormatting,
  useDateFormatting,
  useLocalizationSettings,
  useNumberFormatting,
} from "@wealthfolio/ui";
import { cardSurfaceClassName } from "@wealthfolio/ui/components/ui/card";

import { ActivityTypeBadge } from "../components/activity-type-badge";
import { candidateWarnings } from "../components/transfer-link-utils";
import {
  TransferMatchDialog,
  externalTransferUpdatePayload,
} from "../components/transfer-match-dialog";
import { useActivityMutations } from "../hooks/use-activity-mutations";
import {
  LINK_BATCH_SIZE,
  REVIEW_SECTIONS,
  accountRoutes,
  chunk,
  isMarkedExternal,
  isOutflow,
  needsConversion,
  pairInFlowOrder,
  reviewPairs,
  withAssetSymbols,
  type AccountRoute,
  type ReviewPair,
  type ReviewReason,
} from "./transfer-review-utils";

/** Rows shown at first in a list, and added by "Show more". */
const ROWS_PER_PAGE = 50;

interface LinkFailure {
  row: UnlinkedTransfer;
  message: string;
}

/** Link all, while it runs and once it is done. Lives for this visit only. */
type LinkRun =
  | { status: "running"; done: number; total: number; stopping: boolean }
  | {
      status: "finished";
      linked: number;
      failures: LinkFailure[];
      notSent: number;
    };

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

/**
 * The page's columns: date, From → To, amount, actions. Both cards and their
 * rows take them from one grid, so the columns line up across the cards.
 */
const PAGE_COLUMNS =
  "sm:grid sm:grid-cols-[minmax(6rem,auto)_minmax(0,1fr)_minmax(7rem,auto)_minmax(10rem,auto)] sm:gap-x-4";
/** Takes the columns of the grid around it, through subgrid where supported. */
const SUBGRID =
  "sm:col-span-full sm:grid sm:grid-cols-[minmax(6rem,auto)_minmax(0,1fr)_minmax(7rem,auto)_minmax(10rem,auto)] sm:gap-x-4 sm:supports-[grid-template-columns:subgrid]:grid-cols-subgrid";
/**
 * A row's first line in each column, as tall as its buttons, so the date,
 * accounts, amount and buttons sit on one line.
 */
const FIRST_LINE = "sm:flex sm:min-h-9 sm:items-center sm:self-start";

/** One line under a row: what to know before linking. */
interface RowStatus {
  tone: "warning" | "info";
  text: string;
}

function StatusLines({ items }: { items: RowStatus[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {items.map((item) => {
        const Icon = item.tone === "warning" ? Icons.AlertTriangle : Icons.Info;
        return (
          <p
            key={item.text}
            className={cn(
              "flex items-start gap-1.5 text-xs",
              item.tone === "warning" ? "text-warning" : "text-muted-foreground",
            )}
          >
            <Icon className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            <span>{item.text}</span>
          </p>
        );
      })}
    </div>
  );
}

function isTransferLeg(activity: Activity): boolean {
  const type = getEffectiveType(activity);
  return type === ActivityType.TRANSFER_IN || type === ActivityType.TRANSFER_OUT;
}

/**
 * A leg's amount, and for a security its quantity and ticker. A security
 * transfer may carry only quantity and price; its value is their product.
 */
function legAmount(activity: Activity, formatting: ReturnType<typeof useAmountFormatting>) {
  const number = (value: unknown) => (value == null ? Number.NaN : Number(value));
  const quantityValue = number(activity.quantity);
  const symbol =
    "assetSymbol" in activity && typeof activity.assetSymbol === "string"
      ? activity.assetSymbol
      : (activity.assetId ?? "");
  const quantity = Number.isFinite(quantityValue)
    ? `${Math.abs(quantityValue)} ${symbol}`.trim()
    : undefined;
  let amount = number(activity.amount);
  if (!Number.isFinite(amount)) amount = quantityValue * number(activity.unitPrice);
  return Number.isFinite(amount)
    ? {
        amount: formatting.formatAmount(Math.abs(amount), activity.currency),
        quantity,
      }
    : { amount: quantity ?? activity.currency, quantity: undefined };
}

/**
 * The From → To column: the side money left, an arrow, the side it reached,
 * in halves of equal width, so sides line up down a list. Narrow, the sides
 * stack.
 */
const FLOW_COLUMNS =
  "grid min-w-0 gap-y-1 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-x-3";

/**
 * One pair, or one transfer with no other side, in the list's columns: date,
 * From → To, amount, actions. Each side shows its account, then its time and
 * note; below both, what to know. Every list on the page uses this row.
 * Clicking it opens the pair's details.
 */
function PairRow({
  from,
  to,
  accountMap,
  status = [],
  actions,
  onOpen,
  testId = "transfer-review-row",
}: {
  from?: Activity;
  to?: Activity;
  accountMap: Map<string, Account>;
  status?: RowStatus[];
  actions?: ReactNode;
  onOpen?: () => void;
  testId?: string;
}) {
  const { t } = useTranslation();
  const dateFormatting = useDateFormatting();
  const formatting = useAmountFormatting();
  const first = from ?? to;
  if (!first) return null;
  const date = formatDateTime(first.activityDate, dateFormatting).date;
  // A leg's time, with its date only when that differs from the row's.
  const when = (leg: Activity) =>
    formatDateTime(leg.activityDate, dateFormatting).date === date
      ? dateFormatting.formatTime(leg.activityDate)
      : dateFormatting.formatDateTime(leg.activityDate);
  const accountName = (leg: Activity) => accountMap.get(leg.accountId)?.name ?? leg.accountId;
  const main = legAmount(first, formatting);
  // The other side's amount, only when it reads differently: another currency or value.
  const second = from && to ? legAmount(to, formatting).amount : undefined;

  const side = (leg: Activity | undefined) =>
    leg ? (
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="sm:truncate">{accountName(leg)}</span>
        {isTransferLeg(leg) ? null : (
          <ActivityTypeBadge
            type={getEffectiveType(leg) as ActivityType}
            className="text-2xs px-1.5 py-0 font-normal"
          />
        )}
      </span>
    ) : (
      <span className="text-muted-foreground font-normal">
        {t("activity:transfer_review.no_other_side")}
      </span>
    );
  // One side: its account, then its time and note. Narrow, where the sides
  // stack, the arrow leads the second, and the first side's line starts with
  // the date, as there is no date column.
  const sideColumn = (leg: Activity | undefined, isTo: boolean) => {
    const note = leg?.notes?.trim();
    const detail = leg ? `${when(leg)}${note ? ` · ${note}` : ""}` : "";
    return (
      <div className="min-w-0">
        <div
          className={cn("flex min-w-0 items-center gap-1.5 text-sm font-medium", FIRST_LINE)}
          data-testid="transfer-review-side"
        >
          {isTo ? (
            <Icons.ArrowRight
              className="text-muted-foreground h-3.5 w-3.5 shrink-0 sm:hidden rtl:rotate-180"
              aria-hidden="true"
            />
          ) : null}
          {side(leg)}
        </div>
        {leg ? (
          <div
            className={cn("text-muted-foreground truncate text-xs", isTo && "max-sm:ps-5")}
            // A long note is cut short; hovering shows it whole.
            title={detail}
          >
            {leg === first ? <span className="sm:hidden">{date} · </span> : null}
            {detail}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <li
      className={cn(
        "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 border-t px-4 py-2.5 md:px-5",
        SUBGRID,
        onOpen && "hover:bg-muted/50 cursor-pointer transition-colors",
      )}
      onClick={
        onOpen
          ? (event) => {
              // Buttons and menu items do their own thing. React bubbles clicks
              // here from the row menu's portal too, which sits outside the row.
              if (!event.currentTarget.contains(event.target as Node)) return;
              if ((event.target as HTMLElement).closest("button, a, [role='menuitem']")) return;
              onOpen();
            }
          : undefined
      }
      data-testid={testId}
    >
      <span
        className={cn(
          "text-muted-foreground hidden text-sm whitespace-nowrap tabular-nums",
          FIRST_LINE,
        )}
      >
        {date}
      </span>
      <div className="min-w-0 space-y-1">
        <div className={FLOW_COLUMNS} data-testid="transfer-review-flow">
          {sideColumn(from, false)}
          <span className={cn("text-muted-foreground hidden", FIRST_LINE)}>
            <Icons.ArrowRight className="h-3.5 w-3.5 rtl:rotate-180" aria-hidden="true" />
          </span>
          {sideColumn(to, true)}
        </div>
        <StatusLines items={status} />
      </div>
      <div className="text-end text-sm">
        <div className={cn("font-medium tabular-nums sm:justify-end", FIRST_LINE)}>
          {main.amount}
        </div>
        {second && second !== main.amount ? (
          <div className="text-muted-foreground flex items-center justify-end gap-1 text-xs tabular-nums">
            <Icons.ArrowRight className="h-3 w-3 shrink-0 rtl:rotate-180" aria-hidden="true" />
            {second}
          </div>
        ) : null}
        {main.quantity ? (
          <div className="text-muted-foreground text-xs">{main.quantity}</div>
        ) : null}
      </div>
      {actions ? (
        <div className="col-span-2 flex items-start justify-end gap-2 sm:col-span-1">{actions}</div>
      ) : null}
    </li>
  );
}

/** A row's own action: the same size and weight on every row. */
function RowButton({
  busy,
  disabled,
  icon,
  label,
  ariaLabel,
  onClick,
}: {
  busy: boolean;
  disabled: boolean;
  icon?: boolean;
  label: string;
  ariaLabel?: string;
  onClick: () => void;
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="flex-1 sm:flex-none"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
    >
      {busy ? <Spinner className="h-4 w-4" /> : icon ? <Icons.Link className="h-4 w-4" /> : null}
      {label}
    </Button>
  );
}

interface RowMenuItem {
  label: string;
  onClick: () => void;
}

function RowMenu({ disabled, items }: { disabled: boolean; items: RowMenuItem[] }) {
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
        {items.map((item) => (
          <DropdownMenuItem key={item.label} onClick={item.onClick}>
            {item.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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

/** What a certain pair's row needs from the page. */
interface CertainHandlers {
  busyId: string | null;
  disabled: boolean;
  onLink: (row: UnlinkedTransfer) => void;
  onOpen: (row: UnlinkedTransfer) => void;
  onSkip: (row: UnlinkedTransfer) => void;
}

function CertainPairRow({
  row,
  accountMap,
  handlers,
}: {
  row: UnlinkedTransfer;
  accountMap: Map<string, Account>;
  handlers: CertainHandlers;
}) {
  const { t } = useTranslation();
  const candidate = row.candidates[0];
  if (!candidate) return null;
  const [from, to] = pairInFlowOrder(row.activity, candidate.activity);
  return (
    <PairRow
      from={from}
      to={to}
      accountMap={accountMap}
      onOpen={() => handlers.onOpen(row)}
      testId="transfer-review-certain-row"
      actions={
        <>
          <RowButton
            icon
            busy={handlers.busyId === row.activity.id}
            disabled={handlers.disabled}
            label={t("activity:transfer_review.link")}
            onClick={() => handlers.onLink(row)}
          />
          <RowMenu
            disabled={handlers.disabled}
            items={[
              {
                label: t("activity:operations.more_details"),
                onClick: () => handlers.onOpen(row),
              },
              {
                label: t("activity:transfer_review.skip"),
                onClick: () => handlers.onSkip(row),
              },
            ]}
          />
        </>
      }
    />
  );
}

/**
 * A route's line, in a pair row's columns: its months, its accounts, its
 * total, and how many pairs it opens. Open, it is tinted like a section
 * heading, and its pairs follow below it.
 */
function RouteItem({
  route,
  accountMap,
  defaultOpen,
  handlers,
}: {
  route: AccountRoute;
  accountMap: Map<string, Account>;
  defaultOpen: boolean;
  handlers: CertainHandlers;
}) {
  const { t } = useTranslation();
  const routeDates = useRouteDates();
  const formatting = useAmountFormatting();
  const [open, setOpen] = useState(defaultOpen);
  const visible = useVisibleCount();
  const pairsId = useId();
  const name = (id: string) => accountMap.get(id)?.name ?? id;
  return (
    <li className="sm:contents" data-testid="transfer-review-route">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={pairsId}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          // Narrow: accounts and total, then the months and pair count below.
          "hover:bg-muted/50 grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 border-t px-4 py-2.5 text-start text-sm transition-colors md:px-5",
          SUBGRID,
          open && "bg-muted/40",
        )}
      >
        <span
          className={cn(
            "text-muted-foreground col-start-1 row-start-2 text-xs whitespace-nowrap tabular-nums sm:col-start-auto sm:row-start-auto sm:text-sm",
            FIRST_LINE,
          )}
        >
          {routeDates(route)}
        </span>
        {/*
          Wide: the halves of a pair row's From → To, so the route's accounts sit
          over its pairs'. Narrow: wraps rather than cutting names short.
        */}
        <span className="col-start-1 row-start-1 flex min-w-0 flex-wrap items-center gap-x-1.5 font-medium sm:col-start-auto sm:row-start-auto sm:grid sm:min-h-9 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:gap-x-3 sm:self-start">
          <span className="sm:truncate">{name(route.fromAccountId)}</span>
          <Icons.ArrowRight
            className="text-muted-foreground h-3.5 w-3.5 shrink-0 rtl:rotate-180"
            aria-hidden="true"
          />
          <span className="sm:truncate">{name(route.toAccountId)}</span>
        </span>
        <span
          className={cn(
            "col-start-2 row-start-1 text-end font-medium tabular-nums sm:col-start-auto sm:row-start-auto sm:justify-end",
            FIRST_LINE,
          )}
        >
          {route.total ? formatting.formatAmount(route.total.amount, route.total.currency) : null}
        </span>
        <span
          className={cn(
            "text-muted-foreground col-start-2 row-start-2 flex items-center justify-end gap-1 text-xs sm:col-start-auto sm:row-start-auto sm:gap-1.5 sm:text-sm",
            FIRST_LINE,
          )}
        >
          {t("activity:transfer_review.pair_count", { count: route.count })}
          <Icons.ChevronDown
            className={cn("h-4 w-4 transition-transform", open && "rotate-180")}
            aria-hidden="true"
          />
        </span>
      </button>
      {open ? (
        <ul id={pairsId} className="sm:contents">
          {route.rows.slice(0, visible.count).map((row) => (
            <CertainPairRow
              key={row.activity.id}
              row={row}
              accountMap={accountMap}
              handlers={handlers}
            />
          ))}
          {route.rows.length > visible.count ? (
            <li className="border-t sm:col-span-full">
              <ShowMoreButton onClick={visible.showMore} />
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

/** A card's heading, or at level 3 a section's within the card, a size smaller. */
function SectionHeading({
  id,
  level = 2,
  title,
  description,
  count,
  className,
}: {
  id?: string;
  level?: 2 | 3;
  title: string;
  description: string;
  count: number;
  className?: string;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  return (
    <div className={cn("min-w-0", level === 2 ? "space-y-1" : "space-y-0.5", className)}>
      <Heading
        id={id}
        className={cn(
          "flex items-center gap-2 font-semibold",
          level === 2 ? "text-base" : "text-sm",
        )}
      >
        {title}
        <Badge variant="secondary" className="text-2xs h-5 px-1.5 font-medium">
          {count}
        </Badge>
      </Heading>
      <p className={cn("text-muted-foreground max-w-2xl", level === 2 ? "text-sm" : "text-xs")}>
        {description}
      </p>
    </div>
  );
}

/** Up to this many certain pairs list as they are, without a summary by route. */
const FEW_PAIRS = 5;

/**
 * Certain pairs and Link all. Many pairs show by route, each opening its
 * pairs; a few are listed as they are.
 */
function ReadyToLinkCard({
  rows,
  accountMap,
  handlers,
  onLinkAll,
}: {
  rows: UnlinkedTransfer[];
  accountMap: Map<string, Account>;
  handlers: CertainHandlers;
  onLinkAll: () => void;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobileViewport();
  const routes = useMemo(() => accountRoutes(rows), [rows]);
  const few = rows.length <= FEW_PAIRS;

  const linkAllButton = (
    <Button
      onClick={onLinkAll}
      disabled={handlers.disabled}
      className={cn(isMobile && "w-full")}
      data-testid="transfer-review-link-all"
    >
      <Icons.Link className="me-2 h-4 w-4" />
      {t("activity:transfer_review.link_all", { count: rows.length })}
    </Button>
  );

  return (
    <section aria-labelledby="transfer-review-ready" className={cn(cardSurfaceClassName, SUBGRID)}>
      <div className="flex flex-wrap items-start justify-between gap-4 p-4 sm:col-span-full md:p-5">
        <SectionHeading
          id="transfer-review-ready"
          title={t("activity:transfer_review.certain_title")}
          description={t("activity:transfer_review.certain_desc", {
            count: rows.length,
          })}
          count={rows.length}
          className="flex-1 basis-80"
        />
        {isMobile ? null : linkAllButton}
      </div>

      {few ? (
        <ul className={SUBGRID} data-testid="transfer-review-pairs">
          {rows.map((row) => (
            <CertainPairRow
              key={row.activity.id}
              row={row}
              accountMap={accountMap}
              handlers={handlers}
            />
          ))}
        </ul>
      ) : (
        <ul className={SUBGRID} data-testid="transfer-review-routes">
          {routes.map((route) => (
            <RouteItem
              key={`${route.fromAccountId}-${route.toAccountId}`}
              route={route}
              accountMap={accountMap}
              // A single route opens: there is nothing else to choose between.
              defaultOpen={routes.length === 1}
              handlers={handlers}
            />
          ))}
        </ul>
      )}

      {isMobile ? (
        // Pinned above the tab bar while the pairs scroll past.
        <div className="bg-card/95 sticky bottom-(--mobile-nav-total-offset) z-10 rounded-b-(--card-radius) border-t p-3 backdrop-blur-md sm:col-span-full">
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
      className={cn(cardSurfaceClassName, "space-y-3 p-4 sm:col-span-full md:p-5")}
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
            <>
              <ul className={PAGE_COLUMNS} data-testid="transfer-review-failures">
                {failures.slice(0, visible.count).map(({ row, message }) => {
                  const [from, to] = pairInFlowOrder(row.activity, row.candidates[0].activity);
                  return (
                    <PairRow
                      key={row.activity.id}
                      from={from}
                      to={to}
                      accountMap={accountMap}
                      status={[{ tone: "warning", text: message }]}
                      testId="transfer-review-failure"
                    />
                  );
                })}
              </ul>
              {failures.length > visible.count ? (
                <ShowMoreButton onClick={visible.showMore} />
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
      <Button variant="outline" size="sm" onClick={onDismiss}>
        {t("activity:done")}
      </Button>
    </section>
  );
}

/** What to know about a pair in Needs a look, one line each. */
function pairStatus(t: TFunction, pair: ReviewPair, accountMap: Map<string, Account>): RowStatus[] {
  const status: RowStatus[] = [];
  if (pair.row.linkState === "broken_link") {
    status.push({
      tone: "warning",
      text: t("activity:transfer_review.state_broken_link"),
    });
  }
  const { candidate, rivals } = pair;
  if (!candidate) {
    status.push({ tone: "info", text: t("activity:transfer_review.no_match") });
    return status;
  }
  if (rivals.length === 1) {
    const account = accountMap.get(rivals[0].accountId)?.name ?? rivals[0].accountId;
    status.push({
      tone: "warning",
      text: t("activity:transfer_review.also_matches", { account }),
    });
  } else if (rivals.length > 1) {
    status.push({
      tone: "warning",
      text: t("activity:transfer_review.also_match_count", {
        count: rivals.length,
      }),
    });
  }
  // The rival line above already says there is another match.
  const warningCodes =
    rivals.length > 0
      ? candidate.warningCodes?.filter((warning) => warning.code !== "another_match")
      : candidate.warningCodes;
  for (const text of candidateWarnings(t, { ...candidate, warningCodes })) {
    status.push({ tone: "warning", text });
  }
  if (isMarkedExternal(candidate.activity)) {
    status.push({
      tone: "info",
      text: t("activity:transfer_review.marked_external_badge"),
    });
  }
  if (needsConversion(candidate)) {
    status.push({
      tone: "info",
      text: t("activity:transfer_review.converts_hint"),
    });
  }
  return status;
}

/** What a Needs a look row needs from the page. */
interface ReviewHandlers {
  busyId: string | null;
  disabled: boolean;
  onLink: (pair: ReviewPair) => void;
  onMarkExternal: (pair: ReviewPair) => void;
  onOpen: (pair: ReviewPair) => void;
  onSkip: (pair: ReviewPair) => void;
}

function ReviewPairRow({
  pair,
  accountMap,
  handlers,
}: {
  pair: ReviewPair;
  accountMap: Map<string, Account>;
  handlers: ReviewHandlers;
}) {
  const { t } = useTranslation();
  const { row, candidate } = pair;
  const [from, to]: [Activity | undefined, Activity | undefined] = candidate
    ? pairInFlowOrder(row.activity, candidate.activity)
    : isOutflow(row.activity)
      ? [row.activity, undefined]
      : [undefined, row.activity];
  const busy = handlers.busyId === pair.key;
  const account = accountMap.get(row.activity.accountId)?.name ?? row.activity.accountId;
  const skip = {
    label: t("activity:transfer_review.skip"),
    onClick: () => handlers.onSkip(pair),
  };
  return (
    <PairRow
      from={from}
      to={to}
      accountMap={accountMap}
      status={pairStatus(t, pair, accountMap)}
      onOpen={() => handlers.onOpen(pair)}
      actions={
        candidate ? (
          <>
            <RowButton
              icon
              busy={busy}
              disabled={handlers.disabled}
              label={t("activity:transfer_review.link")}
              onClick={() => handlers.onLink(pair)}
            />
            <RowMenu
              disabled={handlers.disabled}
              items={[
                {
                  label: t("activity:operations.more_details"),
                  onClick: () => handlers.onOpen(pair),
                },
                {
                  label: t("activity:transfer_review.mark_external_account", {
                    account,
                  }),
                  onClick: () => handlers.onMarkExternal(pair),
                },
                skip,
              ]}
            />
          </>
        ) : (
          <>
            <RowButton
              busy={busy}
              disabled={handlers.disabled}
              label={t("activity:transfer_review.mark_external")}
              onClick={() => handlers.onMarkExternal(pair)}
            />
            <RowMenu
              disabled={handlers.disabled}
              items={[
                {
                  label: t("activity:transfer_review.find_match"),
                  onClick: () => handlers.onOpen(pair),
                },
                skip,
              ]}
            />
          </>
        )
      }
    />
  );
}

/** Below this many pairs, Needs a look is one list rather than sections. */
const SECTION_MIN_ITEMS = 8;

const SECTION_KEYS: Record<ReviewReason, { title: string; hint: string }> = {
  dates_differ: {
    title: "activity:transfer_review.section_dates_differ",
    hint: "activity:transfer_review.section_dates_differ_hint",
  },
  more_than_one: {
    title: "activity:transfer_review.section_more_than_one",
    hint: "activity:transfer_review.section_more_than_one_hint",
  },
  cash_flow: {
    title: "activity:transfer_review.section_cash_flow",
    hint: "activity:transfer_review.section_cash_flow_hint",
  },
  other: {
    title: "activity:transfer_review.section_other",
    hint: "activity:transfer_review.section_other_hint",
  },
  no_match: {
    title: "activity:transfer_review.section_no_match",
    hint: "activity:transfer_review.section_no_match_hint",
  },
};

/**
 * Needs a look, in the same card and columns as Ready to link. Many pairs
 * split into sections by reason, each saying what to do; a few are one list
 * in the same order.
 */
function NeedsReviewCard({
  pairs,
  accountMap,
  handlers,
}: {
  pairs: ReviewPair[];
  accountMap: Map<string, Account>;
  handlers: ReviewHandlers;
}) {
  const { t } = useTranslation();
  const visible = useVisibleCount();
  const ordered = REVIEW_SECTIONS.flatMap((reason) =>
    pairs.filter((pair) => pair.reason === reason),
  );
  const sectioned = pairs.length >= SECTION_MIN_ITEMS;
  const shown = ordered.slice(0, visible.count);
  return (
    <section
      aria-labelledby="transfer-review-needs-look"
      className={cn(cardSurfaceClassName, SUBGRID)}
    >
      <div className="p-4 sm:col-span-full md:p-5">
        <SectionHeading
          id="transfer-review-needs-look"
          title={t("activity:transfer_review.needs_review_title")}
          description={t("activity:transfer_review.needs_review_desc")}
          count={pairs.length}
        />
      </div>
      <ul className={SUBGRID}>
        {shown.map((pair, index) => (
          <Fragment key={pair.key}>
            {sectioned && shown[index - 1]?.reason !== pair.reason ? (
              <li
                className="bg-muted/40 border-t px-4 py-3 sm:col-span-full md:px-5"
                data-testid={`transfer-review-section-${pair.reason}`}
              >
                <SectionHeading
                  level={3}
                  title={t(SECTION_KEYS[pair.reason].title)}
                  description={t(SECTION_KEYS[pair.reason].hint)}
                  count={ordered.filter((other) => other.reason === pair.reason).length}
                />
              </li>
            ) : null}
            <ReviewPairRow pair={pair} accountMap={accountMap} handlers={handlers} />
          </Fragment>
        ))}
      </ul>
      {ordered.length > visible.count ? (
        <div className="border-t sm:col-span-full">
          <ShowMoreButton onClick={visible.showMore} />
        </div>
      ) : null}
    </section>
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
  // Shares the assets query; its data keeps one identity between fetches.
  const { data: assets } = useQuery({ queryKey: [QueryKeys.ASSETS], queryFn: getAssets });
  const {
    data: rawReview,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: [QueryKeys.TRANSFER_REVIEW],
    queryFn: reviewTransferMatches,
  });
  const review = useMemo(
    () => (rawReview ? withAssetSymbols(rawReview, assets ?? []) : undefined),
    [rawReview, assets],
  );

  // Skipping hides a row for this visit only.
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<string | null>(null);
  // The pair or transfer whose details are open, and the other side to select.
  const [sheet, setSheet] = useState<{
    source: Activity;
    counterpartId?: string;
  } | null>(null);
  const [linkRun, setLinkRun] = useState<LinkRun | null>(null);
  const stopRequested = useRef(false);

  const certain = useMemo(
    () => (review?.certain ?? []).filter((row) => !skipped.has(row.activity.id)),
    [review, skipped],
  );
  const allPairs = useMemo(() => reviewPairs(review?.needsReview ?? []), [review]);
  const pairs = useMemo(
    () => allPairs.filter((pair) => !skipped.has(pair.key)),
    [allPairs, skipped],
  );

  const skippedCount =
    (review?.certain.length ?? 0) - certain.length + allPairs.length - pairs.length;
  // A certain pair skips by its row; a pair in Needs a look by its own key.
  const skip = (key: string) => setSkipped((current) => new Set(current).add(key));
  const linking = linkRun?.status === "running";
  const disabled = busy !== null || linking;

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

  /** Links `row` with `candidate`; `busyKey` names what shows the spinner. */
  const linkRow = async (
    row: UnlinkedTransfer,
    candidate: TransferMatchCandidate,
    busyKey = row.activity.id,
  ) => {
    setBusy(busyKey);
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

  const markExternal = async (activity: Activity, busyKey: string) => {
    setBusy(busyKey);
    try {
      // The same update as the activity form's "external" switch.
      await updateActivityMutation.mutateAsync(externalTransferUpdatePayload(activity));
      toast.success(t("activity:transfer_review.marked_external"));
    } catch {
      // The mutation reports its own failure.
    } finally {
      setBusy(null);
    }
  };

  /**
   * Opens Find match on a pair, its other side selected. It opens on the
   * side money left, as the row reads, except that a deposit or withdrawal
   * is the side the sheet converts, so it opens on that one.
   */
  const openPair = (row: UnlinkedTransfer, candidate?: TransferMatchCandidate) => {
    if (!candidate) {
      setSheet({ source: row.activity });
      return;
    }
    const [from, to] = needsConversion(candidate)
      ? [candidate.activity, row.activity]
      : pairInFlowOrder(row.activity, candidate.activity);
    setSheet({ source: from, counterpartId: to.id });
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
            <div className={cn("max-sm:space-y-8 sm:gap-y-8", PAGE_COLUMNS)}>
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
                  onLinkAll={() => void linkAll()}
                  handlers={{
                    busyId: busy,
                    disabled,
                    onLink: (row) => void linkRow(row, row.candidates[0]),
                    onOpen: (row) => openPair(row, row.candidates[0]),
                    onSkip: (row) => skip(row.activity.id),
                  }}
                />
              ) : null}

              {pairs.length > 0 ? (
                <NeedsReviewCard
                  pairs={pairs}
                  accountMap={accountMap}
                  handlers={{
                    busyId: busy,
                    disabled,
                    onLink: (pair) => {
                      if (pair.candidate) void linkRow(pair.row, pair.candidate, pair.key);
                    },
                    onMarkExternal: (pair) => void markExternal(pair.row.activity, pair.key),
                    onOpen: (pair) => openPair(pair.row, pair.candidate),
                    onSkip: (pair) => skip(pair.key),
                  }}
                />
              ) : null}
            </div>

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
        open={sheet !== null}
        mode="link"
        sourceActivity={sheet?.source ?? null}
        counterpartId={sheet?.counterpartId}
        accounts={accounts}
        onOpenChange={(open) => {
          if (!open) setSheet(null);
        }}
      />
    </Page>
  );
}
