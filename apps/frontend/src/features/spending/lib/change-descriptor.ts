/**
 * Semantic comparison layer for spending reports.
 *
 * The dashboard renders states, not raw values. Each category change is
 * classified by `describeChange`; each period is classified by `classifyPeriod`.
 * UI surfaces (headline, pills, table cells) read from these descriptors —
 * never raw deltas — so "up 0%" / "down 100%" / "new" / "ended" all render
 * with the right copy and meaning.
 *
 * The descriptor carries no localized copy, no tone, no arrows. Those are
 * presentation concerns and stay in components.
 */

export type ChangeKind = "no_activity" | "new" | "ended" | "valid";

export interface ChangeDescriptor {
  kind: ChangeKind;
  current: number;
  prior: number;
  delta: number;
  absDelta: number;
  pct: number | null;
  showPct: boolean;
  /** |delta| / Σ|delta| — share of total movement across all categories. */
  shareOfMovement: number | null;
  /** |delta| / |Σ delta| — only when sign matches the net direction. */
  shareOfNetChange: number | null;
  /** current / currentTotal — for "X% of this period's spend". */
  shareOfSpend: number | null;
  /** Used everywhere for sorting and top-mover selection. */
  rankValue: number;
}

export type PeriodState =
  | { kind: "no_prior_period" }
  | { kind: "no_activity_either_side" }
  | { kind: "valid_comparison" };
// `incomplete_prior_period` is deferred — needs per-month coverage metadata
// (earliestTransactionDate / accountConnectedAt / monthly tx counts).

/** Suppress percentages when the prior denominator is below this many units. */
export const MIN_PRIOR_FOR_PCT = 50;
/** Suppress percentages when |Δ| is below this share of the larger period total. */
export const MIN_DELTA_SHARE_OF_BASE = 0.015;
/** Top mover must own at least this share of movement to claim driver status. */
export const MIN_DRIVER_CONCENTRATION = 0.25;

export interface ClassifyPeriodInput {
  currentTotal: number;
  priorTotal: number;
  currentTransactionCount: number;
  priorTransactionCount: number;
}

export function classifyPeriod({
  currentTotal,
  priorTotal,
  currentTransactionCount,
  priorTransactionCount,
}: ClassifyPeriodInput): PeriodState {
  if (
    currentTransactionCount === 0 &&
    priorTransactionCount === 0 &&
    currentTotal === 0 &&
    priorTotal === 0
  ) {
    return { kind: "no_activity_either_side" };
  }
  if (priorTransactionCount === 0 && priorTotal === 0) {
    return { kind: "no_prior_period" };
  }
  return { kind: "valid_comparison" };
}

export interface DescribeChangeInput {
  current: number;
  prior: number;
  currentPeriodTotal: number;
  priorPeriodTotal: number;
  /** Σ |delta_i| across all categories in this comparison. */
  totalAbsoluteMovement: number;
  /** Σ delta_i — signed net change across all categories. */
  netChange: number;
}

export function describeChange(input: DescribeChangeInput): Omit<ChangeDescriptor, "kind"> & {
  kind: ChangeKind;
} {
  const { current, prior, currentPeriodTotal, totalAbsoluteMovement, netChange } = input;
  const delta = current - prior;
  const absDelta = Math.abs(delta);

  const shareOfMovement = totalAbsoluteMovement > 0 ? absDelta / totalAbsoluteMovement : null;
  const shareOfNetChange =
    Math.abs(netChange) > 0 && Math.sign(delta) === Math.sign(netChange)
      ? absDelta / Math.abs(netChange)
      : null;
  const shareOfSpend = currentPeriodTotal > 0 ? current / currentPeriodTotal : null;

  const base: Omit<ChangeDescriptor, "kind" | "pct" | "showPct"> = {
    current,
    prior,
    delta,
    absDelta,
    shareOfMovement,
    shareOfNetChange,
    shareOfSpend,
    rankValue: absDelta,
  };

  if (current === 0 && prior === 0) {
    return {
      ...base,
      kind: "no_activity",
      pct: null,
      showPct: false,
      rankValue: 0,
    };
  }
  if (prior === 0 && current > 0) {
    return { ...base, kind: "new", pct: null, showPct: false };
  }
  if (prior > 0 && current === 0) {
    return { ...base, kind: "ended", pct: null, showPct: false };
  }

  const pct = (delta / prior) * 100;
  const totalBase = Math.max(input.currentPeriodTotal, input.priorPeriodTotal);
  const showPct = prior >= MIN_PRIOR_FOR_PCT && absDelta >= totalBase * MIN_DELTA_SHARE_OF_BASE;

  return {
    ...base,
    kind: "valid",
    pct,
    showPct,
  };
}

export interface CategoryAggregate {
  id: string;
  current: number;
  prior: number;
}

/**
 * Convenience: classify every category in one pass and pre-compute the
 * movement/net values they share.
 */
export function describeCategories(
  rows: CategoryAggregate[],
  currentPeriodTotal: number,
  priorPeriodTotal: number,
): (ChangeDescriptor & { id: string })[] {
  let totalAbsoluteMovement = 0;
  let netChange = 0;
  for (const r of rows) {
    const d = r.current - r.prior;
    totalAbsoluteMovement += Math.abs(d);
    netChange += d;
  }

  return rows
    .map((r) => ({
      ...describeChange({
        current: r.current,
        prior: r.prior,
        currentPeriodTotal,
        priorPeriodTotal,
        totalAbsoluteMovement,
        netChange,
      }),
      id: r.id,
    }))
    .sort((a, b) => b.rankValue - a.rankValue);
}
