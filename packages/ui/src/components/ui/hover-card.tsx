import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "./portal-scope";

function HoverCard(props: PreviewCardPrimitive.Root.Props) {
  return <PreviewCardPrimitive.Root data-slot="hover-card" {...props} />;
}

function HoverCardTrigger(props: PreviewCardPrimitive.Trigger.Props) {
  return <PreviewCardPrimitive.Trigger data-slot="hover-card-trigger" {...props} />;
}

interface HoverCardContentProps
  extends
    Omit<PreviewCardPrimitive.Popup.Props, "className">,
    Pick<PreviewCardPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset"> {
  className?: string;
}

function HoverCardContent({
  className,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  ...props
}: HoverCardContentProps) {
  const scopeProps = usePortalScopeProps();
  return (
    <PreviewCardPrimitive.Portal data-slot="hover-card-portal" {...scopeProps}>
      <PreviewCardPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        className="isolate z-50"
      >
        <PreviewCardPrimitive.Popup
          data-slot="hover-card-content"
          className={cn(
            "bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-start-2 data-[side=inline-start]:slide-in-from-end-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--transform-origin) ring-foreground/5 dark:ring-foreground/10 rounded-(--popup-radius) shadow-(--popup-shadow) z-50 w-64 p-4 outline-none ring-1 duration-100",
            className,
          )}
          {...props}
        />
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
