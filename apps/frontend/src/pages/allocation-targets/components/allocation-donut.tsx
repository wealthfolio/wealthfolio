import type { DriftRow } from "@/lib/types";
import { formatCompactAmount } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";
import { Sector } from "recharts";
import {
  allocationTargetColorForRow,
  type AllocationTargetColorMap,
} from "./allocation-target-colors";

interface AllocationDonutProps {
  rows: DriftRow[];
  colorByCategory?: AllocationTargetColorMap;
  totalValue: number;
  currency: string;
  size?: number;
  hoveredId?: string | null;
  onHoverChange?: (id: string | null) => void;
}

const PADDING_ANGLE = 3;
const CORNER_RADIUS = 6;

export function AllocationDonut({
  rows,
  colorByCategory,
  totalValue,
  currency,
  size = 240,
  hoveredId,
  onHoverChange,
}: AllocationDonutProps) {
  const { t } = useTranslation();
  const thickness = Math.round(size * 0.11);
  const outerR = size / 2 - 8;
  const innerR = outerR - thickness;
  const cx = size / 2;
  const cy = size / 2;
  const visibleRows = rows.filter((r) => r.currentBps > 0);
  const total = visibleRows.reduce((s, r) => s + r.currentBps, 0) || 10000;

  let accDeg = 0;
  const segments = visibleRows.map((r, index) => {
    const span = (r.currentBps / total) * 360;
    const gap = visibleRows.length > 1 ? Math.min(PADDING_ANGLE, span * 0.35) : 0;
    const rawStart = accDeg;
    const rawEnd = accDeg + span;
    const startAngle = 90 - rawStart - gap / 2;
    const endAngle = 90 - rawEnd + gap / 2;
    accDeg = rawEnd;
    const midAngle = 90 - (rawStart + span / 2);
    const midRad = (-midAngle * Math.PI) / 180;
    return {
      ...r,
      color: allocationTargetColorForRow(r, colorByCategory, index),
      startAngle,
      endAngle,
      midRad,
    };
  });

  const hoveredRow = hoveredId ? rows.find((r) => r.categoryId === hoveredId) : null;
  const popDist = 5;

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ overflow: "visible" }}
      >
        {segments.map((s) => {
          const isHovered = hoveredId === s.categoryId;
          const dimmed = hoveredId !== null && !isHovered;
          const tx = isHovered ? (popDist * Math.cos(s.midRad)).toFixed(2) : "0";
          const ty = isHovered ? (popDist * Math.sin(s.midRad)).toFixed(2) : "0";
          return (
            <Sector
              key={s.categoryId}
              cx={cx}
              cy={cy}
              innerRadius={innerR}
              outerRadius={outerR}
              startAngle={s.startAngle}
              endAngle={s.endAngle}
              data-category-id={s.categoryId}
              fill={s.color || "var(--muted-foreground)"}
              cornerRadius={CORNER_RADIUS}
              opacity={dimmed ? 0.3 : 1}
              transform={`translate(${tx}, ${ty})`}
              style={{ transition: "opacity 0.15s ease, transform 0.12s ease", cursor: "pointer" }}
              onMouseEnter={() => onHoverChange?.(s.categoryId)}
              onMouseLeave={() => onHoverChange?.(null)}
            />
          );
        })}
      </svg>

      {/* Center label */}
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        {hoveredRow ? (
          <>
            <div className="text-muted-foreground max-w-[75%] truncate text-[10px] uppercase tracking-wider">
              {hoveredRow.categoryName}
            </div>
            <div
              className="text-foreground mt-0.5 font-semibold tabular-nums"
              style={{ fontSize: Math.round(size * 0.1) }}
            >
              {(hoveredRow.currentBps / 100).toFixed(1)}%
            </div>
            <div
              className="text-muted-foreground mt-0.5 tabular-nums"
              style={{ fontSize: Math.round(size * 0.052) }}
            >
              {formatCompactAmount((hoveredRow.currentBps / 10000) * totalValue, currency)}
            </div>
            {hoveredRow.status !== "in_band" && (
              <div
                className="mt-1 text-[10px] font-semibold uppercase tracking-wide"
                style={{
                  color:
                    hoveredRow.status === "overweight" || hoveredRow.status === "not_targeted"
                      ? "var(--destructive)"
                      : "#2563eb",
                }}
              >
                {hoveredRow.status === "underweight"
                  ? t("allocation:donut.belowTarget")
                  : t("allocation:donut.aboveTarget")}
              </div>
            )}
          </>
        ) : (
          <>
            <div className="text-muted-foreground text-[10px] uppercase tracking-wider">
              {t("allocation:donut.portfolio")}
            </div>
            <div
              className="text-foreground mt-1 font-semibold tabular-nums"
              style={{ fontSize: Math.round(size * 0.09) }}
            >
              {formatCompactAmount(totalValue, currency)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
