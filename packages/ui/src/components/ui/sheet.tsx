"use client";

import { Dialog as SheetPrimitive } from "@base-ui/react/dialog";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/utils";
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
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

interface SheetOverlayProps extends Omit<SheetPrimitive.Backdrop.Props, "className"> {
  className?: string;
}

function SheetOverlay({ className, ...props }: SheetOverlayProps) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 fixed inset-0 z-50 bg-black/80",
        className,
      )}
      {...props}
    />
  );
}

const sheetVariants = cva(
  "fixed z-50 gap-4 bg-background p-6 shadow-lg transition ease-in-out data-open:animate-in data-closed:animate-out data-closed:duration-300 data-open:duration-500",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b data-closed:slide-out-to-top data-open:slide-in-from-top",
        bottom: "inset-x-0 bottom-0 border-t data-closed:slide-out-to-bottom data-open:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-3/4 border-r data-closed:slide-out-to-left data-open:slide-in-from-left sm:max-w-sm",
        right:
          "inset-y-0 right-0 h-full w-3/4  border-l data-closed:slide-out-to-right data-open:slide-in-from-right sm:max-w-sm",
      },
    },
    defaultVariants: {
      side: "right",
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
  side = "right",
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
            className="ring-offset-background focus:ring-ring bg-muted absolute right-4 cursor-pointer rounded-full p-2 opacity-70 transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:pointer-events-none"
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
  return <div className={cn("flex flex-col space-y-2 text-left", className)} {...props} />;
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)} {...props} />;
}

interface SheetTitleProps extends Omit<SheetPrimitive.Title.Props, "className"> {
  className?: string;
}

function SheetTitle({ className, ...props }: SheetTitleProps) {
  return <SheetPrimitive.Title className={cn("text-foreground text-lg font-semibold", className)} {...props} />;
}

interface SheetDescriptionProps extends Omit<SheetPrimitive.Description.Props, "className"> {
  className?: string;
}

function SheetDescription({ className, ...props }: SheetDescriptionProps) {
  return <SheetPrimitive.Description className={cn("text-muted-foreground text-sm", className)} {...props} />;
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
