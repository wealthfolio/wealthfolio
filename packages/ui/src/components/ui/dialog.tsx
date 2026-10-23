"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "./portal-scope";
import { Icons } from "./icons";
import { Sheet, SheetContent } from "./sheet";

// ============================================================================
// Mobile Detection
// ============================================================================

function defaultUseIsMobile() {
  const [isMobile, setIsMobile] = React.useState(false);

  React.useEffect(() => {
    const checkViewport = () => {
      setIsMobile(window.innerWidth < 768);
    };

    checkViewport();
    window.addEventListener("resize", checkViewport);

    return () => window.removeEventListener("resize", checkViewport);
  }, []);

  return isMobile;
}

// Context for passing mobile detection
interface DialogContextValue {
  isMobile: boolean;
}

const DialogContext = React.createContext<DialogContextValue>({
  isMobile: false,
});

// ============================================================================
// Dialog Root - Switches between Sheet (mobile) and Dialog (desktop)
// ============================================================================

interface DialogProps extends DialogPrimitive.Root.Props {
  /**
   * Custom hook to determine if mobile view
   */
  useIsMobile?: () => boolean;
}

function Dialog({ children, useIsMobile, ...props }: DialogProps) {
  const useIsMobileHook = useIsMobile || defaultUseIsMobile;
  const isMobile = useIsMobileHook();

  const contextValue = React.useMemo(() => ({ isMobile }), [isMobile]);

  if (isMobile) {
    return (
      <DialogContext.Provider value={contextValue}>
        <Sheet {...props}>{children}</Sheet>
      </DialogContext.Provider>
    );
  }

  return (
    <DialogContext.Provider value={contextValue}>
      <DialogPrimitive.Root data-slot="dialog" {...props}>
        {children}
      </DialogPrimitive.Root>
    </DialogContext.Provider>
  );
}

// ============================================================================
// Standard Dialog Components (shadcn pattern)
// ============================================================================

function DialogTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal(props: DialogPrimitive.Portal.Props) {
  const scopeProps = usePortalScopeProps();
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...scopeProps} {...props} />;
}

function DialogClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

interface DialogOverlayProps extends Omit<DialogPrimitive.Backdrop.Props, "className"> {
  className?: string;
}

function DialogOverlay({ className, ...props }: DialogOverlayProps) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        // The popup's duration: Base UI removes both when the popup's animation ends.
        "supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 fixed inset-0 isolate z-50 bg-black/10 duration-100",
        className,
      )}
      {...props}
    />
  );
}

// ============================================================================
// DialogContent - Responsive: Sheet on mobile, Dialog on desktop
// ============================================================================

interface DialogContentProps extends Omit<DialogPrimitive.Popup.Props, "className"> {
  className?: string;
  /**
   * Custom className for mobile sheet content
   */
  mobileClassName?: string;
  /**
   * Side to show the sheet from on mobile (default: "bottom")
   */
  side?: React.ComponentProps<typeof SheetContent>["side"];
  /**
   * Whether to show the close button (default: true)
   */
  showCloseButton?: boolean;
}

function DialogContent({
  className,
  children,
  mobileClassName = "h-[90vh] overflow-y-auto",
  side = "bottom",
  showCloseButton = true,
  ...props
}: DialogContentProps) {
  const { t } = useTranslation();
  const { isMobile } = React.useContext(DialogContext);

  if (isMobile) {
    return (
      <SheetContent
        side={side}
        showCloseButton={showCloseButton}
        className={cn(mobileClassName, "!rounded-t-4xl mx-1", className)}
      >
        {children}
      </SheetContent>
    );
  }

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "bg-card text-card-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 rounded-(--dialog-radius) border-(color:--overlay-border) shadow-(--overlay-shadow) fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border p-6 outline-none duration-100 [&>*]:min-w-0",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className="focus-visible:outline-solid focus-visible:outline-ring rounded-xs absolute end-4 top-4 opacity-70 transition-opacity hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"
          >
            <Icons.X />
            <span className="sr-only">{t("ui:dialog.close", "Close")}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

// ============================================================================
// Dialog Header, Footer, Title, Description
// ============================================================================

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-start", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end max-sm:[&_button]:h-auto max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-0 max-sm:[&_button]:max-w-full max-sm:[&_button]:shrink max-sm:[&_button]:whitespace-normal",
        className,
      )}
      {...props}
    />
  );
}

interface DialogTitleProps extends Omit<DialogPrimitive.Title.Props, "className"> {
  className?: string;
}

function DialogTitle({ className, ...props }: DialogTitleProps) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg font-semibold leading-none", className)}
      {...props}
    />
  );
}

interface DialogDescriptionProps extends Omit<DialogPrimitive.Description.Props, "className"> {
  className?: string;
}

function DialogDescription({ className, ...props }: DialogDescriptionProps) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground text-sm", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
