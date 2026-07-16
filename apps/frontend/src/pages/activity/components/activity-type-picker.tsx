import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  type CarouselApi,
} from "@wealthfolio/ui/components/ui/carousel";
import { Icons, type IconName } from "@wealthfolio/ui/components/ui/icons";
import { ActivityType as CanonicalActivityType } from "@/lib/constants";
import { cn } from "@/lib/utils";

export type PrimaryActivityType =
  | typeof CanonicalActivityType.BUY
  | typeof CanonicalActivityType.SELL
  | typeof CanonicalActivityType.DEPOSIT
  | typeof CanonicalActivityType.WITHDRAWAL
  | typeof CanonicalActivityType.DIVIDEND
  | "TRANSFER";
export type SecondaryActivityType =
  | typeof CanonicalActivityType.SPLIT
  | typeof CanonicalActivityType.FEE
  | typeof CanonicalActivityType.INTEREST
  | typeof CanonicalActivityType.TAX;
export type ActivityType = PrimaryActivityType | SecondaryActivityType;

interface ActivityTypeConfig<T extends string> {
  value: T;
  labelKey: string;
  icon: IconName;
}

const PRIMARY_ACTIVITY_TYPES: ActivityTypeConfig<PrimaryActivityType>[] = [
  { value: CanonicalActivityType.BUY, labelKey: "activity:type_buy", icon: "TrendingUp" },
  { value: CanonicalActivityType.SELL, labelKey: "activity:type_sell", icon: "TrendingDown" },
  {
    value: CanonicalActivityType.DEPOSIT,
    labelKey: "activity:type_deposit",
    icon: "ArrowDownLeft",
  },
  {
    value: CanonicalActivityType.WITHDRAWAL,
    labelKey: "activity:type_withdrawal",
    icon: "ArrowUpRight",
  },
  { value: CanonicalActivityType.DIVIDEND, labelKey: "activity:type_dividend", icon: "Coins" },
  { value: "TRANSFER", labelKey: "activity:picker.transfer", icon: "ArrowLeftRight" },
];

const SECONDARY_ACTIVITY_TYPES: ActivityTypeConfig<SecondaryActivityType>[] = [
  { value: CanonicalActivityType.SPLIT, labelKey: "activity:picker.split", icon: "Split" },
  { value: CanonicalActivityType.FEE, labelKey: "activity:type_fee", icon: "Receipt" },
  { value: CanonicalActivityType.INTEREST, labelKey: "activity:type_interest", icon: "Percent" },
  { value: CanonicalActivityType.TAX, labelKey: "activity:type_tax", icon: "ReceiptText" },
];

const ALL_ACTIVITY_TYPES = [...PRIMARY_ACTIVITY_TYPES, ...SECONDARY_ACTIVITY_TYPES];

interface ActivityTypePickerProps {
  value?: ActivityType;
  onSelect: (type: ActivityType) => void;
  /** Optional list of allowed activity types. If not provided, all types are shown. */
  allowedTypes?: readonly string[];
}

type ViewMode = "carousel" | "grid";

function ActivityTypeButton({
  type,
  isSelected,
  onClick,
  onKeyDown,
  buttonRef,
  compact = false,
}: {
  type: ActivityTypeConfig<ActivityType>;
  isSelected: boolean;
  onClick: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const Icon = Icons[type.icon];

  return (
    <button
      data-testid={`activity-type-${type.value.toLowerCase()}`}
      ref={buttonRef}
      type="button"
      onClick={onClick}
      onKeyDown={onKeyDown}
      aria-pressed={isSelected}
      className={cn(
        "flex flex-col items-center justify-center gap-1.5 rounded-lg border-2 transition-all",
        "hover:bg-muted/50 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
        "cursor-pointer",
        compact ? "min-h-[72px] min-w-[80px] p-3" : "min-h-[80px] p-4",
        isSelected && "border-foreground bg-primary/5",
        !isSelected && "border-border",
      )}
    >
      <Icon
        className={cn(
          "h-5 w-5 transition-colors",
          isSelected ? "text-primary" : "text-muted-foreground",
        )}
      />
      <span
        className={cn(
          "whitespace-nowrap text-sm font-medium transition-colors",
          isSelected ? "text-primary" : "text-foreground",
        )}
      >
        {t(type.labelKey)}
      </span>
    </button>
  );
}

function CarouselView({
  value,
  onSelect,
  types,
}: {
  value?: ActivityType;
  onSelect: (type: ActivityType) => void;
  types: ActivityTypeConfig<ActivityType>[];
}) {
  const [canScrollPrev, setCanScrollPrev] = useState(false);
  const [canScrollNext, setCanScrollNext] = useState(false);

  // Set API and track scroll state
  const handleSetApi = useCallback(
    (api: CarouselApi) => {
      if (!api) return;

      const updateScrollState = () => {
        setCanScrollPrev(api.canScrollPrev());
        setCanScrollNext(api.canScrollNext());
      };

      updateScrollState();
      api.on("select", updateScrollState);
      api.on("reInit", updateScrollState);

      // Scroll to selected item on mount
      if (value) {
        const selectedIndex = types.findIndex((t) => t.value === value);
        if (selectedIndex >= 0) {
          setTimeout(() => api.scrollTo(selectedIndex), 0);
        }
      }
    },
    [value, types],
  );

  return (
    <div className="relative overflow-hidden">
      {/* Padding wrapper for selection ring and arrows */}
      <div className="px-1 py-1">
        <Carousel
          opts={{
            align: "start",
            dragFree: true,
            containScroll: "trimSnaps",
          }}
          setApi={handleSetApi}
          className="w-full"
        >
          <CarouselContent className="-ml-2">
            {types.map((type) => (
              <CarouselItem key={type.value} className="basis-auto pl-2">
                <ActivityTypeButton
                  type={type}
                  isSelected={value === type.value}
                  onClick={() => onSelect(type.value)}
                  compact
                />
              </CarouselItem>
            ))}
          </CarouselContent>

          {canScrollPrev && <CarouselPrevious className="left-0 h-7 w-7" />}
          {canScrollNext && <CarouselNext className="right-0 h-7 w-7" />}
        </Carousel>
      </div>
    </div>
  );
}

function GridView({
  value,
  onSelect,
  types,
}: {
  value?: ActivityType;
  onSelect: (type: ActivityType) => void;
  types: ActivityTypeConfig<ActivityType>[];
}) {
  const { t } = useTranslation();
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent, index: number) => {
      const total = types.length;
      const cols = 5; // 5 columns in grid
      let newIndex: number | null = null;

      switch (e.key) {
        case "ArrowRight":
          e.preventDefault();
          newIndex = (index + 1) % total;
          break;
        case "ArrowLeft":
          e.preventDefault();
          newIndex = (index - 1 + total) % total;
          break;
        case "ArrowDown":
          e.preventDefault();
          newIndex = (index + cols) % total;
          break;
        case "ArrowUp":
          e.preventDefault();
          newIndex = (index - cols + total) % total;
          break;
        case "Home":
          e.preventDefault();
          newIndex = 0;
          break;
        case "End":
          e.preventDefault();
          newIndex = total - 1;
          break;
      }

      if (newIndex !== null) {
        buttonRefs.current[newIndex]?.focus();
      }
    },
    [types.length],
  );

  return (
    <div className="p-1">
      <div
        role="group"
        aria-label={t("activity:picker.all_types_group")}
        className="grid grid-cols-5 gap-2"
      >
        {types.map((type, index) => (
          <ActivityTypeButton
            key={type.value}
            type={type}
            isSelected={value === type.value}
            onClick={() => onSelect(type.value)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            buttonRef={(el) => {
              buttonRefs.current[index] = el;
            }}
            compact
          />
        ))}
      </div>
    </div>
  );
}

export function ActivityTypePicker({ value, onSelect, allowedTypes }: ActivityTypePickerProps) {
  const { t } = useTranslation();
  const [viewMode, setViewMode] = useState<ViewMode>("carousel");

  const toggleViewMode = useCallback(() => {
    setViewMode((prev) => (prev === "carousel" ? "grid" : "carousel"));
  }, []);

  // Filter types if allowedTypes is provided
  const filteredTypes = allowedTypes
    ? ALL_ACTIVITY_TYPES.filter((type) => allowedTypes.includes(type.value))
    : ALL_ACTIVITY_TYPES;

  return (
    <div className="space-y-1 overflow-hidden">
      {/* Activity type selector */}
      {viewMode === "carousel" ? (
        <CarouselView value={value} onSelect={onSelect} types={filteredTypes} />
      ) : (
        <GridView value={value} onSelect={onSelect} types={filteredTypes} />
      )}

      {/* View toggle at bottom */}
      <div className="flex justify-center">
        <button
          type="button"
          onClick={toggleViewMode}
          className="text-muted-foreground hover:text-foreground flex items-center gap-1 py-1 transition-colors"
          aria-label={
            viewMode === "carousel"
              ? t("activity:picker.expand_all_types")
              : t("activity:picker.collapse")
          }
        >
          <Icons.ChevronDown
            className={cn(
              "h-4 w-4 transition-transform duration-200",
              viewMode === "grid" && "rotate-180",
            )}
          />
        </button>
      </div>
    </div>
  );
}
