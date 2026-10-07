import type { ComponentProps } from "react";
import { SheetContent, SheetHeader, SheetFooter } from "@wealthfolio/ui/components/ui/sheet";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { cn } from "@/lib/utils";

/** Match activity editors: a side sheet on desktop and a bottom sheet on mobile. */
export function LoanSheetContent({ className, ...props }: ComponentProps<typeof SheetContent>) {
  const isMobile = useIsMobileViewport();
  return (
    <SheetContent
      {...props}
      side={isMobile ? "bottom" : "right"}
      className={cn(
        "flex w-full flex-col gap-0 overflow-hidden",
        isMobile
          ? "rounded-t-4xl max-h-[90dvh] pb-[max(1.5rem,env(safe-area-inset-bottom))]"
          : "sm:max-w-[625px]",
        className,
      )}
    />
  );
}

export function LoanSheetHeader({ className, ...props }: ComponentProps<typeof SheetHeader>) {
  return (
    <SheetHeader
      data-testid="loan-sheet-header"
      {...props}
      className={cn("shrink-0 border-b pb-4 pr-10", className)}
    />
  );
}

export function LoanSheetBody({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-testid="loan-sheet-body"
      {...props}
      className={cn("-mx-1 min-h-0 flex-1 space-y-4 overflow-y-auto px-1 py-4", className)}
    />
  );
}

export function LoanSheetFooter({ className, ...props }: ComponentProps<typeof SheetFooter>) {
  return (
    <SheetFooter
      data-testid="loan-sheet-footer"
      {...props}
      className={cn(
        "mt-auto shrink-0 flex-row gap-2 border-t pt-4 sm:space-x-0 [&>button]:flex-1 sm:[&>button]:flex-none",
        className,
      )}
    />
  );
}
