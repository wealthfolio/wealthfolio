import { useEffect, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage, cn, getCashAvatarLabel } from "@wealthfolio/ui";

interface SandboxTickerAvatarProps {
  symbol: string;
  exchangeMic?: string | null;
  instrumentType?: string | null;
  className?: string;
}

declare global {
  // Private sandbox bridge installed by addon-sandbox-entry.tsx.
  // eslint-disable-next-line no-var
  var __wealthfolioRequestTickerLogo:
    | ((
        symbol: string,
        exchangeMic?: string | null,
        instrumentType?: string | null,
      ) => Promise<Blob | null>)
    | undefined;
}

export const SandboxTickerAvatar = ({
  symbol,
  exchangeMic,
  instrumentType,
  className = "size-8",
}: SandboxTickerAvatarProps) => {
  const baseSymbol = symbol ? symbol.split(/[.:-]/)[0].toUpperCase() : "";
  const fullSymbol = symbol ? symbol.toUpperCase() : "";
  const fallbackAvatarLabel = baseSymbol ? baseSymbol.slice(0, 4) : "•";
  const cashAvatarLabel = getCashAvatarLabel(fullSymbol);
  const [logoUrl, setLogoUrl] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setLogoUrl(undefined);

    void (async () => {
      const requestLogo = globalThis.__wealthfolioRequestTickerLogo;
      if (cashAvatarLabel || !requestLogo || !fullSymbol) {
        return;
      }

      const logo = await requestLogo(fullSymbol, exchangeMic, instrumentType);
      if (!logo || cancelled) {
        return;
      }

      objectUrl = URL.createObjectURL(logo);
      setLogoUrl(objectUrl);
    })();

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [cashAvatarLabel, exchangeMic, fullSymbol, instrumentType]);

  if (cashAvatarLabel) {
    return (
      <Avatar key="cash" className={cn("font-semibold", className)}>
        <AvatarFallback className="bg-primary/80 dark:bg-primary/20 text-xs font-semibold text-white">
          <span className="p-1" title={fullSymbol}>
            {cashAvatarLabel}
          </span>
        </AvatarFallback>
      </Avatar>
    );
  }

  return (
    <Avatar className={className}>
      {logoUrl ? <AvatarImage src={logoUrl} alt={fullSymbol} className="object-cover p-0" /> : null}
      <AvatarFallback className="bg-primary/80 dark:bg-primary/20 font-medium text-white">
        <span
          className={cn(
            "px-0.5 leading-none",
            fallbackAvatarLabel.length >= 4 ? "text-2xs" : "text-xs",
          )}
          title={fullSymbol}
        >
          {fallbackAvatarLabel}
        </span>
      </AvatarFallback>
    </Avatar>
  );
};
