import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "./portal-scope";

function TooltipProvider(props: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" {...props} />;
}

function Tooltip(props: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger(props: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

interface TooltipContentProps
  extends
    Omit<TooltipPrimitive.Popup.Props, "className">,
    Pick<TooltipPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset" | "collisionPadding"> {
  className?: string;
}

function TooltipContent({
  className,
  side = "top",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  collisionPadding,
  children,
  ...props
}: TooltipContentProps) {
  const scopeProps = usePortalScopeProps();
  return (
    <TooltipPrimitive.Portal {...scopeProps}>
      <TooltipPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        collisionPadding={collisionPadding}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "bg-foreground text-background data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-start-2 data-[side=inline-start]:slide-in-from-end-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 origin-(--transform-origin) z-50 w-fit max-w-xs rounded-md px-3 py-1.5 text-xs",
            className,
          )}
          {...props}
        >
          {children}
          {/* bg-inherit: the arrow follows a call site's bubble colour. */}
          <TooltipPrimitive.Arrow className="data-[side=inline-end]:top-1/2! data-[side=inline-start]:top-1/2! data-[side=left]:top-1/2! data-[side=right]:top-1/2! z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px] bg-inherit data-[side=bottom]:top-1 data-[side=inline-end]:-start-1 data-[side=inline-start]:-end-1 data-[side=left]:-right-1 data-[side=right]:-left-1 data-[side=top]:-bottom-2.5 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-end]:translate-x-[1.5px] data-[side=inline-start]:-translate-y-1/2 data-[side=inline-start]:translate-x-[-1.5px] data-[side=left]:-translate-y-1/2 data-[side=left]:translate-x-[-1.5px] data-[side=right]:-translate-y-1/2 data-[side=right]:translate-x-[1.5px] rtl:data-[side=inline-end]:translate-x-[-1.5px] rtl:data-[side=inline-start]:translate-x-[1.5px]" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
