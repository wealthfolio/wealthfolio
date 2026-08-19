import { cn } from "../../lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import { motion } from "motion/react";
import { type ReactNode, useId, useState } from "react";

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
      full: "rounded-full",
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
  "relative z-10 flex-shrink-0 font-medium transition-colors cursor-pointer touch-manipulation select-none focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
  {
    variants: {
      size: {
        default: "h-8 px-4 text-sm",
        xs: "h-7 px-2.5 md:px-3 text-xs",
        compact: "h-8 px-3 text-xs",
        sm: "h-8 px-3.5 text-xs",
        md: "h-9 px-4.5 text-sm",
        lg: "h-10 px-5 text-base",
      },
      rounded: {
        full: "rounded-full",
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
  "data-testid"?: string;
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
  const uniqueId = useId();

  const isControlled = controlledValue !== undefined;
  const selected = isControlled ? controlledValue : internalValue;

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
            : "rounded-full";

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(animatedToggleVariants({ variant, size, rounded }), className)}
    >
      {items.map((item) => (
        <button
          key={item.value}
          onClick={() => handleSelect(item.value)}
          title={item.title}
          data-testid={item["data-testid"]}
          aria-pressed={selected === item.value}
          className={cn(
            animatedToggleItemVariants({ size, rounded }),
            selected === item.value ? "text-foreground" : "text-foreground/90 hover:text-foreground/80",
          )}
          type="button"
        >
          {selected === item.value && (
            <motion.div
              layoutId={`toggle-indicator-${uniqueId}`}
              className={cn("bg-background absolute inset-0 -z-10 shadow-sm", roundedClass)}
              initial={false}
              transition={{
                type: "spring",
                stiffness: 400,
                damping: 30,
              }}
            />
          )}
          {item.label}
        </button>
      ))}
    </div>
  );
}

export { animatedToggleItemVariants, animatedToggleVariants };
