import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Icons,
} from "@wealthfolio/ui";

export interface OverviewChip {
  id: string;
  name: string;
  color?: string | null;
  value?: number;
}

interface OverviewCardProps {
  title: string;
  description?: string;
  chips: OverviewChip[];
  manageHref: string;
  manageLabel?: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyCtaLabel: string;
  isLoading?: boolean;
  isError?: boolean;
  errorTitle?: string;
  errorDescription?: string;
  maxVisible?: number;
  /** Renders a stacked distribution bar above the chips. */
  showDistribution?: boolean;
  /** Visual shape of chips. */
  chipShape?: "pill" | "tag";
}

export function OverviewCard({
  title,
  description,
  chips,
  manageHref,
  manageLabel,
  emptyTitle,
  emptyDescription,
  emptyCtaLabel,
  isLoading = false,
  isError = false,
  errorTitle,
  errorDescription,
  maxVisible = 7,
  showDistribution = false,
  chipShape = "pill",
}: OverviewCardProps) {
  const { t } = useTranslation();
  const resolvedManageLabel = manageLabel ?? t("settings:spending.overview.manage");
  const resolvedErrorTitle = errorTitle ?? t("settings:spending.overview.error_title");
  const resolvedErrorDescription =
    errorDescription ?? t("settings:spending.overview.error_description");
  const visible = chips.slice(0, maxVisible);
  const overflow = Math.max(0, chips.length - visible.length);
  const isEmpty = !isLoading && chips.length === 0;

  // Distribution flex weights — fall back to equal share if no `value` provided.
  const totalValue = chips.reduce((sum, c) => sum + (c.value && c.value > 0 ? c.value : 0), 0) || 0;

  return (
    <Card className="rounded-lg">
      <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 p-6 pb-4">
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-base font-semibold tracking-tight">{title}</CardTitle>
          {description && <CardDescription className="text-xs">{description}</CardDescription>}
        </div>
        {!isEmpty && (
          <Link
            to={manageHref}
            className="text-foreground hover:text-foreground/80 group inline-flex shrink-0 items-center gap-1 text-xs font-medium"
          >
            {resolvedManageLabel}
            <Icons.ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
          </Link>
        )}
      </CardHeader>
      <CardContent className="p-6 pt-0">
        {isLoading ? (
          <div className="bg-muted/40 h-12 w-full animate-pulse rounded-md" />
        ) : isError ? (
          <div className="flex items-start gap-3 py-2">
            <Icons.AlertTriangle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <div className="text-foreground text-sm font-medium">{resolvedErrorTitle}</div>
              <p className="text-muted-foreground text-xs">{resolvedErrorDescription}</p>
            </div>
          </div>
        ) : isEmpty ? (
          <div className="space-y-3 py-2">
            <div>
              <div className="text-foreground text-sm font-medium">{emptyTitle}</div>
              <p className="text-muted-foreground text-xs">{emptyDescription}</p>
            </div>
            <Button asChild size="sm">
              <Link to={manageHref}>
                <Icons.Plus className="mr-1.5 h-3.5 w-3.5" />
                {emptyCtaLabel}
              </Link>
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            {showDistribution && chips.length > 0 && (
              <div className="flex h-1.5 w-full gap-0.5 overflow-hidden rounded-sm">
                {chips.map((c) => {
                  const weight =
                    totalValue > 0 && c.value && c.value > 0
                      ? (c.value / totalValue) * 100
                      : 100 / chips.length;
                  return (
                    <span
                      key={c.id}
                      className="block h-full"
                      style={{
                        width: `${weight}%`,
                        background: c.color ?? "var(--muted-foreground)",
                      }}
                    />
                  );
                })}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              {visible.map((chip) =>
                chipShape === "tag" ? (
                  <span
                    key={chip.id}
                    className="bg-muted/60 border-border/60 text-foreground inline-flex items-center gap-1.5 rounded-sm border px-2 py-0.5 text-xs"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: chip.color ?? "var(--muted-foreground)" }}
                    />
                    <span className="truncate">{chip.name}</span>
                  </span>
                ) : (
                  <span
                    key={chip.id}
                    className="bg-muted/60 text-foreground inline-flex max-w-[200px] items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs"
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: chip.color ?? "var(--muted-foreground)" }}
                    />
                    <span className="truncate">{chip.name}</span>
                  </span>
                ),
              )}
              {overflow > 0 && (
                <span className="text-muted-foreground text-xs">
                  {t("settings:spending.overview.more", { count: overflow })}
                </span>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
