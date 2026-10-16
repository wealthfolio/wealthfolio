import { Badge } from "@wealthfolio/ui";
import { useTranslation } from "react-i18next";

import { TickerAvatar } from "@/components/ticker-avatar";
import { cn } from "@/lib/utils";

interface AssetLogoPreviewProps {
  assetId: string;
  symbol: string;
  exchangeMic?: string | null;
  instrumentType?: string | null;
  name?: string | null;
  /** Candidate image to preview; when omitted the current logo is shown. */
  src?: string;
}

/** Muted placeholder in place of a figure, so the preview never invents numbers. */
const Bar = ({ className }: { className?: string }) => (
  <div aria-hidden className={cn("bg-muted h-2.5 rounded-full", className)} />
);

/**
 * Renders the logo inside the three surfaces where users see it most, at the
 * exact avatar sizes those surfaces use, so a transparent or low-contrast
 * image is caught before it is saved.
 */
export function AssetLogoPreview({
  assetId,
  symbol,
  exchangeMic,
  instrumentType,
  name,
  src,
}: AssetLogoPreviewProps) {
  const { t } = useTranslation("asset");
  const isNew = !!src;
  const avatar = { symbol, exchangeMic, instrumentType, assetId, src };
  const subtitle = name ?? symbol;

  return (
    <section
      className="space-y-2"
      data-testid="asset-logo-preview"
      data-preview-source={isNew ? "new" : "current"}
    >
      <div className="flex items-center justify-between">
        <p className="text-muted-foreground text-xs">{t("logo.preview_title")}</p>
        <Badge variant={isNew ? "default" : "secondary"} className="text-2xs h-5 px-1.5">
          {isNew ? t("logo.preview_new") : t("logo.preview_current")}
        </Badge>
      </div>

      <div className="bg-background divide-y rounded-lg border">
        {/* Holding card (mobile) — h-10 avatar */}
        <div className="space-y-1.5 p-3">
          <p className="text-muted-foreground text-2xs uppercase tracking-wide">
            {t("logo.preview_card")}
          </p>
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <TickerAvatar {...avatar} className="h-10 w-10 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{symbol}</p>
                <p className="text-muted-foreground truncate text-xs">{subtitle}</p>
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1.5">
              <Bar className="w-16" />
              <Bar className="w-10" />
            </div>
          </div>
        </div>

        {/* Holdings table row — h-8 avatar */}
        <div className="space-y-1.5 p-3">
          <p className="text-muted-foreground text-2xs uppercase tracking-wide">
            {t("logo.preview_table")}
          </p>
          <div className="flex items-center gap-4">
            <div className="flex min-w-0 flex-1 items-center">
              <TickerAvatar {...avatar} className="mr-2 h-8 w-8 shrink-0" />
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium">{symbol}</span>
                <span className="text-muted-foreground truncate text-xs">{subtitle}</span>
              </div>
            </div>
            <Bar className="w-12" />
            <Bar className="hidden w-14 sm:block" />
            <Bar className="w-10" />
          </div>
        </div>

        {/* Activity / compact list row — h-8 avatar, denser text */}
        <div className="space-y-1.5 p-3">
          <p className="text-muted-foreground text-2xs uppercase tracking-wide">
            {t("logo.preview_list")}
          </p>
          <div className="flex items-center gap-3">
            <TickerAvatar {...avatar} className="h-8 w-8 shrink-0" />
            <span className="truncate text-sm font-medium">{symbol}</span>
            <Bar className="ml-auto w-14" />
          </div>
        </div>
      </div>
    </section>
  );
}
