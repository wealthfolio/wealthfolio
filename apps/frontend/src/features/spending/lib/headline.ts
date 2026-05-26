/**
 * Headline composition for the "What changed" view.
 *
 * `buildHeadline` is the only place that decides what the narrative says.
 * It reads period state + per-category descriptors and emits a structured
 * model. Components render the fragments — they don't decide content.
 */

import {
  MIN_DRIVER_CONCENTRATION,
  type ChangeDescriptor,
  type PeriodState,
} from "./change-descriptor";

export type HeadlineFragmentTone = "up" | "down" | "neutral";

/** A typed fragment of the narrative — components decide colors/arrows. */
export type HeadlineFragment =
  | { type: "text"; text: string }
  | { type: "amount"; value: number; tone: HeadlineFragmentTone }
  | { type: "mover"; descriptor: HeadlineMover; tone: HeadlineFragmentTone };

export interface HeadlineMover {
  id: string;
  name: string;
  descriptor: ChangeDescriptor;
}

export interface HeadlineModel {
  /** Used by the meta line above the headline. */
  metaLabel: string;
  /** Narrative paragraph, broken into fragments for styled rendering. */
  fragments: HeadlineFragment[];
  /** Compact comparison line — replaces the 4-stat strip. */
  summary: HeadlineSummary | null;
}

export interface HeadlineSummary {
  current: number;
  prior: number | null;
  delta: number | null;
  pct: number | null;
  showPct: boolean;
}

export interface BuildHeadlineInput {
  periodState: PeriodState;
  movers: (ChangeDescriptor & { id: string; name: string })[];
  currentTotal: number;
  priorTotal: number;
  priorLabel: string;
  metaLabel: string;
}

export function buildHeadline(input: BuildHeadlineInput): HeadlineModel {
  const { periodState, movers, currentTotal, priorTotal, priorLabel, metaLabel } = input;

  if (periodState.kind === "no_activity_either_side") {
    return {
      metaLabel,
      fragments: [{ type: "text", text: "No spending recorded in this window." }],
      summary: null,
    };
  }

  if (periodState.kind === "no_prior_period") {
    return {
      // Suppress the meta label when there's nothing to compare against.
      metaLabel: "",
      fragments: [
        { type: "text", text: "You spent " },
        { type: "amount", value: currentTotal, tone: "neutral" },
        {
          type: "text",
          text: " this period. No prior data to compare against.",
        },
      ],
      // No summary line in this state — the narrative already carries the total.
      summary: null,
    };
  }

  // valid_comparison from here on.
  const netDelta = currentTotal - priorTotal;
  const direction: HeadlineFragmentTone = netDelta >= 0 ? "up" : "down";
  const directionWord = netDelta >= 0 ? "more" : "less";

  // Total Δ% has its own noise guard (we use the same base threshold as
  // per-category, applied to total spend).
  const summaryShowPct = priorTotal > 0 && Math.abs(netDelta) >= priorTotal * 0.005;
  const summary: HeadlineSummary = {
    current: currentTotal,
    prior: priorTotal,
    delta: netDelta,
    pct: priorTotal > 0 ? (netDelta / priorTotal) * 100 : null,
    showPct: summaryShowPct,
  };

  // Lead sentence: "You spent CA$X more/less than {priorLabel}."
  const lead: HeadlineFragment[] = [
    { type: "text", text: "You spent " },
    {
      type: "amount",
      value: Math.abs(netDelta),
      tone: netDelta === 0 ? "neutral" : direction,
    },
    {
      type: "text",
      text: ` ${directionWord} than ${priorLabel}.`,
    },
  ];

  if (netDelta === 0 || movers.length === 0) {
    return { metaLabel, fragments: lead, summary };
  }

  // Driver sentence.
  // Filter out no-activity rows; rank already applied upstream.
  const significantMovers = movers.filter((m) => m.kind !== "no_activity" && m.absDelta > 0);

  if (significantMovers.length === 0) {
    return { metaLabel, fragments: lead, summary };
  }

  const top = significantMovers[0];
  // Concentration gate: if no row owns enough of the movement, don't claim a driver.
  if ((top.shareOfMovement ?? 0) < MIN_DRIVER_CONCENTRATION) {
    return {
      metaLabel,
      fragments: [
        ...lead,
        { type: "text", text: " " },
        {
          type: "text",
          text: "Spending shifted across several categories, no single driver.",
        },
      ],
      summary,
    };
  }

  const topTone: HeadlineFragmentTone = top.delta >= 0 ? "up" : "down";
  const driverWord = netDelta >= 0 ? "rise" : "drop";

  const topMover: HeadlineMover = { id: top.id, name: top.name, descriptor: top };

  const driverFragments: HeadlineFragment[] = [
    { type: "text", text: ` Most of the ${driverWord} came from ` },
    { type: "mover", descriptor: topMover, tone: topTone },
    { type: "text", text: "." },
  ];

  // Optional second mover, only when it moves opposite the net direction and is material.
  const second = significantMovers
    .slice(1)
    .find(
      (m) =>
        Math.sign(m.delta) !== Math.sign(netDelta) &&
        (m.shareOfMovement ?? 0) >= MIN_DRIVER_CONCENTRATION,
    );
  if (second) {
    const secondTone: HeadlineFragmentTone = second.delta >= 0 ? "up" : "down";
    driverFragments.push(
      { type: "text", text: " " },
      {
        type: "mover",
        descriptor: { id: second.id, name: second.name, descriptor: second },
        tone: secondTone,
      },
      { type: "text", text: " went the other way." },
    );
  }

  return {
    metaLabel,
    fragments: [...lead, ...driverFragments],
    summary,
  };
}
