"use client";

import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "./portal-scope";
import { Icons } from "./icons";

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

const sheetVariants = cva(
  "fixed z-50 gap-4 border-(color:--overlay-border) bg-(--sheet-bg) p-6 shadow-(--overlay-shadow) transition-transform ease-in-out data-closed:duration-300 data-open:duration-500",
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

interface SheetContentProps
  extends Omit<SheetPrimitive.Popup.Props, "className" | "style">, VariantProps<typeof sheetVariants> {
  className?: string;
  style?: React.CSSProperties;
  showCloseButton?: boolean;
}

function SheetContent({
  side = "inline-end",
  className,
  children,
  showCloseButton = true,
  style,
  ...props
}: SheetContentProps) {
  const { t } = useTranslation();
  const needsSafeAreaTop = side !== "bottom";
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        className={cn(sheetVariants({ side }), className)}
        style={{
          ...(needsSafeAreaTop && { paddingTop: "calc(env(safe-area-inset-top, 0px) + 1.5rem)" }),
          ...style,
        }}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            className="focus-visible:outline-ring bg-muted absolute end-4 cursor-pointer rounded-full p-2 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid disabled:pointer-events-none"
            style={{ top: needsSafeAreaTop ? "calc(env(safe-area-inset-top, 0px) + 1rem)" : "1rem" }}
          >
            <Icons.X className="h-5 w-5 sm:h-4 sm:w-4" />
            <span className="sr-only">{t("ui:sheet.close", "Close")}</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-header" className={cn("flex flex-col space-y-2 text-start", className)} {...props} />;
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
