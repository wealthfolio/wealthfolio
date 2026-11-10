import { TickerAvatar } from "@/components/ticker-avatar";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import type { Holding } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  AmountDisplay,
  Card,
  CardContent,
  CardHeader,
  Icons,
  useNumberFormatting,
} from "@wealthfolio/ui";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { HighlightTitle } from "./holdings-highlight-cards";
import { getHoldingsDonut, spreadChipAngles, type HoldingsDonutSlice } from "./holdings-highlights";

interface HoldingsDonutCardProps {
  holdings: Holding[];
  currency: string;
  isLoading: boolean;
}

// Geometry in viewBox units (0–100), so chip positions double as CSS percentages.
const CENTER = 50;
const RING_RADIUS = 31;
const RING_WIDTH = 8;
const CHIP_RADIUS = 42;
const GAP_DEGREES = 1.2;
const CHIP_SPACING_PX = 4;

function polar(radius: number, degrees: number) {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return { x: CENTER + radius * Math.cos(radians), y: CENTER + radius * Math.sin(radians) };
}

function arcPath(start: number, end: number) {
  const from = polar(RING_RADIUS, start);
  const to = polar(RING_RADIUS, end);
  const largeArc = end - start > 180 ? 1 : 0;
  return `M ${from.x} ${from.y} A ${RING_RADIUS} ${RING_RADIUS} 0 ${largeArc} 1 ${to.x} ${to.y}`;
}

function sliceColor(slice: HoldingsDonutSlice, index: number) {
  if (slice.kind === "other")
    return "color-mix(in oklab, var(--muted-foreground) 40%, var(--card))";
  if (slice.kind === "cash") return "var(--chart-8)";
  return `var(--chart-${(index % 7) + 1})`;
}

function SliceBadge({ slice, currency }: { slice: HoldingsDonutSlice; currency: string }) {
  if (slice.kind === "cash") {
    // Same avatar as cash rows in the holdings list; mixed currencies use the base one.
    const cashCurrency = slice.currencies.length === 1 ? slice.currencies[0] : currency;
    return <TickerAvatar symbol={`CASH:${cashCurrency}`} className="size-6 shrink-0" />;
  }
  if (slice.kind === "holding") {
    const instrument = slice.holding.instrument;
    return (
      <TickerAvatar
        symbol={instrument?.symbol ?? slice.holding.id}
        exchangeMic={instrument?.exchangeMic}
        instrumentType={instrument?.instrumentType}
        assetId={instrument?.id}
        className="size-6 shrink-0"
      />
    );
  }
  return (
    <span className="bg-foreground text-background flex size-6 shrink-0 items-center justify-center rounded-full">
      <Icons.Ellipsis className="size-3.5" aria-hidden="true" />
    </span>
  );
}

export function HoldingsDonutCard({ holdings, currency, isLoading }: HoldingsDonutCardProps) {
  const { t } = useTranslation();
  const formatting = useNumberFormatting();
  const { isBalanceHidden } = useBalancePrivacy();
  const donut = useMemo(() => getHoldingsDonut(holdings), [holdings]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  // Chips keep their pixel size while the ring scales with the card, so spacing is
  // measured in chart units from the rendered chips (font and text size included).
  const [chipBox, setChipBox] = useState({ width: 26, height: 11 });

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const measure = () => {
      const size = group.clientWidth;
      if (!size) return;
      const chips = [...group.querySelectorAll<HTMLElement>("[data-chip]")];
      const toUnits = (pixels: number) => ((pixels + CHIP_SPACING_PX) / size) * 100;
      const width = toUnits(Math.max(0, ...chips.map((chip) => chip.offsetWidth)));
      const height = toUnits(Math.max(0, ...chips.map((chip) => chip.offsetHeight)));
      setChipBox((previous) =>
        Math.abs(previous.width - width) < 0.5 && Math.abs(previous.height - height) < 0.5
          ? previous
          : { width, height },
      );
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, [donut, isBalanceHidden]);

  const geometry = useMemo(() => {
    if (!donut) return [];
    const gap = donut.slices.length > 1 ? GAP_DEGREES : 0;
    let cursor = 0;
    const arcs = donut.slices.map((slice) => {
      const sweep = slice.weight * 360;
      const start = cursor + gap / 2;
      const end = Math.max(start + 0.2, cursor + sweep - gap / 2);
      cursor += sweep;
      return { start, end, mid: (start + end) / 2 };
    });
    const chipAngles = spreadChipAngles(
      arcs.map((arc) => arc.mid),
      { radius: CHIP_RADIUS, ...chipBox },
    );
    return arcs.map((arc, index) => ({ ...arc, chip: polar(CHIP_RADIUS, chipAngles[index]) }));
  }, [donut, chipBox]);

  const label = (slice: HoldingsDonutSlice) =>
    slice.kind === "holding"
      ? slice.holding.instrument?.name?.trim() ||
        slice.holding.instrument?.symbol ||
        slice.holding.id
      : slice.kind === "cash"
        ? t("holdings:cash")
        : t("insights:highlights.other_holdings", { count: slice.count });
  const percent = (value: number) => (isBalanceHidden ? "••••" : formatting.formatPercent(value));
  const active = donut?.slices.find((slice) => slice.id === activeId);
  const title = t("insights:highlights.holdings");

  return (
    <Card>
      <CardHeader className="pb-0">
        <HighlightTitle title={title} description={t("insights:highlights.portfolio_share")} />
      </CardHeader>
      <CardContent className="px-10 pt-2 pb-6">
        {isLoading ? (
          <div className="mx-auto aspect-square w-full max-w-[20rem] p-[12%]">
            <div className="border-muted size-full animate-pulse rounded-full border-[1.75rem] motion-reduce:animate-none" />
          </div>
        ) : donut && donut.slices.length > 0 ? (
          // Positions follow the chart's geometry, so they stay physical in RTL.
          <div
            ref={groupRef}
            role="group"
            aria-label={title}
            className="relative mx-auto aspect-square w-full max-w-[20rem]"
            onPointerLeave={() => setActiveId(null)}
          >
            <svg viewBox="0 0 100 100" className="size-full overflow-visible" aria-hidden="true">
              {donut.slices.length === 1 ? (
                <circle
                  cx={CENTER}
                  cy={CENTER}
                  r={RING_RADIUS}
                  fill="none"
                  stroke={sliceColor(donut.slices[0], 0)}
                  strokeWidth={RING_WIDTH}
                />
              ) : (
                donut.slices.map((slice, index) => (
                  <path
                    key={slice.id}
                    d={arcPath(geometry[index].start, geometry[index].end)}
                    fill="none"
                    stroke={sliceColor(slice, index)}
                    strokeWidth={activeId === slice.id ? RING_WIDTH + 2.5 : RING_WIDTH}
                    className={cn(
                      "cursor-pointer transition-[opacity,stroke-width] duration-200 motion-reduce:transition-none",
                      activeId && activeId !== slice.id && "opacity-35",
                    )}
                    onPointerEnter={() => setActiveId(slice.id)}
                  />
                ))
              )}
            </svg>

            <div className="pointer-events-none absolute inset-[24%] flex flex-col items-center justify-center gap-1.5 text-center">
              <AmountDisplay
                value={active?.value ?? donut.total}
                currency={currency}
                isHidden={isBalanceHidden}
                className="text-lg font-semibold tabular-nums"
              />
              <span className="text-muted-foreground line-clamp-2 max-w-full text-xs">
                {active
                  ? label(active)
                  : t("insights:highlights.holdings_count", { count: donut.holdingCount })}
              </span>
              {active && (
                <span className="text-muted-foreground text-xs font-medium tabular-nums">
                  {percent(active.weight)}
                </span>
              )}
            </div>

            {donut.slices.map((slice, index) => {
              const { chip } = geometry[index];
              const target =
                slice.kind === "holding" && slice.holding.instrument?.id
                  ? `/holdings/${encodeURIComponent(slice.holding.instrument.id)}`
                  : "/holdings";
              return (
                <Link
                  key={slice.id}
                  to={target}
                  data-chip
                  aria-label={`${label(slice)}: ${percent(slice.weight)}`}
                  style={{ left: `${chip.x}%`, top: `${chip.y}%` }}
                  className={cn(
                    "bg-card absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full border py-0.5 ps-0.5 pe-2 shadow-sm",
                    "focus-visible:ring-ring transition-opacity duration-200 outline-none focus-visible:ring-2 motion-reduce:transition-none",
                    activeId && activeId !== slice.id && "opacity-50",
                  )}
                  onPointerEnter={() => setActiveId(slice.id)}
                  onFocus={() => setActiveId(slice.id)}
                  onBlur={() => setActiveId(null)}
                >
                  <SliceBadge slice={slice} currency={currency} />
                  <span className="text-muted-foreground text-xs font-medium tabular-nums">
                    {percent(slice.weight)}
                  </span>
                </Link>
              );
            })}
          </div>
        ) : (
          <p className="text-muted-foreground py-6 text-sm">
            {t("insights:highlights.holdings_unavailable")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
