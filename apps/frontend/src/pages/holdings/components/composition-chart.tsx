import { RenderableChartContainer } from "@/components/renderable-chart-container";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { getBaseHoldingPerformancePercentForMode } from "@/lib/holding-performance";
import { useSettingsContext } from "@/lib/settings-provider";
import { Holding } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  AmountDisplay,
  AnimatedToggleGroup,
  useDateFormatting,
  useNumberFormatting,
} from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@wealthfolio/ui/components/ui/empty";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { useMemo, useSyncExternalStore, type FC } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Tooltip as ChartTooltip, Treemap, type TreemapNode } from "recharts";
import {
  fallbackPalette,
  getTreemapColor,
  getTreemapPaletteSnapshot,
  subscribeToTreemapTheme,
  type ReturnType,
  type TreemapPalette,
} from "./treemap-palette";

type DisplayMode = "symbol" | "name";

const DisplayModeToggle: React.FC<{
  displayMode: DisplayMode;
  onToggle: () => void;
}> = ({ displayMode, onToggle }) => {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="secondary"
            size="icon-sm"
            className="rounded-full"
            onClick={onToggle}
            aria-label={
              displayMode === "symbol" ? t("holdings:show_full_names") : t("holdings:show_symbols")
            }
          />
        }
      >
        {displayMode === "symbol" ? (
          <Icons.Hash className="h-4 w-4" />
        ) : (
          <Icons.Type className="h-4 w-4" />
        )}
      </TooltipTrigger>
      <TooltipContent>
        <p>
          {displayMode === "symbol" ? t("holdings:show_full_names") : t("holdings:show_symbols")}
        </p>
      </TooltipContent>
    </Tooltip>
  );
};

// Function to truncate text based on available width
function truncateText(text: string, maxWidth: number, fontSize: number): string {
  if (!text) return "";

  // Approximate character width based on fontSize (rough estimate)
  const charWidth = fontSize * 0.6;
  const maxChars = Math.floor(maxWidth / charWidth);

  if (text.length <= maxChars) return text;

  // If we need to truncate, leave space for "..."
  const truncatedLength = Math.max(1, maxChars - 3);
  return text.substring(0, truncatedLength) + "...";
}

interface CustomizedContentProps {
  depth?: TreemapNode["depth"];
  x?: TreemapNode["x"];
  y?: TreemapNode["y"];
  width?: TreemapNode["width"];
  height?: TreemapNode["height"];
  id?: string; // Asset ID for navigation
  symbol?: string;
  name?: TreemapNode["name"];
  gain?: number;
  displayMode?: DisplayMode;
  returnType?: ReturnType;
  palette?: TreemapPalette;
}

const CustomizedContent: FC<CustomizedContentProps> = ({
  depth = 0,
  x = 0,
  y = 0,
  width = 0,
  height = 0,
  id,
  symbol,
  name,
  gain = 0,
  displayMode = "symbol",
  returnType = "daily",
  palette = fallbackPalette,
}) => {
  const formatting = useNumberFormatting();
  const fontSize = Math.min(width, height) < 80 ? Math.min(width, height) * 0.16 : 13;
  const fontSize2 = Math.min(width, height) < 80 ? Math.min(width, height) * 0.14 : 12;
  const { fill: fillColor, isLightTile } = getTreemapColor(gain, returnType, palette);
  // Labels by tile luminance; dark mode's translucent tiles always need the light one.
  const label = palette.isDark || !isLightTile ? palette.labelLight : palette.labelDark;
  const textColor = `rgb(${label.join(",")})`;

  // Determine what text to display based on mode
  const displayText = displayMode === "name" && name ? name : symbol;
  // Truncate text to fit within the available width (with some padding)
  const truncatedText = truncateText(displayText || "", width - 16, fontSize + 1);

  return (
    <g style={{ cursor: "pointer" }}>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={10}
        ry={10}
        className={cn("stroke-card", {
          "stroke-[4px]": depth === 1,
          "fill-none stroke-0": depth === 0,
        })}
        style={{
          fill: depth === 1 ? fillColor : undefined,
          // Soften tiles in dark mode so they blend into the background instead
          // of reading as bright rectangles on near-black.
          fillOpacity: depth === 1 && palette.isDark ? 0.45 : undefined,
          cursor: "pointer",
        }}
      />
      {depth === 1 ? (
        <>
          <Link to={`/holdings/${encodeURIComponent(id || symbol || "")}`}>
            <text
              x={x + width / 2}
              y={y + height / 2}
              textAnchor="middle"
              fill={textColor}
              className="font-default cursor-pointer text-sm hover:underline"
              style={{
                fontSize: fontSize + 1,
              }}
            >
              {truncatedText}
            </text>
          </Link>

          <text
            x={x + width / 2}
            y={y + height / 2 + fontSize}
            textAnchor="middle"
            fill={textColor}
            style={{
              fontSize: fontSize2,
            }}
          >
            {gain > 0 ? "+" + formatting.formatPercent(gain) : formatting.formatPercent(gain)}
          </text>
        </>
      ) : null}
    </g>
  );
};

interface PortfolioCompositionProps {
  holdings: Holding[];
  isLoading?: boolean;
}

interface TooltipProps {
  active?: boolean;
  payload?: {
    value: number;
    payload: {
      symbol: string;
      name?: string;
      gain: number;
      asOfDate?: string;
    };
  }[];
  settings?: {
    baseCurrency?: string;
    theme?: string;
  };
}

const CompositionTooltip = ({ active, payload, settings }: TooltipProps) => {
  const numberFormatting = useNumberFormatting();
  const dateFormatting = useDateFormatting();
  const { isBalanceHidden } = useBalancePrivacy();

  const { t } = useTranslation();
  if (active && payload?.length) {
    const data = payload[0].payload;
    const value = payload[0].value;
    const gain = data.gain || 0;
    const isPositive = gain >= 0;

    return (
      <Card>
        <CardContent className="space-y-3 p-4">
          {/* Header with symbol and name */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-primary text-sm font-bold">{data.symbol}</span>
              <span className="text-muted-foreground text-xs">
                {data.asOfDate ? dateFormatting.formatCalendarDate(data.asOfDate) : ""}
              </span>
            </div>
            <p className="text-muted-foreground text-xs leading-tight">{data.name}</p>
          </div>

          {/* Divider */}
          <div className="border-t" />

          {/* Market Value */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground pe-6 text-sm">
                {t("holdings:market_value_label")}
              </span>
              <AmountDisplay
                value={value}
                currency={settings?.baseCurrency ?? "USD"}
                isHidden={isBalanceHidden}
                className="text-sm font-semibold"
              />
            </div>

            {/* Gain/Loss */}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm">{t("holdings:return")}</span>
              <span
                className={cn(
                  "flex items-center gap-1 text-sm font-semibold",
                  isPositive ? "text-gain" : "text-loss",
                )}
              >
                {isPositive ? "+" : ""}
                {numberFormatting.formatPercent(gain)}
                <span className="text-xs">{isPositive ? "↗" : "↘"}</span>
              </span>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }
  return null;
};

export function PortfolioComposition({ holdings, isLoading }: PortfolioCompositionProps) {
  const [returnType, setReturnType] = usePersistentState<ReturnType>(
    "composition-performance-mode",
    "daily",
  );
  const [displayMode, setDisplayMode] = usePersistentState<DisplayMode>(
    "composition-display-mode",
    "symbol",
  );
  const { settings } = useSettingsContext();
  const { t } = useTranslation();
  const palette = useSyncExternalStore(
    subscribeToTreemapTheme,
    getTreemapPaletteSnapshot,
    () => fallbackPalette,
  );

  const toggleDisplayMode = () => {
    setDisplayMode(displayMode === "symbol" ? "name" : "symbol");
  };

  const data = useMemo(() => {
    // Map holdings directly, assuming backend provides aggregated data
    const processedData = holdings
      .map((holding) => {
        const symbol = holding.instrument?.symbol;
        if (!symbol) return null; // Skip if no symbol

        const gain = getBaseHoldingPerformancePercentForMode(holding, returnType) ?? 0;

        const marketValue = Number(holding.marketValue?.base) || 0;

        // Basic validation
        if (isNaN(gain) || isNaN(marketValue) || marketValue <= 0) return null;

        return {
          id: holding.instrument?.id, // Asset ID for navigation
          symbol: symbol,
          name: holding.instrument?.name, // Use symbol for the treemap node name/link
          marketValueConverted: marketValue,
          gain,
          asOfDate: holding.asOfDate,
        };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null); // Explicit non-null filter

    // Sort by market value after processing all holdings
    processedData.sort((a, b) => b.marketValueConverted - a.marketValueConverted);

    return processedData;
  }, [holdings, returnType]);

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="flex items-center space-x-2">
            <Icons.LayoutDashboard className="text-muted-foreground h-4 w-4" />
            <CardTitle className="text-muted-foreground text-sm font-medium tracking-wider uppercase">
              {t("holdings:composition")}
            </CardTitle>
          </div>
          <div className="flex items-center space-x-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-8 w-32 rounded-full" />
          </div>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-125 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (holdings.length === 0) {
    return (
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div className="flex items-center space-x-2">
            <Icons.LayoutDashboard className="text-muted-foreground h-4 w-4" />
            <CardTitle className="text-md font-medium">{t("holdings:composition")}</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="flex h-125 items-center justify-center">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">{<Icons.BarChart className="size-10" />}</EmptyMedia>
              <EmptyTitle>{t("holdings:no_holdings_data")}</EmptyTitle>
              <EmptyDescription>{t("holdings:no_holdings_data_desc")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex shrink-0 flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <div className="flex items-center space-x-2">
          <CardTitle className="text-muted-foreground text-sm font-medium tracking-wider uppercase">
            {t("holdings:composition")}
          </CardTitle>
        </div>
        <div className="flex items-center space-x-3">
          <DisplayModeToggle displayMode={displayMode} onToggle={toggleDisplayMode} />
          <AnimatedToggleGroup
            items={[
              { value: "daily", label: t("holdings:daily") },
              { value: "pnl", label: t("holdings:pnl") },
              { value: "return", label: t("holdings:return") },
            ]}
            value={returnType}
            onValueChange={(value: ReturnType) => setReturnType(value)}
            size="sm"
          />
        </div>
      </CardHeader>
      <CardContent className="ps-2">
        <RenderableChartContainer className="h-125 w-full">
          <Treemap
            width={400}
            height={200}
            data={data}
            dataKey="marketValueConverted"
            isAnimationActive={false}
            content={(props: TreemapNode) => (
              <CustomizedContent
                {...props}
                displayMode={displayMode}
                returnType={returnType}
                palette={palette}
              />
            )}
          >
            <ChartTooltip content={<CompositionTooltip settings={settings ?? undefined} />} />
          </Treemap>
        </RenderableChartContainer>
      </CardContent>
    </Card>
  );
}
