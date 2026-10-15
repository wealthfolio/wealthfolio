import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

// Status alerts are glass: a translucent status surface, a hairline in the text
// colour and light along the top edge. Text reads at 4.5:1 or more on the page and
// on cards (e2e/design-system/colors.spec.ts).
const glass = "shadow-[inset_0_1px_0_0_var(--surface-highlight)] backdrop-blur-sm";

const alertVariants = cva(
  "relative w-full rounded-lg border p-4 [&>svg~*]:pl-7 [&>svg+div]:translate-y-[-3px] [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground",
  {
    variants: {
      variant: {
        default: "bg-background text-foreground",
        destructive: "border-destructive/50 text-destructive dark:border-destructive [&>svg]:text-destructive",
        error: cn(
          "border-destructive-subtle-foreground/12 bg-destructive-subtle/60 text-destructive-subtle-foreground [&>svg]:text-destructive-subtle-foreground",
          glass,
        ),
        success: cn(
          "border-success-subtle-foreground/12 bg-success-subtle/60 text-success-subtle-foreground [&>svg]:text-success-subtle-foreground",
          glass,
        ),
        warning: cn(
          "border-warning-subtle-foreground/12 bg-warning-subtle/60 text-warning-subtle-foreground [&>svg]:text-warning-subtle-foreground",
          glass,
        ),
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const Alert = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>
>(({ className, variant, ...props }, ref) => (
  <div ref={ref} role="alert" className={cn(alertVariants({ variant }), className)} {...props} />
));
Alert.displayName = "Alert";

const AlertTitle = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h5 ref={ref} className={cn("mb-1 font-medium leading-none tracking-tight", className)} {...props} />
  ),
);
AlertTitle.displayName = "AlertTitle";

const AlertDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-sm [&_p]:leading-relaxed", className)} {...props} />
  ),
);
AlertDescription.displayName = "AlertDescription";

export { Alert, AlertTitle, AlertDescription };
