import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import * as React from "react";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "./portal-scope";

function Popover(props: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger(props: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

interface PopoverContentProps
  extends
    Omit<PopoverPrimitive.Popup.Props, "className">,
    Pick<
      PopoverPrimitive.Positioner.Props,
      "align" | "alignOffset" | "side" | "sideOffset" | "anchor" | "collisionPadding"
    > {
  className?: string;
}

function PopoverContent({
  className,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  anchor,
  collisionPadding,
  ...props
}: PopoverContentProps) {
  const scopeProps = usePortalScopeProps();
  return (
    <PopoverPrimitive.Portal {...scopeProps}>
      <PopoverPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionPadding={collisionPadding}
        className="isolate z-50"
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-start-2 data-[side=inline-start]:slide-in-from-end-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 max-h-(--available-height) origin-(--transform-origin) ring-foreground/5 dark:ring-foreground/10 rounded-(--popup-radius) shadow-(--popup-shadow) z-50 w-72 overflow-y-auto p-4 outline-none ring-1 duration-100",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

function PopoverHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="popover-header" className={cn("flex flex-col gap-1 text-sm", className)} {...props} />;
}

interface PopoverTitleProps extends Omit<PopoverPrimitive.Title.Props, "className"> {
  className?: string;
}

function PopoverTitle({ className, ...props }: PopoverTitleProps) {
  return <PopoverPrimitive.Title data-slot="popover-title" className={cn("font-medium", className)} {...props} />;
}

interface PopoverDescriptionProps extends Omit<PopoverPrimitive.Description.Props, "className"> {
  className?: string;
}

function PopoverDescription({ className, ...props }: PopoverDescriptionProps) {
  return (
    <PopoverPrimitive.Description
      data-slot="popover-description"
      className={cn("text-muted-foreground", className)}
      {...props}
    />
  );
}

export { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger };
