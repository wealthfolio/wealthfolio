import { Popover as PopoverPrimitive } from "@base-ui/react/popover";

import { cn } from "../../lib/utils";

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
  return (
    <PopoverPrimitive.Portal>
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
            "bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--transform-origin) z-50 w-72 rounded-md border p-4 shadow-md outline-none",
            className,
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent };
