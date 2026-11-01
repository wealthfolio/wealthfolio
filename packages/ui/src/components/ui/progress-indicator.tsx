import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { Spinner } from "./spinner";
import { cn } from "../../lib/utils";
import { motion } from "motion/react";
import { useEffect, useState } from "react";

// A dialog on every screen size, phones included, as before: progress is a
// small card, not a bottom sheet.
const neverMobile = () => false;

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
  title: titleProp,
  description: descriptionProp,
  message: messageProp,
  className,
}: ProgressIndicatorProps) {
  const { t } = useTranslation();
  const title = titleProp ?? t("ui:progress.title", "Processing");
  const description =
    descriptionProp ??
    t("ui:progress.description", "Please wait while we process your request. This may take a few moments.");
  const message = messageProp ?? t("ui:progress.message", "Processing...");
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
            <Spinner className="text-primary size-8" />
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
            <div className="bg-secondary/30 h-2.5 w-full overflow-hidden rounded-full rtl:-scale-x-100">
              <motion.div
                className="bg-primary h-full rounded-full"
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
      <Dialog open={open} useIsMobile={neverMobile}>
        <DialogContent showCloseButton={false} className="border-none bg-transparent p-0 shadow-none sm:max-w-md">
          <DialogTitle className="sr-only">{title}</DialogTitle>
          <DialogDescription className="sr-only">{description}</DialogDescription>
          {progressContent}
        </DialogContent>
      </Dialog>
    );
  }

  // Otherwise, render directly
  return progressContent;
}
