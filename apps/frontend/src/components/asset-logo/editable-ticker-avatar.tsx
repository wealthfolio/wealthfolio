import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useTranslation } from "react-i18next";

import { TickerAvatar } from "@/components/ticker-avatar";
import { cn } from "@/lib/utils";

interface EditableTickerAvatarProps {
  symbol: string;
  assetId: string;
  exchangeMic?: string | null;
  instrumentType?: string | null;
  className?: string;
  onEdit: () => void;
}

/**
 * `TickerAvatar` with a hover/focus overlay that opens the logo dialog. On touch
 * devices the logo shows no overlay or badge; a tap on it opens the dialog. The
 * parent owns the dialog.
 */
export function EditableTickerAvatar({
  symbol,
  assetId,
  exchangeMic,
  instrumentType,
  className = "size-9",
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
      />
      <button
        type="button"
        aria-label={t("logo.change")}
        data-testid="asset-logo-edit"
        onClick={onEdit}
        className="focus-visible:ring-ring absolute inset-0 flex items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none pointer-coarse:bg-transparent"
      >
        <Icons.ImageUp className="size-3.5 pointer-coarse:hidden" />
      </button>
    </div>
  );
}
