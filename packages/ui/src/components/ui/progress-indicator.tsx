import { Dialog, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "./dialog";
import { Icons } from "./icons";
import { cn } from "../../lib/utils";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

// Custom DialogContent without close button
function DialogContentWithoutClose({
  className,
  children,
  ...props
}: Omit<DialogPrimitive.Popup.Props, "className"> & { className?: string }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          "bg-background data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-closed:slide-out-to-left-1/2 data-closed:slide-out-to-top-[48%] data-open:slide-in-from-left-1/2 data-open:slide-in-from-top-[48%] fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border p-6 shadow-lg duration-200 sm:rounded-lg",
          className,
        )}
        {...props}
      >
        {children}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

export interface ProgressIndicatorProps {
  isLoading?: boolean;
  open?: boolean;
  title?: string;
  description?: string;
  message?: string;
  className?: string;
}

export function ProgressIndicator({
  isLoading = true,
  open,
  title = "Processing",
  description = "Please wait while we process your request. This may take a few moments.",
  message = "Processing...",
  className,
}: ProgressIndicatorProps) {
  const [elapsedTime, setElapsedTime] = useState(0);

  // Track elapsed time during import
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    if (isLoading) {
      timer = setInterval(() => {
        setElapsedTime((prev) => prev + 1);
      }, 1000);
    } else {
      setElapsedTime(0);
    }

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [isLoading]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  // The progress content
  const progressContent = (
    <div className="mx-auto w-full max-w-md">
      <div className={cn("bg-card text-card-foreground rounded-lg border p-6 shadow-md", className)}>
        <div className="flex flex-col items-center space-y-4 text-center">
          <motion.div
            className="bg-primary/10 rounded-full p-4"
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{
              duration: 0.5,
              repeat: Number.POSITIVE_INFINITY,
              repeatType: "reverse",
              ease: "easeInOut",
            }}
          >
            <Icons.Settings className="h-8 w-8 animate-spin text-orange-500" />
          </motion.div>
          <motion.h3
            className="text-base font-medium"
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.3, delay: 0.1 }}
          >
            {message}
          </motion.h3>
          {description && (
            <motion.p
              className="text-muted-foreground text-sm"
              initial={{ y: 10, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.3, delay: 0.2 }}
            >
              {description}
            </motion.p>
          )}
          <motion.p
            className="text-muted-foreground text-sm tabular-nums"
            initial={{ y: 10, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.3, delay: 0.3 }}
          >
            {formatTime(elapsedTime)}
          </motion.p>
        </div>

        <div className="mt-6">
          <div className="relative h-2.5">
            {/* Beautiful gradient progress bar */}
            <div className="bg-secondary/30 h-2.5 w-full overflow-hidden rounded-full">
              <motion.div
                className="bg-linear-to-r h-full rounded-full from-red-500 via-orange-500 to-yellow-500"
                initial={{ x: "-100%" }}
                animate={{ x: "100%" }}
                transition={{
                  repeat: Number.POSITIVE_INFINITY,
                  duration: 2,
                  ease: "easeInOut",
                }}
                style={{ width: "50%" }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  // If open prop is provided, render as a dialog
  if (open !== undefined) {
    return (
      <Dialog open={open}>
        <DialogContentWithoutClose className="border-none bg-transparent p-0 shadow-none sm:max-w-md">
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <DialogDescription className="sr-only">{description}</DialogDescription>
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.3 }}
          >
            {progressContent}
          </motion.div>
        </DialogContentWithoutClose>
      </Dialog>
    );
  }

  // Otherwise, render directly
  return progressContent;
}
