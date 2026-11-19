import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { CATEGORY_CSS_COLORS } from "./styles";

interface CategoryAvatarProps {
  category: string;
  isLiability?: boolean;
  className?: string;
  iconClassName?: string;
}

export function CategoryAvatar({
  category,
  isLiability = false,
  className = "h-7 w-7",
  iconClassName = "h-4 w-4",
}: CategoryAvatarProps) {
  const color = isLiability
    ? "var(--destructive)"
    : (CATEGORY_CSS_COLORS[category] ?? "var(--muted-foreground)");
  const Icon = isLiability
    ? Icons.LiabilityDuotone
    : ({
        properties: Icons.RealEstateDuotone,
        vehicles: Icons.VehicleDuotone,
        collectibles: Icons.CollectibleDuotone,
        preciousMetals: Icons.PreciousDuotone,
        cash: Icons.Wallet,
      }[category] ?? Icons.OtherAssetDuotone);

  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-md ${className}`}
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
    >
      <Icon className={iconClassName} />
    </div>
  );
}
