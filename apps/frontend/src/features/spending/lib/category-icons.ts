/**
 * Maps Lucide-named taxonomy icons to app icon components.
 *
 * The DB stores Lucide-style icon names (e.g. `Home`, `ShoppingCart`) on
 * `taxonomy_categories.icon`. This indirection keeps the stored data stable
 * while the UI can choose the concrete icon implementation centrally.
 */
import { Icons, type Icon as PhosphorIcon } from "@wealthfolio/ui";
import { TagIcon } from "lucide-react";
import { iconNames, type IconName } from "lucide-react/dynamic";

const ICON_MAP: Record<string, PhosphorIcon> = {
  AlertCircle: Icons.AlertCircle,
  Award: Icons.Award,
  Banknote: Icons.Banknote,
  Briefcase: Icons.Briefcase,
  Building: Icons.Building,
  Calendar: Icons.Calendar,
  Car: Icons.VehicleDuotone,
  Code: Icons.Code,
  Coffee: Icons.Coffee,
  CreditCard: Icons.CreditCard,
  DollarSign: Icons.DollarSign,
  Dumbbell: Icons.Dumbbell,
  Eye: Icons.Eye,
  FileText: Icons.FileText,
  Film: Icons.Film,
  Fuel: Icons.Fuel,
  Gamepad2: Icons.Gamepad2,
  Gift: Icons.Gift,
  Globe: Icons.Globe,
  GraduationCap: Icons.GraduationCap,
  Heart: Icons.Heart,
  Home: Icons.House,
  Laptop: Icons.Laptop,
  Lightbulb: Icons.Lightbulb,
  MoreHorizontal: Icons.MoreHorizontal,
  Palette: Icons.Palette,
  ParkingCircle: Icons.ParkingCircle,
  Percent: Icons.Percent,
  PiggyBank: Icons.PiggyBank,
  Pill: Icons.Pill,
  Plane: Icons.Plane,
  Receipt: Icons.Receipt,
  RotateCcw: Icons.RotateCcw,
  Shield: Icons.Shield,
  Shirt: Icons.Shirt,
  ShoppingBag: Icons.ShoppingBag,
  ShoppingCart: Icons.ShoppingCart,
  Smartphone: Icons.Smartphone,
  Smile: Icons.Smile,
  Sofa: Icons.Sofa,
  Stethoscope: Icons.Stethoscope,
  Tag: Icons.Tag,
  Target: Icons.Target,
  Train: Icons.Train,
  TrendingUp: Icons.TrendingUp,
  Truck: Icons.Truck,
  Tv: Icons.Tv,
  User: Icons.User,
  UtensilsCrossed: Icons.UtensilsCrossed,
  Wifi: Icons.Wifi,
  Wine: Icons.Wine,
  Wrench: Icons.Wrench,
};

const lucideIconNames = new Set<string>(iconNames);
export const LUCIDE_CATEGORY_ICON_NAMES = [...iconNames].sort();

export function getLucideCategoryIconName(name: string | null | undefined): IconName | null {
  if (!name?.startsWith("lucide:")) return null;
  const iconName = name.slice("lucide:".length);
  return lucideIconNames.has(iconName) ? (iconName as IconName) : null;
}

/** Resolve a legacy icon name to an app icon component. */
export function resolveCategoryIcon(name: string | null | undefined): PhosphorIcon {
  if (name && Object.hasOwn(ICON_MAP, name)) return ICON_MAP[name];
  return TagIcon;
}

export function getInheritedCategoryIcon(name: string | null | undefined): string | null {
  if (!name) return null;
  if (getLucideCategoryIconName(name)) return name;
  if (!Object.hasOwn(ICON_MAP, name)) return null;
  const lucideName =
    name === "Home"
      ? "house"
      : name
          .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
          .replace(/([a-z])([0-9])/g, "$1-$2")
          .toLowerCase();
  return lucideIconNames.has(lucideName) ? `lucide:${lucideName}` : null;
}
