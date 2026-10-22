import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { cva, type VariantProps } from "class-variance-authority";
import { motion } from "motion/react";
import * as React from "react";

import { cn } from "../../lib/utils";

const TabsIndicatorContext = React.createContext<string | undefined>(undefined);

interface TabsProps extends Omit<TabsPrimitive.Root.Props, "className"> {
  className?: string;
}

// Callers own the layout between the list and the panels (TabsContent keeps its mt-2).
function Tabs({ className, ...props }: TabsProps) {
  const indicatorId = React.useId();
  return (
    <TabsIndicatorContext.Provider value={indicatorId}>
      <TabsPrimitive.Root data-slot="tabs" className={cn("group/tabs", className)} {...props} />
    </TabsIndicatorContext.Provider>
  );
}

const tabsListVariants = cva(
  "group/tabs-list text-muted-foreground group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col h-10 inline-flex items-center justify-center rounded-md p-1 data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

interface TabsListProps extends Omit<TabsPrimitive.List.Props, "className">, VariantProps<typeof tabsListVariants> {
  className?: string;
}

// Arrow keys activate the tab they move to.
function TabsList({ className, variant = "default", activateOnFocus = true, ...props }: TabsListProps) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      activateOnFocus={activateOnFocus}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  );
}

interface TabsTriggerProps extends Omit<TabsPrimitive.Tab.Props, "className"> {
  className?: string;
}

function TabsTrigger({ className, children, ...props }: TabsTriggerProps) {
  const layoutId = React.useContext(TabsIndicatorContext) ?? "tabs-trigger-indicator";

  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "focus-visible:outline-solid focus-visible:outline-ring text-muted-foreground data-active:text-foreground hover:text-foreground group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start relative inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        // The line variant underlines the active tab instead of drawing the pill.
        "after:bg-foreground group-data-[variant=line]/tabs-list:data-active:after:opacity-100 group-data-horizontal/tabs:after:-bottom-1.25 group-data-horizontal/tabs:after:inset-x-0 group-data-vertical/tabs:after:inset-y-0 group-data-vertical/tabs:after:-end-1 group-data-horizontal/tabs:after:h-0.5 group-data-vertical/tabs:after:w-0.5 after:absolute after:opacity-0 after:transition-opacity",
        "isolate overflow-hidden group-data-[variant=line]/tabs-list:overflow-visible",
        className,
      )}
      render={(tabProps, state) => (
        <button {...tabProps}>
          {state.active && (
            <motion.span
              layout
              layoutId={layoutId}
              data-slot="segmented-thumb"
              className="bg-(--segmented-thumb) bg-(image:--segmented-thumb-image) shadow-(--segmented-thumb-shadow) ring-border/40 pointer-events-none absolute inset-0 z-0 ring-1 group-data-[variant=line]/tabs-list:hidden"
              style={{ borderRadius: "inherit" }}
              transition={{ type: "spring", stiffness: 500, damping: 35, mass: 0.6 }}
            />
          )}
          <span className="relative z-10 inline-flex items-center gap-2">{children}</span>
        </button>
      )}
      {...props}
    />
  );
}

interface TabsContentProps extends Omit<TabsPrimitive.Panel.Props, "className"> {
  className?: string;
}

function TabsContent({ className, ...props }: TabsContentProps) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn(
        "focus-visible:outline-solid focus-visible:outline-ring mt-2 focus-visible:outline-2 focus-visible:outline-offset-2",
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger, tabsListVariants };
