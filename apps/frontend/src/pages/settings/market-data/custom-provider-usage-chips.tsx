import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import type { Asset } from "@/lib/types";

import { assetUsageLabel } from "./custom-provider-usage";

const VISIBLE_CHIPS = 8;

function assetHref(asset: Asset): string {
  // Exchange rates are managed in general settings, not on a holding page.
  return asset.kind === "FX" ? "/settings/general" : `/holdings/${encodeURIComponent(asset.id)}`;
}

/**
 * Symbol chips for the securities using a custom provider. Chips link to the security
 * only where leaving the page can't discard unsaved edits.
 */
export function CustomProviderUsageChips({
  label,
  assets,
  linkable = false,
}: {
  label?: string;
  assets: Asset[];
  linkable?: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  if (assets.length === 0) return null;

  const visible = expanded ? assets : assets.slice(0, VISIBLE_CHIPS);
  const hidden = assets.length - visible.length;

  return (
    <div className="space-y-1.5">
      {label && <div className="text-muted-foreground text-xs">{label}</div>}
      <div className="flex flex-wrap gap-1.5">
        {visible.map((asset) => {
          const text = assetUsageLabel(asset);
          return (
            <Badge
              key={asset.id}
              variant="secondary"
              className="h-5 px-1.5 font-mono text-[11px] font-normal"
              title={asset.name ?? text}
              asChild={linkable}
            >
              {linkable ? <Link to={assetHref(asset)}>{text}</Link> : text}
            </Badge>
          );
        })}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="text-muted-foreground hover:text-foreground text-[11px] underline-offset-2 hover:underline"
          >
            {t("settings:market_data_page.usage_more", { count: hidden })}
          </button>
        )}
      </div>
    </div>
  );
}
