// Lucide icons - centralized imports for the application
// Using barrel import with optimizeDeps.include in vite.config.ts for dev performance
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowDownLeft,
  ArrowLeft,
  ArrowLeftRight,
  ArrowRight,
  ArrowRightLeft,
  ArrowUp,
  ArrowUpRight,
  BadgeDollarSign,
  BarChart,
  Baseline,
  Bitcoin,
  Blocks,
  Brain,
  Briefcase,
  Building2,
  Calendar,
  CalendarDays,
  Car,
  CaseSensitive,
  Check,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronsUpDown,
  ChevronUp,
  Circle,
  CircleGauge,
  Clock,
  Cloud,
  CloudCog,
  Coins,
  Copy,
  CreditCard,
  DatabaseBackup,
  DatabaseZap,
  DollarSign,
  Dot,
  Download,
  Ellipsis,
  Eraser,
  ExternalLink,
  File,
  FileArchive,
  FileAudio,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  FileX,
  Folder,
  FolderOpen,
  Fullscreen,
  Gem,
  Globe,
  Goal,
  Grid3x3,
  Group,
  HandCoins,
  Hash,
  HelpCircle,
  History,
  Home,
  Info,
  LayoutDashboard,
  Link,
  List,
  Lock,
  LockOpen,
  ListChecks,
  ListCollapse,
  ListFilter,
  Loader,
  Loader2,
  Mail,
  Minus,
  MinusCircle,
  Monitor,
  Moon,
  MoreVertical,
  OctagonX,
  Package,
  Palette,
  PanelLeft,
  PanelLeftOpen,
  PauseCircle,
  Pencil,
  Percent,
  PieChart,
  Pin,
  PinOff,
  PlayCircle,
  Plus,
  PlusCircle,
  Presentation,
  QrCode,
  Receipt,
  ReceiptText,
  RectangleEllipsis,
  RefreshCcw,
  RefreshCw,
  Rows3,
  Save,
  Scissors,
  Search,
  Settings2,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Split,
  Square,
  Star,
  Store,
  Sun,
  Target,
  Trash,
  Trash2,
  TrendingDown,
  TrendingUp,
  Type,
  Undo2,
  Unlink,
  Upload,
  User,
  Users,
  Wallet,
  Wand2,
  X,
  XCircle,
  // Spending taxonomy icons (referenced by category seed data)
  Award,
  Banknote,
  Code,
  Coffee,
  Dumbbell,
  Film,
  Fuel,
  Gamepad2,
  Gift,
  GraduationCap,
  Heart,
  Laptop,
  Lightbulb,
  MoreHorizontal,
  ParkingCircle,
  PiggyBank,
  Pill,
  Plane,
  RotateCcw,
  Shirt,
  ShoppingBag,
  ShoppingCart,
  Smile,
  Sofa,
  Stethoscope,
  Train,
  Truck,
  Tv,
  UtensilsCrossed,
  Wifi,
  Wine,
  Wrench,
} from "lucide-react";
import type { ComponentType, CSSProperties } from "react";

// Phosphor icons - deep imports for optimal tree shaking with Vite
import { CalendarDotsIcon } from "@phosphor-icons/react/dist/csr/CalendarDots";
import { CarProfileIcon } from "@phosphor-icons/react/dist/csr/CarProfile";
import { ClockCounterClockwiseIcon } from "@phosphor-icons/react/dist/csr/ClockCounterClockwise";
import { CoinsIcon } from "@phosphor-icons/react/dist/csr/Coins";
import { CreditCardIcon } from "@phosphor-icons/react/dist/csr/CreditCard";
import { CubeIcon } from "@phosphor-icons/react/dist/csr/Cube";
import { DevicesIcon } from "@phosphor-icons/react/dist/csr/Devices";
import { DotsThreeOutlineIcon } from "@phosphor-icons/react/dist/csr/DotsThreeOutline";
import { DotsThreeOutlineVerticalIcon } from "@phosphor-icons/react/dist/csr/DotsThreeOutlineVertical";
import { EyeIcon } from "@phosphor-icons/react/dist/csr/Eye";
import { EyeSlashIcon } from "@phosphor-icons/react/dist/csr/EyeSlash";
import { GarageIcon } from "@phosphor-icons/react/dist/csr/Garage";
import { HouseIcon } from "@phosphor-icons/react/dist/csr/House";
import { PuzzlePieceIcon } from "@phosphor-icons/react/dist/csr/PuzzlePiece";
import { ReceiptIcon } from "@phosphor-icons/react/dist/csr/Receipt";
import { SketchLogoIcon } from "@phosphor-icons/react/dist/csr/SketchLogo";
import { SparkleIcon } from "@phosphor-icons/react/dist/csr/Sparkle";
import { TagIcon } from "@phosphor-icons/react/dist/csr/Tag";
import { UploadSimpleIcon } from "@phosphor-icons/react/dist/csr/UploadSimple";
import { UserSwitchIcon } from "@phosphor-icons/react/dist/csr/UserSwitch";

// Unified icon props that work with both Lucide and Phosphor
export interface IconProps {
  size?: number | string;
  color?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number | string;
  className?: string;
  style?: CSSProperties;
  weight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone";
}

export type Icon = ComponentType<IconProps>;

const IconsInternal = {
  AlertCircle: AlertCircle,
  AlertTriangle: AlertTriangle,
  DatabaseBackup: DatabaseBackup,
  DatabaseZap: DatabaseZap,
  Blocks: Blocks,
  BadgeDollarSign: BadgeDollarSign,
  Grid3x3: Grid3x3,
  Rows3: Rows3,
  Calendar: CalendarDays,
  Check: Check,
  CheckCircle: CheckCircle2,
  Clock: Clock,
  Cloud: Cloud,
  CloudSync: CloudCog,
  ListChecks: ListChecks,
  LayoutDashboard: LayoutDashboard,
  HandCoins: HandCoins,
  Home: Home,
  Copy: Copy,
  HelpCircle: HelpCircle,
  History: History,
  ArrowRight: ArrowRight,
  ArrowLeft: ArrowLeft,
  ArrowDown: ArrowDown,
  ArrowDownLeft: ArrowDownLeft,
  ArrowUp: ArrowUp,
  ArrowUpRight: ArrowUpRight,
  CreditCard: CreditCard,
  Bitcoin: Bitcoin,
  Brain: Brain,
  Briefcase: Briefcase,
  Search: Search,
  Save: Save,
  Group: Group,
  Globe: Globe,
  Close: X,
  Eye: ({ size, className, style, color }: IconProps) => (
    <EyeIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),
  Info: Info,
  EyeOff: ({ size, className, style, color }: IconProps) => (
    <EyeSlashIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),
  Refresh: RefreshCcw,
  RefreshCw: RefreshCw,
  PanelLeftOpen: PanelLeftOpen,
  Download: Download,
  Ellipsis: Ellipsis,
  Dot: Dot,
  Activity2: Activity,
  DollarSign: DollarSign,
  Users: Users,
  User: User,
  ChevronUp: ChevronUp,
  ChevronDown: ChevronDown,
  ChevronsUpDown: ChevronsUpDown,
  ChevronLeft: ChevronLeft,
  ChevronRight: ChevronRight,
  ChevronsLeft: ChevronsLeft,
  ChevronsRight: ChevronsRight,
  Circle: Circle,
  Plus: Plus,
  Pencil: Pencil,
  PlusCircle: PlusCircle,
  PanelLeft: PanelLeft,
  Minus: Minus,
  MinusCircle: MinusCircle,
  PauseCircle: PauseCircle,
  PlayCircle: PlayCircle,
  Monitor: Monitor,
  QrCode: QrCode,
  Smartphone: Smartphone,
  PieChart: PieChart,
  BarChart: BarChart,
  Spinner: Loader2,
  Loader: Loader,
  MoreVertical: MoreVertical,
  Goal: Goal,
  Trash: Trash,
  Trash2: Trash2,
  Hash: Hash,
  Type: Type,
  Wallet: Wallet,
  Import: Upload,
  FileText: FileText,
  FileX: FileX,
  XCircle: XCircle,
  ListCollapse: ListCollapse,
  ArrowRightLeft: ArrowRightLeft,
  ArrowLeftRight: ArrowLeftRight,
  Receipt: Receipt,
  ReceiptText: ReceiptText,
  Percent: Percent,
  Store: Store,
  Package: Package,
  Star: Star,
  Shield: Shield,
  ShieldAlert: ShieldAlert,
  ShieldCheck: ShieldCheck,
  ExternalLink: ExternalLink,
  TrendingUp: TrendingUp,
  TrendingDown: TrendingDown,
  Wand2: Wand2,
  Link: Link,
  Unlink: Unlink,
  Building: Building2,
  Car: Car,
  Gem: Gem,
  Coins: Coins,
  Eraser: Eraser,
  Palette: Palette,
  Moon: Moon,
  Sun: Sun,
  ListFilter: ListFilter,
  Undo: Undo2,
  Fullscreen: Fullscreen,
  RectangleEllipsis: RectangleEllipsis,
  Mail: Mail,
  OctagonX: OctagonX,
  Settings2: Settings2,
  // Additional icons for UI components
  Baseline: Baseline,
  CalendarIcon: Calendar,
  CaseSensitive: CaseSensitive,
  CheckSquare: CheckSquare,
  File: File,
  FileArchive: FileArchive,
  FileAudio: FileAudio,
  FileImage: FileImage,
  FileSpreadsheet: FileSpreadsheet,
  FileVideo: FileVideo,
  Folder: Folder,
  FolderOpen: FolderOpen,
  List: List,
  Lock: Lock,
  LockOpen: LockOpen,
  Pin: Pin,
  PinOff: PinOff,
  Presentation: Presentation,
  Scissors: Scissors,
  Split: Split,
  SplitHorizontal: ({ style, ...props }: IconProps) => (
    <Split
      {...props}
      style={{
        ...style,
        transform: style?.transform ? `${style.transform} rotate(90deg)` : "rotate(90deg)",
      }}
    />
  ),
  Square: Square,
  Target: Target,
  SparklesOutline: Sparkles,
  CircleGauge: CircleGauge,
  X: X,
  Upload: Upload,
  Dashboard: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 32}
      height={size ?? 32}
      fill="currentColor"
      viewBox="0 0 256 256"
      {...props}
    >
      <path
        d="M232,152v24a8,8,0,0,1-8,8H32a8,8,0,0,1-8-8V153.13C24,95.65,70.15,48.2,127.63,48A104,104,0,0,1,232,152Z"
        opacity="0.2"
      ></path>
      <path d="M207.06,72.67A111.24,111.24,0,0,0,128,40h-.4C66.07,40.21,16,91,16,153.13V176a16,16,0,0,0,16,16H224a16,16,0,0,0,16-16V152A111.25,111.25,0,0,0,207.06,72.67ZM224,176H119.71l54.76-75.3a8,8,0,0,0-12.94-9.42L99.92,176H32V153.13c0-3.08.15-6.12.43-9.13H56a8,8,0,0,0,0-16H35.27c10.32-38.86,44-68.24,84.73-71.66V80a8,8,0,0,0,16,0V56.33A96.14,96.14,0,0,1,221,128H200a8,8,0,0,0,0,16h23.67c.21,2.65.33,5.31.33,8Z"></path>
    </svg>
  ),

  Goals: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 32}
      height={size ?? 32}
      fill="currentColor"
      viewBox="0 0 256 256"
      {...props}
    >
      <path d="M176,128a48,48,0,1,1-48-48A48,48,0,0,1,176,128Z" opacity="0.2"></path>
      <path d="M221.87,83.16A104.1,104.1,0,1,1,195.67,49l22.67-22.68a8,8,0,0,1,11.32,11.32l-96,96a8,8,0,0,1-11.32-11.32l27.72-27.72a40,40,0,1,0,17.87,31.09,8,8,0,1,1,16-.9,56,56,0,1,1-22.38-41.65L184.3,60.39a87.88,87.88,0,1,0,23.13,29.67,8,8,0,0,1,14.44-6.9Z"></path>
    </svg>
  ),

  Database: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 32}
      height={size ?? 32}
      fill="currentColor"
      viewBox="0 0 256 256"
      {...props}
    >
      <path d="M216,80c0,26.51-39.4,48-88,48S40,106.51,40,80s39.4-48,88-48S216,53.49,216,80Z" opacity="0.2"></path>
      <path d="M128,24C74.17,24,32,48.6,32,80v96c0,31.4,42.17,56,96,56s96-24.6,96-56V80C224,48.6,181.83,24,128,24Zm80,104c0,9.62-7.88,19.43-21.61,26.92C170.93,163.35,150.19,168,128,168s-42.93-4.65-58.39-13.08C55.88,147.43,48,137.62,48,128V111.36c17.06,15,46.23,24.64,80,24.64s62.94-9.68,80-24.64ZM69.61,53.08C85.07,44.65,105.81,40,128,40s42.93,4.65,58.39,13.08C200.12,60.57,208,70.38,208,80s-7.88,19.43-21.61,26.92C170.93,115.35,150.19,120,128,120s-42.93-4.65-58.39-13.08C55.88,99.43,48,89.62,48,80S55.88,60.57,69.61,53.08ZM186.39,202.92C170.93,211.35,150.19,216,128,216s-42.93-4.65-58.39-13.08C55.88,195.43,48,185.62,48,176V159.36c17.06,15,46.23,24.64,80,24.64s62.94-9.68,80-24.64V176C208,185.62,200.12,195.43,186.39,202.92Z"></path>
    </svg>
  ),

  FileCsv: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 24}
      height={size ?? 24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M8 13h2" />
      <path d="M14 13h2" />
      <path d="M8 17h2" />
      <path d="M14 17h2" />
      <path opacity="0.2" d="M19 7H15V3L19 7Z" fill="black" />
    </svg>
  ),

  FileJson: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 24}
      height={size ?? 24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" />
      <path d="M14 2v4a2 2 0 0 0 2 2h4" />
      <path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1" />
      <path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1" />
      <path opacity="0.2" d="M19 7H15V3L19 7Z" fill="black" />
    </svg>
  ),

  Files: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 32}
      height={size ?? 32}
      fill="currentColor"
      viewBox="0 0 256 256"
      {...props}
    >
      <path d="M208,72V184a8,8,0,0,1-8,8H176V104L136,64H80V40a8,8,0,0,1,8-8h80Z" opacity="0.2"></path>
      <path d="M213.66,66.34l-40-40A8,8,0,0,0,168,24H88A16,16,0,0,0,72,40V56H56A16,16,0,0,0,40,72V216a16,16,0,0,0,16,16H168a16,16,0,0,0,16-16V200h16a16,16,0,0,0,16-16V72A8,8,0,0,0,213.66,66.34ZM168,216H56V72h76.69L168,107.31v84.53c0,.06,0,.11,0,.16s0,.1,0,.16V216Zm32-32H184V104a8,8,0,0,0-2.34-5.66l-40-40A8,8,0,0,0,136,56H88V40h76.69L200,75.31Zm-56-32a8,8,0,0,1-8,8H88a8,8,0,0,1,0-16h48A8,8,0,0,1,144,152Zm0,32a8,8,0,0,1-8,8H88a8,8,0,0,1,0-16h48A8,8,0,0,1,144,184Z"></path>
    </svg>
  ),

  Holdings: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 32}
      height={size ?? 32}
      fill="currentColor"
      viewBox="0 0 256 256"
      {...props}
    >
      <path
        d="M224,88V200a8,8,0,0,1-8,8H56a16,16,0,0,1-16-16V64A16,16,0,0,0,56,80H216A8,8,0,0,1,224,88Z"
        opacity="0.2"
      ></path>
      <path d="M216,72H56a8,8,0,0,1,0-16H192a8,8,0,0,0,0-16H56A24,24,0,0,0,32,64V192a24,24,0,0,0,24,24H216a16,16,0,0,0,16-16V88A16,16,0,0,0,216,72Zm0,128H56a8,8,0,0,1-8-8V86.63A23.84,23.84,0,0,0,56,88H216Zm-48-60a12,12,0,1,1,12,12A12,12,0,0,1,168,140Z"></path>
    </svg>
  ),

  Activity: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 32}
      height={size ?? 32}
      fill="currentColor"
      viewBox="0 0 256 256"
      {...props}
    >
      <path d="M224,104v88a8,8,0,0,1-8,8H168V104Z" opacity="0.2"></path>
      <path d="M28,128a8,8,0,0,1,0-16H56a8,8,0,0,0,0-16H40a24,24,0,0,1,0-48,8,8,0,0,1,16,0h8a8,8,0,0,1,0,16H40a8,8,0,0,0,0,16H56a24,24,0,0,1,0,48,8,8,0,0,1-16,0ZM232,56V192a16,16,0,0,1-16,16H40a16,16,0,0,1-16-16V152a8,8,0,0,1,16,0v40H160V160H80a8,8,0,0,1,0-16h80V112H104a8,8,0,0,1,0-16H216V64H96a8,8,0,0,1,0-16H224A8,8,0,0,1,232,56Zm-56,88h40V112H176Zm40,48V160H176v32Z"></path>
    </svg>
  ),

  Settings: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 32}
      height={size ?? 32}
      fill="currentColor"
      viewBox="0 0 256 256"
      {...props}
    >
      <path
        d="M207.86,123.18l16.78-21a99.14,99.14,0,0,0-10.07-24.29l-26.7-3a81,81,0,0,0-6.81-6.81l-3-26.71a99.43,99.43,0,0,0-24.3-10l-21,16.77a81.59,81.59,0,0,0-9.64,0l-21-16.78A99.14,99.14,0,0,0,77.91,41.43l-3,26.7a81,81,0,0,0-6.81,6.81l-26.71,3a99.43,99.43,0,0,0-10,24.3l16.77,21a81.59,81.59,0,0,0,0,9.64l-16.78,21a99.14,99.14,0,0,0,10.07,24.29l26.7,3a81,81,0,0,0,6.81,6.81l3,26.71a99.43,99.43,0,0,0,24.3,10l21-16.77a81.59,81.59,0,0,0,9.64,0l21,16.78a99.14,99.14,0,0,0,24.29-10.07l3-26.7a81,81,0,0,0,6.81-6.81l26.71-3a99.43,99.43,0,0,0,10-24.3l-16.77-21A81.59,81.59,0,0,0,207.86,123.18ZM128,168a40,40,0,1,1,40-40A40,40,0,0,1,128,168Z"
        opacity="0.2"
      ></path>
      <path d="M128,80a48,48,0,1,0,48,48A48.05,48.05,0,0,0,128,80Zm0,80a32,32,0,1,1,32-32A32,32,0,0,1,128,160Zm88-29.84q.06-2.16,0-4.32l14.92-18.64a8,8,0,0,0,1.48-7.06,107.6,107.6,0,0,0-10.88-26.25,8,8,0,0,0-6-3.93l-23.72-2.64q-1.48-1.56-3-3L186,40.54a8,8,0,0,0-3.94-6,107.29,107.29,0,0,0-26.25-10.86,8,8,0,0,0-7.06,1.48L130.16,40Q128,40,125.84,40L107.2,25.11a8,8,0,0,0-7.06-1.48A107.6,107.6,0,0,0,73.89,34.51a8,8,0,0,0-3.93,6L67.32,64.27q-1.56,1.49-3,3L40.54,70a8,8,0,0,0-6,3.94,107.71,107.71,0,0,0-10.87,26.25,8,8,0,0,0,1.49,7.06L40,125.84Q40,128,40,130.16L25.11,148.8a8,8,0,0,0-1.48,7.06,107.6,107.6,0,0,0,10.88,26.25,8,8,0,0,0,6,3.93l23.72,2.64q1.49,1.56,3,3L70,215.46a8,8,0,0,0,3.94,6,107.71,107.71,0,0,0,26.25,10.87,8,8,0,0,0,7.06-1.49L125.84,216q2.16.06,4.32,0l18.64,14.92a8,8,0,0,0,7.06,1.48,107.21,107.21,0,0,0,26.25-10.88,8,8,0,0,0,3.93-6l2.64-23.72q1.56-1.48,3-3L215.46,186a8,8,0,0,0,6-3.94,107.71,107.71,0,0,0,10.87-26.25,8,8,0,0,0-1.49-7.06Zm-16.1-6.5a73.93,73.93,0,0,1,0,8.68,8,8,0,0,0,1.74,5.48l14.19,17.73a91.57,91.57,0,0,1-6.23,15L187,173.11a8,8,0,0,0-5.1,2.64,74.11,74.11,0,0,1-6.14,6.14,8,8,0,0,0-2.64,5.1l-2.51,22.58a91.32,91.32,0,0,1-15,6.23l-17.74-14.19a8,8,0,0,0-5-1.75h-.48a73.93,73.93,0,0,1-8.68,0,8.06,8.06,0,0,0-5.48,1.74L100.45,215.8a91.57,91.57,0,0,1-15-6.23L82.89,187a8,8,0,0,0-2.64-5.1,74.11,74.11,0,0,1-6.14-6.14,8,8,0,0,0-5.1-2.64L46.43,170.6a91.32,91.32,0,0,1-6.23-15l14.19-17.74a8,8,0,0,0,1.74-5.48,73.93,73.93,0,0,1,0-8.68,8,8,0,0,0-1.74-5.48L40.2,100.45a91.57,91.57,0,0,1,6.23-15L69,82.89a8,8,0,0,0,5.1-2.64,74.11,74.11,0,0,1,6.14-6.14A8,8,0,0,0,82.89,69L85.4,46.43a91.32,91.32,0,0,1,15-6.23l17.74,14.19a8,8,0,0,0,5.48,1.74,73.93,73.93,0,0,1,8.68,0,8.06,8.06,0,0,0,5.48-1.74L155.55,40.2a91.57,91.57,0,0,1,15,6.23L173.11,69a8,8,0,0,0,2.64,5.1,74.11,74.11,0,0,1,6.14,6.14,8,8,0,0,0,5.1,2.64l22.58,2.51a91.32,91.32,0,0,1,6.23,15l-14.19,17.74A8,8,0,0,0,199.87,123.66Z"></path>
    </svg>
  ),

  Invoice: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 32}
      height={size ?? 32}
      fill="currentColor"
      viewBox="0 0 256 256"
      {...props}
    >
      <path d="M224,104v88a8,8,0,0,1-8,8H168V104Z" opacity="0.2"></path>
      <path d="M28,128a8,8,0,0,1,0-16H56a8,8,0,0,0,0-16H40a24,24,0,0,1,0-48,8,8,0,0,1,16,0h8a8,8,0,0,1,0,16H40a8,8,0,0,0,0,16H56a24,24,0,0,1,0,48,8,8,0,0,1-16,0ZM232,56V192a16,16,0,0,1-16,16H40a16,16,0,0,1-16-16V152a8,8,0,0,1,16,0v40H160V160H80a8,8,0,0,1,0-16h80V112H104a8,8,0,0,1,0-16H216V64H96a8,8,0,0,1,0-16H224A8,8,0,0,1,232,56Zm-56,88h40V112H176Zm40,48V160H176v32Z"></path>
    </svg>
  ),

  Income: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 32}
      height={size ?? 32}
      fill="currentColor"
      viewBox="0 0 256 256"
      {...props}
    >
      <path
        d="M240,132c0,19.88-35.82,36-80,36-19.6,0-37.56-3.17-51.47-8.44h0C146.76,156.85,176,142,176,124V96.72h0C212.52,100.06,240,114.58,240,132ZM176,84c0-19.88-35.82-36-80-36S16,64.12,16,84s35.82,36,80,36S176,103.88,176,84Z"
        opacity="0.2"
      ></path>
      <path d="M184,89.57V84c0-25.08-37.83-44-88-44S8,58.92,8,84v40c0,20.89,26.25,37.49,64,42.46V172c0,25.08,37.83,44,88,44s88-18.92,88-44V132C248,111.3,222.58,94.68,184,89.57ZM232,132c0,13.22-30.79,28-72,28-3.73,0-7.43-.13-11.08-.37C170.49,151.77,184,139,184,124V105.74C213.87,110.19,232,122.27,232,132ZM72,150.25V126.46A183.74,183.74,0,0,0,96,128a183.74,183.74,0,0,0,24-1.54v23.79A163,163,0,0,1,96,152,163,163,0,0,1,72,150.25Zm96-40.32V124c0,8.39-12.41,17.4-32,22.87V123.5C148.91,120.37,159.84,115.71,168,109.93ZM96,56c41.21,0,72,14.78,72,28s-30.79,28-72,28S24,97.22,24,84,54.79,56,96,56ZM24,124V109.93c8.16,5.78,19.09,10.44,32,13.57v23.37C36.41,141.4,24,132.39,24,124Zm64,48v-4.17c2.63.1,5.29.17,8,.17,3.88,0,7.67-.13,11.39-.35A121.92,121.92,0,0,0,120,171.41v23.46C100.41,189.4,88,180.39,88,172Zm48,26.25V174.4a179.48,179.48,0,0,0,24,1.6,183.74,183.74,0,0,0,24-1.54v23.79a165.45,165.45,0,0,1-48,0Zm64-3.38V171.5c12.91-3.13,23.84-7.79,32-13.57V172C232,180.39,219.59,189.4,200,194.87Z"></path>
    </svg>
  ),

  ChartBar: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 32}
      height={size ?? 32}
      fill="currentColor"
      viewBox="0 0 256 256"
      {...props}
    >
      <path d="M208,40V208H152V40Z" opacity="0.2"></path>
      <path d="M224,200h-8V40a8,8,0,0,0-8-8H152a8,8,0,0,0-8,8V80H96a8,8,0,0,0-8,8v40H48a8,8,0,0,0-8,8v64H32a8,8,0,0,0,0,16H224a8,8,0,0,0,0-16ZM160,48h40V200H160ZM104,96h40V200H104ZM56,144H88v56H56Z"></path>
    </svg>
  ),

  InfoCircle: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 80}
      height={size ?? 80}
      fill="currentColor"
      viewBox="0 0 80 80"
      {...props}
    >
      <path d="M39.8202 79.1504C61.5976 79.1504 79.2734 61.5234 79.2734 39.7461C79.2734 17.9688 61.5976 0.341797 39.8202 0.341797C18.0917 0.341797 0.415894 17.9688 0.415894 39.7461C0.415894 61.5234 18.0917 79.1504 39.8202 79.1504ZM39.8202 71.7285C22.1445 71.7285 7.88655 57.4219 7.88655 39.7461C7.88655 22.0703 22.1445 7.7637 39.8202 7.7637C57.496 7.7637 71.8027 22.0703 71.8027 39.7461C71.8027 57.4219 57.496 71.7285 39.8202 71.7285Z" />
      <path d="M33.2284 61.377H48.7558C50.5136 61.377 51.9296 60.1074 51.9296 58.3008C51.9296 56.5918 50.5136 55.2734 48.7558 55.2734H44.4589V37.0117C44.4589 34.6191 43.287 33.1055 41.0898 33.1055H33.9609C32.203 33.1055 30.8359 34.4238 30.8359 36.084C30.8359 37.8906 32.203 39.1602 33.9609 39.1602H37.5253V55.2734H33.2284C31.4706 55.2734 30.0546 56.5918 30.0546 58.3008C30.0546 60.1074 31.4706 61.377 33.2284 61.377ZM39.4296 27.0996C42.5058 27.0996 44.8984 24.6582 44.8984 21.582C44.8984 18.5059 42.5058 16.1133 39.4296 16.1133C36.4023 16.1133 33.9609 18.5059 33.9609 21.582C33.9609 24.6582 36.4023 27.0996 39.4296 27.0996Z" />
    </svg>
  ),
  CirclesFour: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 32}
      height={size ?? 32}
      fill="currentColor"
      viewBox="0 0 256 256"
      {...props}
    >
      <path
        d="M112,80A32,32,0,1,1,80,48,32,32,0,0,1,112,80Zm64,32a32,32,0,1,0-32-32A32,32,0,0,0,176,112ZM80,144a32,32,0,1,0,32,32A32,32,0,0,0,80,144Zm96,0a32,32,0,1,0,32,32A32,32,0,0,0,176,144Z"
        opacity="0.2"
      ></path>
      <path d="M80,40a40,40,0,1,0,40,40A40,40,0,0,0,80,40Zm0,64a24,24,0,1,1,24-24A24,24,0,0,1,80,104Zm96,16a40,40,0,1,0-40-40A40,40,0,0,0,176,120Zm0-64a24,24,0,1,1-24,24A24,24,0,0,1,176,56ZM80,136a40,40,0,1,0,40,40A40,40,0,0,0,80,136Zm0,64a24,24,0,1,1,24-24A24,24,0,0,1,80,200Zm96-64a40,40,0,1,0,40,40A40,40,0,0,0,176,136Zm0,64a24,24,0,1,1,24-24A24,24,0,0,1,176,200Z"></path>
    </svg>
  ),
  Addons: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      {...props}
      width={size ?? 32}
      height={size ?? 32}
      fill="currentColor"
      viewBox="0 0 256 256"
    >
      <path
        d="M216,104v96a8,8,0,0,1-8,8H48a8,8,0,0,1-8-8V104a8,8,0,0,1,8-8H208A8,8,0,0,1,216,104Z"
        opacity="0.2"
      ></path>
      <path d="M208,88H48a16,16,0,0,0-16,16v96a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V104A16,16,0,0,0,208,88Zm0,112H48V104H208v96ZM48,64a8,8,0,0,1,8-8H200a8,8,0,0,1,0,16H56A8,8,0,0,1,48,64ZM64,32a8,8,0,0,1,8-8H184a8,8,0,0,1,0,16H72A8,8,0,0,1,64,32Z"></path>
    </svg>
  ),

  LogOut: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      {...props}
      width={size ?? 32}
      height={size ?? 32}
      fill="currentColor"
      viewBox="0 0 256 256"
    >
      <path
        d="M208,88H48a8,8,0,0,0-8,8V208a8,8,0,0,0,8,8H208a8,8,0,0,0,8-8V96A8,8,0,0,0,208,88Zm-80,72a20,20,0,1,1,20-20A20,20,0,0,1,128,160Z"
        opacity="0.2"
      ></path>
      <path d="M208,80H176V56a48,48,0,0,0-96,0V80H48A16,16,0,0,0,32,96V208a16,16,0,0,0,16,16H208a16,16,0,0,0,16-16V96A16,16,0,0,0,208,80ZM96,56a32,32,0,0,1,64,0V80H96ZM208,208H48V96H208V208Zm-80-96a28,28,0,0,0-8,54.83V184a8,8,0,0,0,16,0V166.83A28,28,0,0,0,128,112Zm0,40a12,12,0,1,1,12-12A12,12,0,0,1,128,152Z"></path>
    </svg>
  ),

  Search2: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      {...props}
      width={size ?? 32}
      height={size ?? 32}
      fill="currentColor"
      viewBox="0 0 256 256"
    >
      <path d="M192,112a80,80,0,1,1-80-80A80,80,0,0,1,192,112Z" opacity="0.2"></path>
      <path d="M229.66,218.34,179.6,168.28a88.21,88.21,0,1,0-11.32,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z"></path>
    </svg>
  ),

  Insight: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      {...props}
      width={size ?? 32}
      height={size ?? 32}
      fill="currentColor"
      viewBox="0 0 256 256"
    >
      <path d="M224,64V208H32V48H208A16,16,0,0,1,224,64Z" opacity="0.2"></path>
      <path d="M232,208a8,8,0,0,1-8,8H32a8,8,0,0,1-8-8V48a8,8,0,0,1,16,0V156.69l50.34-50.35a8,8,0,0,1,11.32,0L128,132.69,180.69,80H160a8,8,0,0,1,0-16h40a8,8,0,0,1,8,8v40a8,8,0,0,1-16,0V91.31l-58.34,58.35a8,8,0,0,1-11.32,0L96,123.31l-56,56V200H224A8,8,0,0,1,232,208Z"></path>
    </svg>
  ),

  Google: ({ size, ...props }: IconProps) => (
    <svg xmlns="http://www.w3.org/2000/svg" width={size ?? 24} height={size ?? 24} viewBox="0 0 24 24" {...props}>
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  ),

  Apple: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size ?? 24}
      height={size ?? 24}
      viewBox="0 0 24 24"
      fill="currentColor"
      {...props}
    >
      <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  ),

  CloudSync2: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      {...props}
      width={size ?? 92}
      height={size ?? 92}
      fill="currentColor"
      viewBox="0 0 256 256"
    >
      <path d="M240,128a80,80,0,0,1-80,80H72A56,56,0,1,1,85.92,97.74l0,.1A80,80,0,0,1,240,128Z" opacity="0.2"></path>
      <path d="M248,128a87.34,87.34,0,0,1-17.6,52.81,8,8,0,1,1-12.8-9.62A71.34,71.34,0,0,0,232,128a72,72,0,0,0-144,0,8,8,0,0,1-16,0,88,88,0,0,1,3.29-23.88C74.2,104,73.1,104,72,104a48,48,0,0,0,0,96H96a8,8,0,0,1,0,16H72A64,64,0,1,1,81.29,88.68,88,88,0,0,1,248,128Zm-69.66,42.34L160,188.69V128a8,8,0,0,0-16,0v60.69l-18.34-18.35a8,8,0,0,0-11.32,11.32l32,32a8,8,0,0,0,11.32,0l32-32a8,8,0,0,0-11.32-11.32Z"></path>
    </svg>
  ),

  CloudOff: ({ size, ...props }: IconProps) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      {...props}
      width={size ?? 92}
      height={size ?? 92}
      fill="currentColor"
      viewBox="0 0 256 256"
    >
      <path d="M240,128a80,80,0,0,1-80,80H72A56,56,0,1,1,85.92,97.74l0,.1A80,80,0,0,1,240,128Z" opacity="0.2"></path>
      <path d="M53.92,34.62A8,8,0,1,0,42.08,45.38L81.32,88.55l-.06.12A65,65,0,0,0,72,88a64,64,0,0,0,0,128h88a87.34,87.34,0,0,0,31.8-5.93l10.28,11.31a8,8,0,1,0,11.84-10.76ZM160,200H72a48,48,0,0,1,0-96c1.1,0,2.2,0,3.3.12A88.4,88.4,0,0,0,72,128a8,8,0,0,0,16,0,72.25,72.25,0,0,1,5.06-26.54l87,95.7A71.66,71.66,0,0,1,160,200Zm88-72a87.89,87.89,0,0,1-22.35,58.61A8,8,0,0,1,213.71,176,72,72,0,0,0,117.37,70a8,8,0,0,1-9.48-12.89A88,88,0,0,1,248,128Z"></path>
    </svg>
  ),

  // Phosphor icons
  CalendarDots: ({ size, className, style, color }: IconProps) => (
    <CalendarDotsIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),
  PuzzlePiece: ({ size, className, style, color }: IconProps) => (
    <PuzzlePieceIcon size={size} weight="regular" className={className} style={style} color={color} />
  ),
  ReceiptDuotone: ({ size, className, style, color }: IconProps) => (
    <ReceiptIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),
  Devices: ({ size, className, style, color }: IconProps) => (
    <DevicesIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),
  UserSwitch: ({ size, className, style, color }: IconProps) => (
    <UserSwitchIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),
  Tag: ({ size, className, style, color }: IconProps) => (
    <TagIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),

  DotsThreeVertical: ({ size, className, style, color }: IconProps) => (
    <DotsThreeOutlineVerticalIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),
  DotsThree: ({ size, className, style, color }: IconProps) => (
    <DotsThreeOutlineIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),
  Sparkles: ({ size, className, style, color }: IconProps) => (
    <SparkleIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),
  House: ({ size, className, style, color }: IconProps) => (
    <HouseIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),
  UploadSimple: ({ size, className, style, color }: IconProps) => (
    <UploadSimpleIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),
  ClockCounterClockwise: ({ size, className, style, color }: IconProps) => (
    <ClockCounterClockwiseIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),

  // Alternative asset kind icons (duotone)
  RealEstateDuotone: ({ size, className, style, color }: IconProps) => (
    <GarageIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),
  VehicleDuotone: ({ size, className, style, color }: IconProps) => (
    <CarProfileIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),
  CollectibleDuotone: ({ size, className, style, color }: IconProps) => (
    <SketchLogoIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),
  PreciousDuotone: ({ size, className, style, color }: IconProps) => (
    <CoinsIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),
  LiabilityDuotone: ({ size, className, style, color }: IconProps) => (
    <CreditCardIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),
  OtherAssetDuotone: ({ size, className, style, color }: IconProps) => (
    <CubeIcon size={size} weight="duotone" className={className} style={style} color={color} />
  ),
  // Spending taxonomy icons (referenced by category seed data; keys must match
  // the strings stored in `taxonomy_categories.icon`).
  Award: Award,
  Banknote: Banknote,
  Code: Code,
  Coffee: Coffee,
  Dumbbell: Dumbbell,
  Film: Film,
  Fuel: Fuel,
  Gamepad2: Gamepad2,
  Gift: Gift,
  GraduationCap: GraduationCap,
  Heart: Heart,
  Laptop: Laptop,
  Lightbulb: Lightbulb,
  MoreHorizontal: MoreHorizontal,
  ParkingCircle: ParkingCircle,
  PiggyBank: PiggyBank,
  Pill: Pill,
  Plane: Plane,
  RotateCcw: RotateCcw,
  Shirt: Shirt,
  ShoppingBag: ShoppingBag,
  ShoppingCart: ShoppingCart,
  Smile: Smile,
  Sofa: Sofa,
  Stethoscope: Stethoscope,
  // Tag is registered above as a Phosphor TagIcon — don't re-register here
  // (Lucide and Phosphor Tag both want the same key).
  Train: Train,
  Truck: Truck,
  Tv: Tv,
  UtensilsCrossed: UtensilsCrossed,
  Wifi: Wifi,
  Wine: Wine,
  Wrench: Wrench,
};

/**
 * All available icon names
 */
export type IconName =
  | "AlertCircle"
  | "AlertTriangle"
  | "DatabaseBackup"
  | "DatabaseZap"
  | "Blocks"
  | "BadgeDollarSign"
  | "Grid3x3"
  | "Rows3"
  | "Calendar"
  | "Check"
  | "CheckCircle"
  | "Clock"
  | "Cloud"
  | "CloudSync"
  | "ListChecks"
  | "LayoutDashboard"
  | "HandCoins"
  | "Home"
  | "Copy"
  | "HelpCircle"
  | "History"
  | "ArrowRight"
  | "ArrowLeft"
  | "ArrowDown"
  | "ArrowDownLeft"
  | "ArrowUp"
  | "ArrowUpRight"
  | "CreditCard"
  | "Bitcoin"
  | "Brain"
  | "Briefcase"
  | "Search"
  | "Save"
  | "Group"
  | "Globe"
  | "Close"
  | "Eye"
  | "Info"
  | "EyeOff"
  | "Refresh"
  | "RefreshCw"
  | "PanelLeftOpen"
  | "Download"
  | "Ellipsis"
  | "Dot"
  | "Activity2"
  | "DollarSign"
  | "Users"
  | "User"
  | "ChevronUp"
  | "ChevronDown"
  | "ChevronsUpDown"
  | "ChevronLeft"
  | "ChevronRight"
  | "ChevronsLeft"
  | "ChevronsRight"
  | "Circle"
  | "Plus"
  | "Pencil"
  | "PlusCircle"
  | "PanelLeft"
  | "Minus"
  | "MinusCircle"
  | "PauseCircle"
  | "PlayCircle"
  | "Monitor"
  | "QrCode"
  | "Smartphone"
  | "PieChart"
  | "BarChart"
  | "Spinner"
  | "Loader"
  | "MoreVertical"
  | "DotsThreeVertical"
  | "Goal"
  | "Trash"
  | "Trash2"
  | "Tag"
  | "Hash"
  | "Type"
  | "Wallet"
  | "Import"
  | "FileText"
  | "FileX"
  | "XCircle"
  | "ListCollapse"
  | "ArrowRightLeft"
  | "ArrowLeftRight"
  | "Receipt"
  | "ReceiptDuotone"
  | "ReceiptText"
  | "Percent"
  | "Store"
  | "Package"
  | "PuzzlePiece"
  | "Star"
  | "Shield"
  | "ShieldAlert"
  | "ShieldCheck"
  | "ExternalLink"
  | "TrendingUp"
  | "TrendingDown"
  | "Wand2"
  | "Link"
  | "Unlink"
  | "Building"
  | "Car"
  | "Gem"
  | "Coins"
  | "Eraser"
  | "Sparkles"
  | "Palette"
  | "Moon"
  | "Sun"
  | "ListFilter"
  | "Undo"
  | "Fullscreen"
  | "RectangleEllipsis"
  | "Mail"
  | "OctagonX"
  | "Settings2"
  | "Dashboard"
  | "Goals"
  | "Database"
  | "FileCsv"
  | "FileJson"
  | "Files"
  | "Holdings"
  | "Activity"
  | "Settings"
  | "Invoice"
  | "Income"
  | "ChartBar"
  | "InfoCircle"
  | "CirclesFour"
  | "Addons"
  | "LogOut"
  | "Search2"
  | "Insight"
  | "Google"
  | "Apple"
  | "CloudSync2"
  | "CloudOff"
  | "Devices"
  | "UserSwitch"
  // Additional icons for UI components
  | "Baseline"
  | "CalendarDots"
  | "CalendarIcon"
  | "CaseSensitive"
  | "CheckSquare"
  | "File"
  | "FileArchive"
  | "FileAudio"
  | "FileImage"
  | "FileSpreadsheet"
  | "FileVideo"
  | "Folder"
  | "FolderOpen"
  | "List"
  | "Lock"
  | "LockOpen"
  | "Pin"
  | "PinOff"
  | "Presentation"
  | "Scissors"
  | "Split"
  | "SplitHorizontal"
  | "Square"
  | "Target"
  | "SparklesOutline"
  | "CircleGauge"
  | "X"
  | "Upload"
  | "DotsThree"
  | "House"
  | "UploadSimple"
  | "ClockCounterClockwise"
  | "RealEstateDuotone"
  | "VehicleDuotone"
  | "CollectibleDuotone"
  | "PreciousDuotone"
  | "LiabilityDuotone"
  | "OtherAssetDuotone"
  // Spending taxonomy icons
  | "Award"
  | "Banknote"
  | "Code"
  | "Coffee"
  | "Dumbbell"
  | "Film"
  | "Fuel"
  | "Gamepad2"
  | "Gift"
  | "GraduationCap"
  | "Heart"
  | "Laptop"
  | "Lightbulb"
  | "MoreHorizontal"
  | "ParkingCircle"
  | "PiggyBank"
  | "Pill"
  | "Plane"
  | "RotateCcw"
  | "Shirt"
  | "ShoppingBag"
  | "ShoppingCart"
  | "Smile"
  | "Sofa"
  | "Stethoscope"
  | "Train"
  | "Truck"
  | "Tv"
  | "UtensilsCrossed"
  | "Wifi"
  | "Wine"
  | "Wrench";

/**
 * Icons object with unified typing - all icons have the same Icon type
 */
export const Icons: Record<IconName, Icon> = IconsInternal as Record<IconName, Icon>;
