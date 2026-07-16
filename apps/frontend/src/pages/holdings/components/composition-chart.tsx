import { RenderableChartContainer } from "@/components/renderable-chart-container";
import { usePersistentState } from "@/hooks/use-persistent-state";
import { getBaseHoldingPerformancePercentForMode } from "@/lib/holding-performance";
import { useSettingsContext } from "@/lib/settings-provider";
import { Holding } from "@/lib/types";
import { cn, parseLocalDate } from "@/lib/utils";
import { AnimatedToggleGroup, formatAmount, formatPercent } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui/components/ui/card";
import { EmptyPlaceholder } from "@wealthfolio/ui/components/ui/empty-placeholder";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { useMemo, useSyncExternalStore, type FC } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Tooltip as ChartTooltip, type TreemapNode, Treemap } from "recharts";

type ReturnType = "daily" | "pnl" | "return";
type DisplayMode = "symbol" | "name";

function noop() {
  return undefined;
}

function getDarkModeSnapshot(): boolean {
  if (typeof document === "undefined") return false;
  return document.documentElement.classList.contains("dark");
}

function subscribeToDarkModeChange(onStoreChange: () => void): () => void {
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
    return noop;
  }

  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

const DisplayModeToggle: React.FC<{
  displayMode: DisplayMode;
  onToggle: () => void;
}> = ({ displayMode, onToggle }) => {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="secondary" size="icon-sm" className="rounded-full" onClick={onToggle}>
          {displayMode === "symbol" ? (
            <Icons.Hash className="h-4 w-4" />
          ) : (
            <Icons.Type className="h-4 w-4" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        <p>
          {displayMode === "symbol" ? t("holdings:show_full_names") : t("holdings:show_symbols")}
        </p>
      </TooltipContent>
    </Tooltip>
  );
};

// Treemap heatmap palette — symbols colored by return.
// Matches the "Allocation Concept E - Unified" design: gains lerp from a light
// sage to a deep green, losses from a light clay to a deep red.
const POS_LO = [205, 217, 191]; // #cdd9bf
const POS_HI = [53, 92, 76]; // #355c4c
// Loss ramp tuned to the theme's --destructive (flexoki red). NEG_HI matches the
// dark-mode token hsl(5 61% 54%) = #d14e42; NEG_LO is a saturated tint of the same
// hue so small losses read red-tinted instead of washed-out pink.
const NEG_LO = [233, 179, 168]; // #e9b3a8
const NEG_HI = [209, 78, 66]; // #d14e42

const lerp = (a: number, b: number, t: number) => Math.round(a + (b - a) * t);

// Label colors picked from tile luminance (not the theme) so text stays legible
// on every shade. Dark mode uses translucent tiles, so it always needs light text.
const TILE_TEXT_DARK = "#1c2a24";
const TILE_TEXT_LIGHT = "#f5f3ec";

interface TreemapTile {
  fill: string;
  isLightTile: boolean; // bright fill → use dark text
}

// Shade by return using a saturating curve `t = m / (m + k)` that maps
// [0, ∞) → [0, 1). Unlike a hard cap, extreme winners/losers keep darkening
// instead of collapsing into a single shade. `k` is the return magnitude that
// maps to the mid-tone (losses ramp ~2× faster, matching the design). Values
// are fractions: 0.5 = +50%, 0.025 = +2.5% for the smaller daily returns.
function getTreemapColor(gain: number, returnType: ReturnType): TreemapTile {
  const isGain = isNaN(gain) || gain >= 0;
  const [lo, hi] = isGain ? [POS_LO, POS_HI] : [NEG_LO, NEG_HI];
  const k = isGain
    ? returnType === "daily"
      ? 0.025
      : 0.5
    : returnType === "daily"
      ? 0.0125
      : 0.25;

  const m = isNaN(gain) ? 0 : Math.abs(gain);
  const t = m / (m + k);
  const c = lo.map((v, i) => lerp(v, hi[i], t));
  // Perceived luminance (ITU-R BT.601); >150 reads as a light tile.
  const luminance = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
  return { fill: `rgb(${c.join(",")})`, isLightTile: luminance > 150 };
}

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
  isDark?: boolean;
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
  isDark = false,
}) => {
  const fontSize = Math.min(width, height) < 80 ? Math.min(width, height) * 0.16 : 13;
  const fontSize2 = Math.min(width, height) < 80 ? Math.min(width, height) * 0.14 : 12;
  const { fill: fillColor, isLightTile } = getTreemapColor(gain, returnType);
  const textColor = isDark || !isLightTile ? TILE_TEXT_LIGHT : TILE_TEXT_DARK;

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
          fillOpacity: depth === 1 && isDark ? 0.45 : undefined,
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
            className="text- font-thin"
            style={{
              fontSize: fontSize2,
            }}
          >
            {gain > 0 ? "+" + formatPercent(gain) : formatPercent(gain)}
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
                {data.asOfDate ? parseLocalDate(data.asOfDate).toLocaleDateString() : ""}
              </span>
            </div>
            <p className="text-muted-foreground text-xs leading-tight">{data.name}</p>
          </div>

          {/* Divider */}
          <div className="border-t" />

          {/* Market Value */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground pr-6 text-sm">
                {t("holdings:market_value_label")}
              </span>
              <span className="text-sm font-semibold">
                {formatAmount(value, settings?.baseCurrency ?? "USD")}
              </span>
            </div>

            {/* Gain/Loss */}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-sm">{t("holdings:return")}</span>
              <span
                className={cn(
                  "flex items-center gap-1 text-sm font-semibold",
                  isPositive ? "text-success" : "text-destructive",
                )}
              >
                {isPositive ? "+" : ""}
                {formatPercent(gain)}
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
  const isDark = useSyncExternalStore(subscribeToDarkModeChange, getDarkModeSnapshot, () => false);

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
            <CardTitle className="text-muted-foreground text-sm font-medium uppercase tracking-wider">
              {t("holdings:composition")}
            </CardTitle>
          </div>
          <div className="flex items-center space-x-3">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-8 w-32 rounded-full" />
          </div>
        </CardHeader>
        <CardContent>
          <Skeleton className="h-[500px] w-full" />
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
        <CardContent className="flex h-[500px] items-center justify-center">
          <EmptyPlaceholder
            icon={<Icons.BarChart className="h-10 w-10" />}
            title={t("holdings:no_holdings_data")}
            description={t("holdings:no_holdings_data_desc")}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <div className="flex items-center space-x-2">
          <CardTitle className="text-muted-foreground text-sm font-medium uppercase tracking-wider">
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
      <CardContent className="pl-2">
        <RenderableChartContainer className="h-[500px] w-full">
          <Treemap
            width={400}
            height={200}
            data={data}
            dataKey="marketValueConverted"
            animationDuration={100}
            content={(props: TreemapNode) => (
              <CustomizedContent
                {...props}
                displayMode={displayMode}
                returnType={returnType}
                isDark={isDark}
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
