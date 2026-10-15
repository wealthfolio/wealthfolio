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

// A grid, as in shadcn's Alert: the icon spans the title and description rows and
// sits centred on the first line whatever the padding or font size. For a compact
// alert, set the font size on Alert (text-xs); the title and description inherit it.
const alertVariants = cva(
  "group/alert relative grid w-full gap-0.5 rounded-lg border px-4 py-3 text-left text-sm has-data-[slot=alert-action]:pr-18 has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 *:[svg]:row-span-2 *:[svg]:translate-y-[calc((1lh_-_100%)/2)] *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
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
        "[&_a]:underline-offset-3 text-balance md:text-pretty [&_a]:underline [&_p:not(:last-child)]:mb-4 [&_p]:leading-relaxed",
        className,
      )}
      {...props}
    />
  );
}

// A button or link at the top right of the alert.
function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-action" className={cn("absolute right-3 top-2.5", className)} {...props} />;
}

export { Alert, AlertAction, AlertDescription, AlertTitle };
