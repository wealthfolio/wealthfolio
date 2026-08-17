import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { parseOccSymbol } from "@/lib/occ-symbol";
import { useAssetLogoUrl } from "@/hooks/use-asset-logo-url";
import type { Asset } from "@/lib/types";
import { Avatar, AvatarFallback, AvatarImage } from "@wealthfolio/ui";

interface TickerAvatarProps {
  symbol: string;
  className?: string;
  imageClassName?: string;
  /** Resolved user-uploaded logo override URL (data URL or server path), if any. */
  customLogoUrl?: string | null;
}

const CASH_AVATAR_LABELS: Record<string, string> = {
  USD: "$",
  CAD: "C$",
  AUD: "A$",
  NZD: "NZ$",
};

const CASH_SYMBOL_PATTERN = /^\$?CASH[-_:]([A-Z]{3})$/;

const getCashAvatarLabel = (symbol: string): string | null => {
  const normalized = symbol.trim().toUpperCase();
  if (normalized === "$CASH" || normalized === "CASH") return "$";

  const currency = CASH_SYMBOL_PATTERN.exec(normalized)?.[1];
  if (!currency) return null;

  return CASH_AVATAR_LABELS[currency] ?? currency;
};

const getFallbackAvatarLabel = (symbol: string): string => symbol.slice(0, 4);

/**
 * A user-uploaded logo is already tightly cropped, so it should render
 * edge-to-edge (`object-contain` only). The bundled ticker-logos fallback has
 * more surrounding whitespace baked into the source images and needs padding
 * to avoid looking oversized in the circle. Call sites that pass their own
 * `imageClassName` must derive it from this so the two cases don't diverge.
 */
export const getTickerLogoImageClassName = (
  hasCustomLogo: boolean,
  fallbackPadding: string,
): string => (hasCustomLogo ? "object-contain" : `object-contain ${fallbackPadding}`);

export const TickerAvatar = ({
  symbol,
  className = "size-8",
  imageClassName,
  customLogoUrl,
}: TickerAvatarProps) => {
  // For OCC option symbols (e.g. "AAPL250321C00150000"), use the underlying ticker for logo
  const parsed = symbol ? parseOccSymbol(symbol) : null;
  const logoSymbol = parsed ? parsed.underlying : symbol;

  // Extract the base symbol (before any dot, hyphen, or colon) for fallback
  const baseSymbol = logoSymbol ? logoSymbol.split(/[.:-]/)[0].toUpperCase() : "";
  const fullSymbol = logoSymbol ? logoSymbol.toUpperCase() : "";

  // A user-uploaded override always wins; only fall back to the bundled
  // ticker-logos resolution (full symbol, then base symbol) when unset.
  const primaryLogoUrl = customLogoUrl || (fullSymbol ? `/ticker-logos/${fullSymbol}.png` : "");
  const fallbackLogoUrl = customLogoUrl
    ? ""
    : baseSymbol
      ? `/ticker-logos/${baseSymbol}.png`
      : "";
  const cashAvatarLabel = getCashAvatarLabel(fullSymbol);
  const fallbackAvatarLabel = baseSymbol ? getFallbackAvatarLabel(baseSymbol) : "•";
  const [logoUrl, setLogoUrl] = useState(primaryLogoUrl);

  // object-contain never distorts the source image: a landscape logo scales
  // to the circle's full width (letterboxed top/bottom), a portrait logo
  // scales to the circle's full height (letterboxed left/right) — either
  // way the aspect ratio is preserved, unlike `object-cover` (which crops)
  // or leaving `object-fit` unset (which stretches to fill).
  const resolvedImageClassName =
    imageClassName ?? getTickerLogoImageClassName(!!customLogoUrl, "p-2");

  useEffect(() => {
    setLogoUrl(primaryLogoUrl);
  }, [primaryLogoUrl]);

  if (cashAvatarLabel) {
    return (
      <Avatar className={cn("border-white/20 font-semibold backdrop-blur-md", className)}>
        <AvatarFallback className="bg-primary/80 dark:bg-primary/20 text-xs font-semibold text-white">
          <span className="p-1" title={fullSymbol}>
            {cashAvatarLabel}
          </span>
        </AvatarFallback>
      </Avatar>
    );
  }

  return (
    <Avatar
      className={cn("bg-primary/80 dark:bg-primary/20 border-white/20 backdrop-blur-md", className)}
    >
      <AvatarImage
        src={logoUrl}
        alt={fullSymbol}
        className={resolvedImageClassName}
        onLoadingStatusChange={(status) => {
          if (
            status === "error" &&
            logoUrl === primaryLogoUrl &&
            fallbackLogoUrl !== primaryLogoUrl
          ) {
            setLogoUrl(fallbackLogoUrl);
          }
        }}
      />
      <AvatarFallback className="bg-primary/80 dark:bg-primary/20 font-medium text-white">
        <span
          className={cn(
            "px-0.5 leading-none",
            fallbackAvatarLabel.length >= 4 ? "text-[10px]" : "text-xs",
          )}
          title={fullSymbol}
        >
          {fallbackAvatarLabel}
        </span>
      </AvatarFallback>
    </Avatar>
  );
};

interface AssetTickerAvatarProps extends Omit<TickerAvatarProps, "customLogoUrl"> {
  /** The full asset row/profile this avatar represents (needed to resolve a logo override). */
  asset: Pick<Asset, "id" | "customLogoFilename"> | undefined;
}

/**
 * Convenience wrapper for call sites that already have a full `Asset` object
 * (as opposed to the slimmer `Instrument` DTO some holdings/activity views
 * use) — resolves the logo override automatically instead of requiring each
 * caller to call `useAssetLogoUrl` itself.
 */
export const AssetTickerAvatar = ({ asset, ...props }: AssetTickerAvatarProps) => {
  const { data: customLogoUrl } = useAssetLogoUrl(asset);
  return <TickerAvatar {...props} customLogoUrl={customLogoUrl} />;
};

interface AssetLogoWatermarkProps {
  /** The full asset/instrument this row represents (needed to resolve a logo override). */
  asset: Pick<Asset, "id" | "customLogoFilename"> | undefined;
  className?: string;
}

/**
 * Large, unboxed, low-opacity background rendering of a custom logo,
 * intended for full-width list rows (e.g. a holdings row). Renders nothing
 * when the asset has no custom logo override. The containing row must be
 * `relative` (and ideally `isolate overflow-hidden`) for this to lay out
 * correctly behind the row's foreground content.
 */
export const AssetLogoWatermark = ({ asset, className }: AssetLogoWatermarkProps) => {
  const { data: customLogoUrl } = useAssetLogoUrl(asset);
  if (!customLogoUrl) return null;

  // A background-image div anchored directly to its own container's edges
  // (top-0 bottom-0), rather than an <img> sized via `h-full`/`inset-y-0` —
  // percentage heights on a positioned element only resolve if every
  // ancestor in the chain has a *definite* height, which table cells and
  // flex rows sized by their own content don't reliably provide. Anchoring
  // to edges works regardless of how the container's height was computed.
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute left-0 top-0 bottom-0 -z-10 w-48 opacity-10",
        "[mask-image:linear-gradient(to_right,black,transparent_85%)]",
        className,
      )}
      style={{
        backgroundImage: `url(${customLogoUrl})`,
        // Bounded to a fixed-width box (not the full row): `cover` scales to
        // fill both dimensions of *that* box, giving a bigger, more zoomed-in
        // result than fitting to height alone, and leaves room past the
        // image's own edge for the mask fade to actually be visible against.
        backgroundSize: "cover",
        backgroundPosition: "left center",
        backgroundRepeat: "no-repeat",
      }}
    />
  );
};
