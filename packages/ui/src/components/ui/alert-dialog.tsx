import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import * as React from "react";

import { buttonVariants } from "./button-variants";
import { cn } from "../../lib/utils";

function AlertDialog(props: AlertDialogPrimitive.Root.Props) {
  return <AlertDialogPrimitive.Root data-slot="alert-dialog" {...props} />;
}

function AlertDialogTrigger(props: AlertDialogPrimitive.Trigger.Props) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

function AlertDialogPortal(props: AlertDialogPrimitive.Portal.Props) {
  return <AlertDialogPrimitive.Portal data-slot="alert-dialog-portal" {...props} />;
}

interface AlertDialogOverlayProps extends Omit<AlertDialogPrimitive.Backdrop.Props, "className"> {
  className?: string;
}

function AlertDialogOverlay({ className, ...props }: AlertDialogOverlayProps) {
  return (
    <AlertDialogPrimitive.Backdrop
      data-slot="alert-dialog-overlay"
      className={cn(
        "data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 fixed inset-0 z-50 bg-black/80",
        className,
      )}
      {...props}
    />
  );
}

interface AlertDialogContentProps extends Omit<AlertDialogPrimitive.Popup.Props, "className"> {
  className?: string;
}

function AlertDialogContent({ className, ...props }: AlertDialogContentProps) {
  return (
    <AlertDialogPortal>
      <AlertDialogOverlay />
      <AlertDialogPrimitive.Popup
        data-slot="alert-dialog-content"
        className={cn(
          "bg-background data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 fixed left-[50%] top-[50%] z-50 grid max-h-[calc(100dvh-env(safe-area-inset-bottom,0px)-2rem)] w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 overflow-y-auto border p-6 shadow-lg duration-200 max-sm:bottom-[calc(env(safe-area-inset-bottom)+1rem)] max-sm:left-4 max-sm:right-4 max-sm:top-auto max-sm:w-auto max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-3xl max-sm:shadow-2xl sm:rounded-lg [&>*]:min-w-0",
          className,
        )}
        {...props}
      />
    </AlertDialogPortal>
  );
}

function AlertDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col space-y-2 text-center sm:text-left", className)} {...props} />;
}

function AlertDialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-3 sm:flex-row sm:flex-wrap sm:justify-end sm:gap-2 max-sm:[&_button]:h-auto max-sm:[&_button]:min-h-11 max-sm:[&_button]:min-w-0 max-sm:[&_button]:max-w-full max-sm:[&_button]:shrink max-sm:[&_button]:whitespace-normal",
        className,
      )}
      {...props}
    />
  );
}

interface AlertDialogTitleProps extends Omit<AlertDialogPrimitive.Title.Props, "className"> {
  className?: string;
}

function AlertDialogTitle({ className, ...props }: AlertDialogTitleProps) {
  return <AlertDialogPrimitive.Title className={cn("text-lg font-semibold", className)} {...props} />;
}

interface AlertDialogDescriptionProps extends Omit<AlertDialogPrimitive.Description.Props, "className"> {
  className?: string;
}

function AlertDialogDescription({ className, ...props }: AlertDialogDescriptionProps) {
  return <AlertDialogPrimitive.Description className={cn("text-muted-foreground text-sm", className)} {...props} />;
}

interface AlertDialogCloseProps extends Omit<AlertDialogPrimitive.Close.Props, "className"> {
  className?: string;
}

/**
 * Confirms and closes the dialog. To keep it open, for example while the
 * action is pending, call `event.preventBaseUIHandler()` in `onClick`.
 */
function AlertDialogAction({ className, ...props }: AlertDialogCloseProps) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-action"
      className={cn(buttonVariants(), className)}
      {...props}
    />
  );
}

function AlertDialogCancel({ className, ...props }: AlertDialogCloseProps) {
  return (
    <AlertDialogPrimitive.Close
      data-slot="alert-dialog-cancel"
      className={cn(buttonVariants({ variant: "outline" }), "mt-0", className)}
      {...props}
    />
  );
}

export {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogTrigger,
};
