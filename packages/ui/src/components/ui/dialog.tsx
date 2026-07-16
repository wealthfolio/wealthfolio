"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/utils";
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

interface DialogProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Root> {
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

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50",
        className,
      )}
      {...props}
    />
  );
}

// ============================================================================
// DialogContent - Responsive: Sheet on mobile, Dialog on desktop
// ============================================================================

interface DialogContentProps extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  /**
   * Custom className for mobile sheet content
   */
  mobileClassName?: string;
  /**
   * Side to show the sheet from on mobile (default: "bottom")
   */
  side?: "top" | "bottom" | "left" | "right";
  /**
   * Whether to show the close button (default: true)
   */
  showCloseButton?: boolean;
}

const DialogContent = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  (
    {
      className,
      children,
      mobileClassName = "h-[90vh] overflow-y-auto",
      side = "bottom",
      showCloseButton = true,
      ...props
    },
    ref,
  ) => {
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
      <DialogPortal data-slot="dialog-portal">
        <DialogOverlay />
        <DialogPrimitive.Content
          ref={ref}
          data-slot="dialog-content"
          className={cn(
            "bg-card text-card-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border p-6 shadow-lg duration-200",
            className,
          )}
          {...props}
        >
          {children}
          {showCloseButton && (
            <DialogPrimitive.Close
              data-slot="dialog-close"
              className="ring-offset-background focus:ring-ring data-[state=open]:bg-accent data-[state=open]:text-muted-foreground rounded-xs focus:outline-hidden absolute right-4 top-4 opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 disabled:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"
            >
              <Icons.X />
              <span className="sr-only">{t("ui:dialog.close", "Close")}</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    );
  },
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

// ============================================================================
// Dialog Header, Footer, Title, Description
// ============================================================================

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg font-semibold leading-none", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
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
