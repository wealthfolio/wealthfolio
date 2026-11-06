"use client";

import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { useIsMobile } from "../../hooks/use-mobile";
import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "./portal-scope";
import { Icons } from "./icons";
import { OverlayViewport, overlayContentStyle } from "./overlay-viewport";
import { SheetNavigation } from "./sheet-navigation";

function Sheet(props: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger(props: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose(props: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal(props: SheetPrimitive.Portal.Props) {
  const scopeProps = usePortalScopeProps();
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...scopeProps} {...props} />;
}

interface SheetOverlayProps extends Omit<SheetPrimitive.Backdrop.Props, "className"> {
  className?: string;
}

function SheetOverlay({ className, ...props }: SheetOverlayProps) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        // Transitions on Base UI's starting and ending styles, which it holds until removal.
        "data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs fixed inset-0 isolate z-50 bg-black/10 transition-opacity duration-150",
        className,
      )}
      {...props}
    />
  );
}

// With reduced motion the panel fades in place instead of sliding; the side
// variants' translate is overridden (!) whatever their direction variants.
// The fade is important too, as globals.css stops transform transitions.
const sheetVariants = cva(
  "pointer-events-auto max-h-[min(100%,var(--overlay-max-height,100%))] fixed z-50 gap-4 overflow-y-auto border-(color:--overlay-border) bg-(--sheet-bg) p-6 shadow-(--overlay-shadow) transition-transform ease-in-out data-closed:duration-300 data-open:duration-500 motion-reduce:transition-opacity! motion-reduce:data-starting-style:translate-none! motion-reduce:data-ending-style:translate-none! motion-reduce:data-starting-style:opacity-0 motion-reduce:data-ending-style:opacity-0",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b data-starting-style:-translate-y-full data-ending-style:-translate-y-full",
        bottom: "inset-x-0 bottom-0 border-t data-starting-style:translate-y-full data-ending-style:translate-y-full",
        // left and right are physical, as in shadcn; inline-start and inline-end
        // follow the reading direction and are what the app uses.
        left: "inset-y-0 left-0 h-full w-3/4 border-r data-starting-style:-translate-x-full data-ending-style:-translate-x-full sm:max-w-sm",
        right:
          "inset-y-0 right-0 h-full w-3/4 border-l data-starting-style:translate-x-full data-ending-style:translate-x-full sm:max-w-sm",
        "inline-start":
          "inset-y-0 start-0 h-full w-3/4 border-e data-starting-style:-translate-x-full data-ending-style:-translate-x-full rtl:data-starting-style:translate-x-full rtl:data-ending-style:translate-x-full sm:max-w-sm",
        "inline-end":
          "inset-y-0 end-0 h-full w-3/4 border-s data-starting-style:translate-x-full data-ending-style:translate-x-full rtl:data-starting-style:-translate-x-full rtl:data-ending-style:-translate-x-full sm:max-w-sm",
      },
    },
    defaultVariants: {
      side: "inline-end",
    },
  },
);

interface SheetContentProps extends Omit<SheetPrimitive.Popup.Props, "className">, VariantProps<typeof sheetVariants> {
  className?: string;
  showCloseButton?: boolean;
  safeArea?: boolean;
  /**
   * A bottom sheet runs on under the home indicator to the screen's edge, its
   * content staying above it. False for a sheet that floats clear of the edge.
   */
  fillSafeArea?: boolean;
}

/**
 * Extends a bottom sheet through the safe area below the overlay. The extra height is
 * a transparent bottom border, so the sheet's own background shows through it and a
 * caller's padding and background classes still apply.
 */
function fillSafeAreaStyle(style: React.CSSProperties | undefined): React.CSSProperties {
  const constrained = overlayContentStyle(style) as React.CSSProperties;
  return {
    ...constrained,
    bottom: "calc(-1 * var(--sheet-safe-bottom, 0px))",
    borderBottom: "var(--sheet-safe-bottom, 0px) solid transparent",
    maxHeight: `calc(${constrained.maxHeight ?? "min(100%, var(--overlay-max-height, 100%))"} + var(--sheet-safe-bottom, 0px))`,
  };
}

function SheetContent({
  side = "inline-end",
  className,
  children,
  showCloseButton = true,
  safeArea = true,
  fillSafeArea = true,
  style,
  ...props
}: SheetContentProps) {
  const { t } = useTranslation();
  // On phones, pickers inside open as screens of this sheet (dialogs are sheets there).
  const isMobile = useIsMobile();
  return (
    <SheetPortal>
      <SheetOverlay />
      <OverlayViewport safeArea={safeArea}>
        <SheetPrimitive.Popup
          data-slot="sheet-content"
          data-side={side}
          className={cn(sheetVariants({ side }), className)}
          style={
            side === "bottom" && fillSafeArea && typeof style !== "function"
              ? fillSafeAreaStyle(style)
              : overlayContentStyle(style)
          }
          {...props}
        >
          <SheetNavigation enabled={isMobile}>{children}</SheetNavigation>
          {showCloseButton && (
            <SheetPrimitive.Close
              data-slot="sheet-close"
              // Hidden while a SheetScreen covers the content: that screen has its own back button.
              // Above a floating SheetHeader.
              className="focus-visible:outline-ring bg-muted absolute end-4 top-4 z-[3] flex cursor-pointer items-center justify-center rounded-full p-2 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid disabled:pointer-events-none max-lg:min-h-11 max-lg:min-w-11 pointer-coarse:min-h-11 pointer-coarse:min-w-11 [[data-slot=sheet-content]:has([data-sheet-screen])>&]:hidden"
            >
              <Icons.X className="h-5 w-5 sm:h-4 sm:w-4" />
              <span className="sr-only">{t("ui:sheet.close", "Close")}</span>
            </SheetPrimitive.Close>
          )}
        </SheetPrimitive.Popup>
      </OverlayViewport>
    </SheetPortal>
  );
}

interface SheetHeaderProps extends React.ComponentProps<"div"> {
  /**
   * Floats the header, translucent and blurred, over the sheet's scrolling content.
   * It sets `--sheet-header-height` on its parent; give the scroll area that much
   * top padding (and scroll padding) so the content starts below it.
   */
  floating?: boolean;
}

function SheetHeader({ className, floating = false, ref, ...props }: SheetHeaderProps) {
  const headerRef = React.useRef<HTMLDivElement | null>(null);

  React.useLayoutEffect(() => {
    const header = headerRef.current;
    const parent = header?.parentElement;
    if (!floating || !header || !parent) return;
    const update = () => parent.style.setProperty("--sheet-header-height", `${header.offsetHeight}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(header);
    return () => {
      observer.disconnect();
      parent.style.removeProperty("--sheet-header-height");
    };
  }, [floating]);

  return (
    <div
      ref={(node) => {
        headerRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      data-slot="sheet-header"
      className={cn(
        "flex flex-col space-y-2 text-start",
        // Above the content it floats over, below the close button and any SheetScreen.
        floating &&
          "from-(--sheet-bg)/80 to-(--sheet-bg)/40 bg-linear-to-b absolute inset-x-0 top-0 z-[2] backdrop-blur-sm backdrop-saturate-150",
        className,
      )}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
      {...props}
    />
  );
}

interface SheetTitleProps extends Omit<SheetPrimitive.Title.Props, "className"> {
  className?: string;
}

function SheetTitle({ className, ...props }: SheetTitleProps) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-foreground text-lg font-semibold", className)}
      {...props}
    />
  );
}

interface SheetDescriptionProps extends Omit<SheetPrimitive.Description.Props, "className"> {
  className?: string;
}

function SheetDescription({ className, ...props }: SheetDescriptionProps) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
  SheetTrigger,
};
