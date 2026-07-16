import { DashboardCard } from "@/components/dashboard-card";
import { useTranslation } from "react-i18next";
import { CompactAmount } from "./compact-amount";
import { toneClass, toneFill, type Momentum } from "./utils";

const PRIOR_BAR_COLOR = "color-mix(in srgb, var(--muted-foreground) 35%, transparent)";

function monthLabel(month: string): string {
  // month is "YYYY-MM"
  const date = new Date(`${month}-01T00:00:00`);
  return date.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

interface MomentumCardProps {
  momentum: Momentum;
  currency: string;
  periodLabel: string;
}

export function MomentumCard({ momentum, currency, periodLabel }: MomentumCardProps) {
  const { t } = useTranslation();
  const { currentChange, beatBy, bars } = momentum;
  const changeSign = Math.abs(currentChange) < 0.005 ? "" : currentChange > 0 ? "+" : "-";

  // Split the chart height around a zero axis: positives rise above it,
  // negatives drop below. Zones are sized by the largest swing on each side.
  const maxPos = Math.max(0, ...bars.map((b) => b.value));
  const maxNeg = Math.max(0, ...bars.map((b) => -b.value));
  const totalSwing = maxPos + maxNeg || 1;
  const posZone = (maxPos / totalSwing) * 100;
  const negZone = (maxNeg / totalSwing) * 100;
  const barColor = (value: number, current: boolean) =>
    current ? toneFill(value) : PRIOR_BAR_COLOR;

  return (
    <DashboardCard
      title={t("insights:networth.momentum.title")}
      meta={
        beatBy == null
          ? t("insights:networth.momentum.all_time")
          : t("insights:networth.momentum.vs_prior", { period: periodLabel })
      }
    >
      <div className={`text-lg font-bold tabular-nums ${toneClass(currentChange)}`}>
        {changeSign}
        <CompactAmount value={Math.abs(currentChange)} currency={currency} />
      </div>
      {beatBy != null && (
        <p className="text-muted-foreground mt-0.5 text-xs">
          {beatBy >= 0
            ? t("insights:networth.momentum.beat_prior")
            : t("insights:networth.momentum.behind_prior")}
          <span className={`font-semibold ${toneClass(beatBy)}`}>
            <CompactAmount value={Math.abs(beatBy)} currency={currency} />
          </span>
        </p>
      )}

      {bars.length > 1 && (
        <>
          <div className="relative mt-4 h-16">
            {/* Zero axis (only meaningful when there are negative months) */}
            {negZone > 0.5 && (
              <div
                className="bg-border/50 absolute inset-x-0 h-px"
                style={{ top: `${posZone}%` }}
              />
            )}
            <div className="flex h-full items-stretch gap-1">
              {bars.map((bar) => {
                const title = `${monthLabel(bar.month)}: ${bar.value >= 0 ? "+" : ""}${bar.value.toFixed(0)}`;
                return (
                  <div key={bar.month} className="flex flex-1 flex-col" title={title}>
                    {/* above-zero zone */}
                    <div className="flex items-end" style={{ height: `${posZone}%` }}>
                      {bar.value > 0 && maxPos > 0 && (
                        <div
                          className="w-full rounded-t-sm"
                          style={{
                            height: `${Math.max(8, (bar.value / maxPos) * 100)}%`,
                            backgroundColor: barColor(bar.value, bar.current),
                          }}
                        />
                      )}
                    </div>
                    {/* below-zero zone */}
                    <div className="flex items-start" style={{ height: `${negZone}%` }}>
                      {bar.value < 0 && maxNeg > 0 && (
                        <div
                          className="w-full rounded-b-sm"
                          style={{
                            height: `${Math.max(8, (-bar.value / maxNeg) * 100)}%`,
                            backgroundColor: barColor(bar.value, bar.current),
                          }}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="text-muted-foreground/60 mt-1.5 flex justify-between text-xs">
            <span>{monthLabel(bars[0].month)}</span>
            <span>{t("insights:networth.momentum.now")}</span>
          </div>
        </>
      )}
    </DashboardCard>
  );
}
