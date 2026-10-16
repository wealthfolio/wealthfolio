import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";
import { statusSurfaceVariants } from "./status-surface";

// Status alerts are glass: the status surface, text in the status colour and a light
// backdrop blur. Text reads at 4.5:1 or more on the page and on cards
// (e2e/design-system/colors.spec.ts).
const destructiveGlass = cn(
  statusSurfaceVariants({ status: "destructive" }),
  "text-destructive-subtle-foreground backdrop-blur-sm",
);
const successGlass = cn(
  statusSurfaceVariants({ status: "success" }),
  "text-success-subtle-foreground backdrop-blur-sm",
);
const warningGlass = cn(
  statusSurfaceVariants({ status: "warning" }),
  "text-warning-subtle-foreground backdrop-blur-sm",
);

// A grid, as in shadcn's Alert: an icon placed first sits in a tinted circle and is
// centred on the title and description; an AlertAction is a third column, centred too,
// so a text button never covers the text. With a title, the title takes the status
// colour and the description the page's text colour; without one, the sentence keeps
// the status colour. For a compact alert, set the font size on Alert (text-xs).
const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-lg border px-4 py-3 text-left text-sm has-[>svg]:grid-cols-[auto_1fr] has-data-[slot=alert-action]:grid-cols-[1fr_auto] has-[>svg]:has-data-[slot=alert-action]:grid-cols-[auto_1fr_auto] gap-x-3 *:[svg]:row-span-2 *:[svg]:self-center [&:not(:has([data-slot=alert-title]))>[data-slot=alert-description]]:row-span-2 [&:not(:has([data-slot=alert-title]))>[data-slot=alert-description]]:self-center [&:not(:has([data-slot=alert-description]))>[data-slot=alert-title]]:row-span-2 [&:not(:has([data-slot=alert-description]))>[data-slot=alert-title]]:self-center *:[svg]:box-content *:[svg]:rounded-full *:[svg]:bg-current/15 *:[svg]:p-1.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-background text-foreground",
        destructive: destructiveGlass,
        // The earlier name for destructive, kept for addons.
        error: destructiveGlass,
        success: successGlass,
        warning: warningGlass,
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Alert({ className, variant, ...props }: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return <div data-slot="alert" role="alert" className={cn(alertVariants({ variant }), className)} {...props} />;
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "[&_a]:underline-offset-3 font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "[&_a]:underline-offset-3 group-has-data-[slot=alert-title]/alert:text-foreground/90 text-balance group-has-[>svg]/alert:col-start-2 md:text-pretty [&_a]:underline [&_p:not(:last-child)]:mb-4 [&_p]:leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

// A button or link in the alert's last column, centred on the text.
function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("col-start-2 row-span-2 row-start-1 self-center group-has-[>svg]/alert:col-start-3", className)}
      {...props}
    />
  );
}

export { Alert, AlertAction, AlertDescription, AlertTitle };
