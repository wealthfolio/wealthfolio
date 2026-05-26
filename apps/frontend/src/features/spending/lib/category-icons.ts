/**
 * Maps Lucide-named taxonomy icons to Phosphor duotone components.
 *
 * The DB stores Lucide-style icon names (e.g. `Home`, `ShoppingCart`) on
 * `taxonomy_categories.icon`. This indirection lets the UI render the
 * Phosphor duotone variant — softer, more colorful — while keeping the
 * stored data as Lucide names (no migration needed).
 */
import type { ComponentType } from "react";

import { AirplaneIcon } from "@phosphor-icons/react/dist/csr/Airplane";
import { ArrowCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowCounterClockwise";
import { BarbellIcon } from "@phosphor-icons/react/dist/csr/Barbell";
import { BriefcaseIcon } from "@phosphor-icons/react/dist/csr/Briefcase";
import { BuildingsIcon } from "@phosphor-icons/react/dist/csr/Buildings";
import { CalendarIcon } from "@phosphor-icons/react/dist/csr/Calendar";
import { CarIcon } from "@phosphor-icons/react/dist/csr/Car";
import { CarProfileIcon } from "@phosphor-icons/react/dist/csr/CarProfile";
import { CodeIcon } from "@phosphor-icons/react/dist/csr/Code";
import { CoffeeIcon } from "@phosphor-icons/react/dist/csr/Coffee";
import { CouchIcon } from "@phosphor-icons/react/dist/csr/Couch";
import { CreditCardIcon } from "@phosphor-icons/react/dist/csr/CreditCard";
import { CurrencyDollarIcon } from "@phosphor-icons/react/dist/csr/CurrencyDollar";
import { DeviceMobileIcon } from "@phosphor-icons/react/dist/csr/DeviceMobile";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { FilmStripIcon } from "@phosphor-icons/react/dist/csr/FilmStrip";
import { ForkKnifeIcon } from "@phosphor-icons/react/dist/csr/ForkKnife";
import { GameControllerIcon } from "@phosphor-icons/react/dist/csr/GameController";
import { GasPumpIcon } from "@phosphor-icons/react/dist/csr/GasPump";
import { GiftIcon } from "@phosphor-icons/react/dist/csr/Gift";
import { GlobeIcon } from "@phosphor-icons/react/dist/csr/Globe";
import { GraduationCapIcon } from "@phosphor-icons/react/dist/csr/GraduationCap";
import { HeartIcon } from "@phosphor-icons/react/dist/csr/Heart";
import { HouseIcon } from "@phosphor-icons/react/dist/csr/House";
import { LaptopIcon } from "@phosphor-icons/react/dist/csr/Laptop";
import { LightbulbIcon } from "@phosphor-icons/react/dist/csr/Lightbulb";
import { MoneyIcon } from "@phosphor-icons/react/dist/csr/Money";
import { PaletteIcon } from "@phosphor-icons/react/dist/csr/Palette";
import { PercentIcon } from "@phosphor-icons/react/dist/csr/Percent";
import { PiggyBankIcon } from "@phosphor-icons/react/dist/csr/PiggyBank";
import { PillIcon } from "@phosphor-icons/react/dist/csr/Pill";
import { ReceiptIcon } from "@phosphor-icons/react/dist/csr/Receipt";
import { ShieldIcon } from "@phosphor-icons/react/dist/csr/Shield";
import { ShoppingBagIcon } from "@phosphor-icons/react/dist/csr/ShoppingBag";
import { ShoppingCartIcon } from "@phosphor-icons/react/dist/csr/ShoppingCart";
import { SmileyIcon } from "@phosphor-icons/react/dist/csr/Smiley";
import { StethoscopeIcon } from "@phosphor-icons/react/dist/csr/Stethoscope";
import { TShirtIcon } from "@phosphor-icons/react/dist/csr/TShirt";
import { TagIcon } from "@phosphor-icons/react/dist/csr/Tag";
import { TargetIcon } from "@phosphor-icons/react/dist/csr/Target";
import { TelevisionIcon } from "@phosphor-icons/react/dist/csr/Television";
import { TrainIcon } from "@phosphor-icons/react/dist/csr/Train";
import { TrendUpIcon } from "@phosphor-icons/react/dist/csr/TrendUp";
import { TrophyIcon } from "@phosphor-icons/react/dist/csr/Trophy";
import { TruckIcon } from "@phosphor-icons/react/dist/csr/Truck";
import { UserIcon } from "@phosphor-icons/react/dist/csr/User";
import { WarningCircleIcon } from "@phosphor-icons/react/dist/csr/WarningCircle";
import { WifiHighIcon } from "@phosphor-icons/react/dist/csr/WifiHigh";
import { WineIcon } from "@phosphor-icons/react/dist/csr/Wine";
import { WrenchIcon } from "@phosphor-icons/react/dist/csr/Wrench";

// IconProps from Phosphor (referenced indirectly via ComponentType to avoid
// a separate type-only import path that some bundlers stumble on).
type PhosphorIconProps = {
  size?: number | string;
  color?: string;
  weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone";
  className?: string;
  style?: React.CSSProperties;
  mirrored?: boolean;
};

export type PhosphorIcon = ComponentType<PhosphorIconProps>;

const ICON_MAP: Record<string, PhosphorIcon> = {
  AlertCircle: WarningCircleIcon,
  Award: TrophyIcon,
  Banknote: MoneyIcon,
  Briefcase: BriefcaseIcon,
  Building: BuildingsIcon,
  Calendar: CalendarIcon,
  Car: CarProfileIcon,
  Code: CodeIcon,
  Coffee: CoffeeIcon,
  CreditCard: CreditCardIcon,
  DollarSign: CurrencyDollarIcon,
  Dumbbell: BarbellIcon,
  Eye: EyeIcon,
  FileText: FileTextIcon,
  Film: FilmStripIcon,
  Fuel: GasPumpIcon,
  Gamepad2: GameControllerIcon,
  Gift: GiftIcon,
  Globe: GlobeIcon,
  GraduationCap: GraduationCapIcon,
  Heart: HeartIcon,
  Home: HouseIcon,
  Laptop: LaptopIcon,
  Lightbulb: LightbulbIcon,
  MoreHorizontal: DotsThreeIcon,
  Palette: PaletteIcon,
  ParkingCircle: CarIcon,
  Percent: PercentIcon,
  PiggyBank: PiggyBankIcon,
  Pill: PillIcon,
  Plane: AirplaneIcon,
  Receipt: ReceiptIcon,
  RotateCcw: ArrowCounterClockwiseIcon,
  Shield: ShieldIcon,
  Shirt: TShirtIcon,
  ShoppingBag: ShoppingBagIcon,
  ShoppingCart: ShoppingCartIcon,
  Smartphone: DeviceMobileIcon,
  Smile: SmileyIcon,
  Sofa: CouchIcon,
  Stethoscope: StethoscopeIcon,
  Tag: TagIcon,
  Target: TargetIcon,
  Train: TrainIcon,
  TrendingUp: TrendUpIcon,
  Truck: TruckIcon,
  Tv: TelevisionIcon,
  User: UserIcon,
  UtensilsCrossed: ForkKnifeIcon,
  Wifi: WifiHighIcon,
  Wine: WineIcon,
  Wrench: WrenchIcon,
};

/** Resolve a stored Lucide-style icon name to a Phosphor component (Tag fallback). */
export function resolveCategoryIcon(name: string | null | undefined): PhosphorIcon {
  if (name && ICON_MAP[name]) return ICON_MAP[name];
  return TagIcon;
}

/** All known category icon name keys (the same names the seeds use). */
export const CATEGORY_ICON_NAMES = Object.keys(ICON_MAP).sort();
