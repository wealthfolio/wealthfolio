import { cn } from "../../lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import { motion } from "motion/react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";

const animatedToggleVariants = cva("relative inline-flex items-center scrollbar-hide overflow-x-auto touch-pan-x", {
  variants: {
    variant: {
      default: "bg-muted",
      secondary: "bg-secondary",
    },
    size: {
      default: "gap-1 p-0.5",
      xs: "gap-0.5 md:gap-0.5 p-0.5",
      compact: "gap-px p-0.5",
      sm: "gap-0.5 p-0.5",
      md: "gap-1 p-0.5",
      lg: "gap-1.5 p-1",
    },
    rounded: {
      full: "rounded-(--segmented-radius)",
      lg: "rounded-lg",
      md: "rounded-md",
      sm: "rounded-sm",
      none: "rounded-none",
    },
  },
  defaultVariants: {
    variant: "default",
    size: "default",
    rounded: "full",
  },
});

const animatedToggleItemVariants = cva(
  "relative z-10 flex-shrink-0 font-medium transition-colors cursor-pointer touch-manipulation select-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
  {
    variants: {
      size: {
        default: "h-8 px-4 text-sm",
        xs: "h-7 px-2.5 md:px-3 text-xs",
        // Phone period rows: the padding shrinks so nine proportional labels fit at 360px.
        compact: "h-8 px-[clamp(0.375rem,2vw,0.75rem)] text-xs",
        sm: "h-8 px-3.5 text-xs",
        md: "h-9 px-4.5 text-sm",
        lg: "h-10 px-5 text-base",
      },
      rounded: {
        full: "rounded-(--segmented-radius)",
        lg: "rounded-lg",
        md: "rounded-md",
        sm: "rounded-sm",
        none: "rounded-none",
      },
    },
    defaultVariants: {
      size: "default",
      rounded: "full",
    },
  },
);

interface ToggleGroupItem<T extends string = string> {
  value: T;
  label: ReactNode;
  title?: string;
  /** Accessible name when the visible label needs more context. */
  "aria-label"?: string;
  "data-testid"?: string;
}

/** Where the thumb sits: over the selected button, in the group's coordinates. */
interface ThumbBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

function sameBox(a: ThumbBox | null, b: ThumbBox | null) {
  return (
    a === b ||
    (a !== null && b !== null && a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height)
  );
}

interface AnimatedToggleGroupProps<T extends string = string> extends VariantProps<typeof animatedToggleVariants> {
  items: ToggleGroupItem<T>[];
  defaultValue?: T;
  value?: T | null;
  onValueChange?: (value: T) => void;
  className?: string;
  "aria-label"?: string;
}

export function AnimatedToggleGroup<T extends string = string>(props: AnimatedToggleGroupProps<T>) {
  const {
    items,
    defaultValue,
    value: controlledValue,
    onValueChange,
    variant,
    size,
    rounded,
    className,
    "aria-label": ariaLabel,
  } = props;
  const [internalValue, setInternalValue] = useState<T | undefined>(defaultValue ?? items[0]?.value);
  const groupRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const [thumb, setThumb] = useState<ThumbBox | null>(null);

  const isControlled = controlledValue !== undefined;
  const selected = isControlled ? controlledValue : internalValue;

  // One thumb slides to the selected button, measured once the update is in the
  // page. A thumb per button, handed over with `layoutId`, was measured while
  // React was still swapping the content the group controls; Safari clamped the
  // page's scroll to that half-updated, shorter layout and kept it there.
  useLayoutEffect(() => {
    const measure = () => {
      const button = selected == null ? undefined : buttonRefs.current.get(selected);
      const next = button
        ? {
            left: button.offsetLeft,
            top: button.offsetTop,
            width: button.offsetWidth,
            height: button.offsetHeight,
          }
        : null;
      setThumb((current) => (sameBox(current, next) ? current : next));
    };
    measure();
    const group = groupRef.current;
    if (!group || typeof ResizeObserver === "undefined") return;
    // Labels and the group change size with fonts, the window and the locale.
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    for (const button of buttonRefs.current.values()) observer.observe(button);
    return () => observer.disconnect();
  }, [items, selected]);

  const handleSelect = (value: T) => {
    if (!isControlled) {
      setInternalValue(value);
    }
    onValueChange?.(value);
  };

  const roundedClass =
    rounded === "lg"
      ? "rounded-lg"
      : rounded === "md"
        ? "rounded-md"
        : rounded === "sm"
          ? "rounded-sm"
          : rounded === "none"
            ? "rounded-none"
            : "rounded-(--segmented-radius)";

  return (
    <div
      ref={groupRef}
      role="group"
      aria-label={ariaLabel}
      className={cn(animatedToggleVariants({ variant, size, rounded }), className)}
    >
      {/* Physical left on purpose: the offsets it moves by are measured from the left. */}
      {thumb && (
        <motion.div
          data-slot="segmented-thumb"
          aria-hidden
          className={cn(
            "bg-(--segmented-thumb) bg-(image:--segmented-thumb-image) shadow-(--segmented-thumb-shadow) pointer-events-none absolute left-0 top-0",
            roundedClass,
          )}
          initial={false}
          animate={{ x: thumb.left, y: thumb.top, width: thumb.width, height: thumb.height }}
          transition={{
            type: "spring",
            stiffness: 400,
            damping: 30,
          }}
        />
      )}
      {items.map((item) => (
        <button
          key={item.value}
          ref={(node) => {
            if (node) buttonRefs.current.set(item.value, node);
            else buttonRefs.current.delete(item.value);
          }}
          onClick={() => handleSelect(item.value)}
          title={item.title}
          aria-label={item["aria-label"]}
          data-testid={item["data-testid"]}
          aria-pressed={selected === item.value}
          className={cn(
            animatedToggleItemVariants({ size, rounded }),
            selected === item.value ? "text-foreground" : "text-foreground/90 hover:text-foreground/80",
          )}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

export { animatedToggleItemVariants, animatedToggleVariants };
