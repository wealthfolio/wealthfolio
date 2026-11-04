import type { Icon } from "@wealthfolio/ui/components/ui/icons";

import { getAccountTypeIcon } from "@/lib/account-type-icons";
import { cn } from "@/lib/utils";

/**
 * An icon on a muted tile, sized like a category's icon tile. Phone picker screens
 * enlarge it through its `icon-tile` slot.
 */
export function IconTile({ icon: TileIcon, className }: { icon: Icon; className?: string }) {
  return (
    <span
      data-slot="icon-tile"
      className={cn(
        "bg-muted text-muted-foreground flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
        className,
      )}
      aria-hidden="true"
    >
      <TileIcon className="h-3.5 w-3.5" />
    </span>
  );
}

/** An account's type icon on a muted tile. */
export function AccountTypeIconTile({
  accountType,
  className,
}: {
  accountType: string | null | undefined;
  className?: string;
}) {
  return <IconTile icon={getAccountTypeIcon(accountType)} className={className} />;
}
