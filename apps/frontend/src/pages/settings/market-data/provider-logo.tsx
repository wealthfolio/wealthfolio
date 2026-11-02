import { SettingsListMedia } from "@/components/settings-list";
import { cn } from "@/lib/utils";
import { Icons } from "@wealthfolio/ui/components/ui/icons";

// Dark marks that would disappear on a dark tile; there they turn into a light silhouette.
const DARK_MARKS = new Set(["treasury.png", "boerse.png", "openfigi.png", "alpha-vantage.png"]);

/** A provider's logo at icon size on the muted tile, like the AI provider icons. */
export function ProviderLogo({ logoFilename }: { logoFilename: string | null }) {
  return (
    <SettingsListMedia className="[&_img]:size-5">
      {logoFilename ? (
        <img
          src={`/market-data/${logoFilename}`}
          alt=""
          className={cn(DARK_MARKS.has(logoFilename) && "dark:brightness-0 dark:invert")}
        />
      ) : (
        <Icons.Globe />
      )}
    </SettingsListMedia>
  );
}
