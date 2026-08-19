import type React from "react";
import type { ComponentProps } from "react";
import { useMemo, useState } from "react";
import { Cell, Pie, PieChart, Sector, type PieSectorShapeProps } from "recharts";
import type { NameType, Payload, ValueType } from "recharts/types/component/DefaultTooltipContent";
import { useBalancePrivacy } from "../../hooks/use-balance-privacy";
import { useAmountFormatting, useNumberFormatting } from "../formatting-provider";
import { AmountDisplay } from "../financial/amount-display";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../ui/chart";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../ui/tooltip";

const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
  "var(--chart-7)",
  "var(--chart-8)",
  "var(--chart-9)",
];

const PADDING_ANGLE = 4;
const CORNER_RADIUS = 6;
const ACTIVE_RING_TRIM_ANGLE = 1;

interface ChartCenterLabelProps {
  activeData: { name: string; value: number; currency: string } | undefined;
  totalValue: number;
  isBalanceHidden: boolean;
}

const ChartCenterLabel: React.FC<ChartCenterLabelProps> = ({ activeData, totalValue, isBalanceHidden }) => {
  const { formatCompactAmount } = useAmountFormatting();
  const { formatPercent } = useNumberFormatting();
  if (!activeData) {
    return null;
  }

  const percent = totalValue > 0 ? activeData.value / totalValue : 0;
  const compactValue = isBalanceHidden ? "••••" : formatCompactAmount(activeData.value, activeData.currency);

  return (
    <TooltipProvider>
      <div className="pointer-events-auto absolute left-1/2 top-[108px] -translate-x-1/2 -translate-y-1/2 text-center">
        <p className="text-muted-foreground text-xs font-medium">{activeData.name}</p>
        <Tooltip delayDuration={100}>
          <TooltipTrigger asChild>
            <p className="text-foreground cursor-default text-xs font-bold">{compactValue}</p>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="text-center">
            <AmountDisplay value={activeData.value} currency={activeData.currency} isHidden={isBalanceHidden} />
          </TooltipContent>
        </Tooltip>
        <p className="text-muted-foreground text-xs">({formatPercent(percent)})</p>
      </div>
    </TooltipProvider>
  );
};

interface DonutChartProps {
  data: { name: string; value: number; currency: string }[];
  activeIndex: number;
  onSectionClick?: (data: { name: string; value: number; currency: string }, index: number) => void;
  startAngle?: number;
  endAngle?: number;
  displayTooltip?: boolean;
}

function renderActiveSector(props: PieSectorShapeProps) {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill } = props;
  if (
    typeof cx !== "number" ||
    typeof cy !== "number" ||
    typeof innerRadius !== "number" ||
    typeof outerRadius !== "number" ||
    typeof startAngle !== "number" ||
    typeof endAngle !== "number"
  ) {
    return <Sector {...props} />;
  }

  const direction = Math.sign(endAngle - startAngle) || 1;
  const angleSpan = Math.abs(endAngle - startAngle);
  const trimAngle = Math.min(ACTIVE_RING_TRIM_ANGLE, Math.max(0, angleSpan / 2 - 0.5));
  const ringGap = Math.max(2, (outerRadius - innerRadius) * 0.1);
  const ringThickness = Math.max(1.5, (outerRadius - innerRadius) * 0.07);

  return (
    <g>
      <Sector {...props} />
      {trimAngle > 0 && (
        <Sector
          cx={cx}
          cy={cy}
          innerRadius={outerRadius + ringGap}
          outerRadius={outerRadius + ringGap + ringThickness}
          startAngle={startAngle + direction * trimAngle}
          endAngle={endAngle - direction * trimAngle}
          fill={fill}
          cornerRadius={0}
        />
      )}
    </g>
  );
}

export const DonutChart: React.FC<DonutChartProps> = ({
  data,
  activeIndex,
  onSectionClick,
  startAngle = 180,
  endAngle = 0,
  displayTooltip = false,
}) => {
  const { isBalanceHidden } = useBalancePrivacy();
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const handlePieEnter = (_: React.MouseEvent, index: number) => {
    setHoverIndex(index);
  };

  const handleMouseLeave = () => {
    setHoverIndex(null);
  };

  const totalValue = useMemo(() => data.reduce((acc, item) => acc + item.value, 0), [data]);
  const displayIndex = hoverIndex ?? activeIndex;
  const activeData = data[displayIndex];

  const tooltipFormatter = (
    value: ValueType | undefined,
    name: NameType | undefined,
    entry: Payload<ValueType, NameType>,
  ) => {
    const payload = entry.payload as { currency: string };
    return (
      <div className="flex flex-col">
        <span className="text-muted-foreground text-[0.70rem] uppercase">{name}</span>
        <span className="font-bold">
          <AmountDisplay value={Number(value ?? 0)} currency={payload.currency} isHidden={isBalanceHidden} />
        </span>
      </div>
    );
  };

  type PieComponentProps = ComponentProps<typeof Pie>;

  const pieProps = {
    data,
    cy: "80%",
    innerRadius: "110%",
    outerRadius: "140%",
    paddingAngle: PADDING_ANGLE,
    cornerRadius: CORNER_RADIUS,
    dataKey: "value",
    nameKey: "name",
    onMouseEnter: handlePieEnter,
    onClick: (_data, index, event) => {
      if (onSectionClick && data[index]) {
        event?.stopPropagation?.();
        onSectionClick(data[index], index);
      }
    },
    startAngle,
    endAngle,
    activeIndex: displayIndex,
    activeShape: renderActiveSector,
    isAnimationActive: false,
  } as PieComponentProps;

  return (
    <div className="relative h-[160px] w-full p-0">
      <ChartContainer config={{}} className="h-full w-full">
        <PieChart onMouseLeave={handleMouseLeave} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
          {displayTooltip && (
            <ChartTooltip
              cursor={{ fill: "var(--muted)", opacity: 0.3 }}
              content={<ChartTooltipContent formatter={tooltipFormatter} hideLabel hideIndicator />}
              position={{ y: 0 }}
            />
          )}
          <Pie {...pieProps}>
            {data.map((_, index) => (
              <Cell
                key={`cell-${index}`}
                fill={COLORS[index % COLORS.length]}
                style={{ cursor: onSectionClick ? "pointer" : "default" }}
              />
            ))}
          </Pie>
        </PieChart>
      </ChartContainer>
      <ChartCenterLabel activeData={activeData} totalValue={totalValue} isBalanceHidden={isBalanceHidden} />
    </div>
  );
};
