import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";

import { TickerAvatar } from "@/components/ticker-avatar";
import { cn } from "@/lib/utils";

interface EditableTickerAvatarProps {
  symbol: string;
  assetId: string;
  exchangeMic?: string | null;
  instrumentType?: string | null;
  className?: string;
  fallback?: ReactNode;
  fallbackClassName?: string;
  onEdit: () => void;
}

/**
 * `TickerAvatar` with a hover/focus overlay (and an always-visible badge on
 * touch devices) that opens the logo dialog. The parent owns the dialog.
 */
export function EditableTickerAvatar({
  symbol,
  assetId,
  exchangeMic,
  instrumentType,
  className = "size-9",
  fallback,
  fallbackClassName,
  onEdit,
}: EditableTickerAvatarProps) {
  const { t } = useTranslation("asset");

  return (
    <div className={cn("group relative shrink-0", className)}>
      <TickerAvatar
        symbol={symbol}
        exchangeMic={exchangeMic}
        instrumentType={instrumentType}
        assetId={assetId}
        className="size-full"
        fallback={fallback}
        fallbackClassName={fallbackClassName}
      />
      <button
        type="button"
        aria-label={t("logo.change")}
        data-testid="asset-logo-edit"
        onClick={onEdit}
        className="focus-visible:ring-ring absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 group-hover:opacity-100"
      >
        <Icons.ImageUp className="size-3.5" />
      </button>
      <span
        aria-hidden="true"
        className="bg-background text-muted-foreground pointer-coarse:block pointer-events-none absolute -bottom-0.5 -right-0.5 hidden rounded-full border p-0.5"
      >
        <Icons.ImageUp className="size-2.5" />
      </span>
    </div>
  );
}
