import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { motion } from "motion/react";
import * as React from "react";

import { cn } from "../../lib/utils";

const TabsIndicatorContext = React.createContext<string | undefined>(undefined);

function Tabs(props: TabsPrimitive.Root.Props) {
  const indicatorId = React.useId();
  return (
    <TabsIndicatorContext.Provider value={indicatorId}>
      <TabsPrimitive.Root data-slot="tabs" {...props} />
    </TabsIndicatorContext.Provider>
  );
}

interface TabsListProps extends Omit<TabsPrimitive.List.Props, "className"> {
  className?: string;
}

// Arrow keys activate the tab they move to.
function TabsList({ className, activateOnFocus = true, ...props }: TabsListProps) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      activateOnFocus={activateOnFocus}
      className={cn(
        "bg-muted text-muted-foreground inline-flex h-10 items-center justify-center rounded-md p-1",
        className,
      )}
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
        "ring-offset-background focus-visible:ring-ring text-muted-foreground data-active:text-foreground relative inline-flex items-center justify-center whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
        "isolate overflow-hidden",
        className,
      )}
      render={(tabProps, state) => (
        <button {...tabProps}>
          {state.active && (
            <motion.span
              layout
              layoutId={layoutId}
              className="bg-background ring-border/40 pointer-events-none absolute inset-0 z-0 shadow-sm ring-1"
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
        "ring-offset-background focus-visible:ring-ring mt-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
        className,
      )}
      {...props}
    />
  );
}

export { Tabs, TabsContent, TabsList, TabsTrigger };
