import * as React from "react";

import { cn } from "../../lib/utils";

/**
 * Phone form rows, as iOS lays out a form: a card of full-width rows, each with
 * its label at the start and its value at the end. A row is usually the field's
 * own trigger (a SelectTrigger or Button) given `formRowClassName`.
 */
function FormRowGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="form-row-group"
      className={cn("bg-card divide-border overflow-hidden rounded-2xl border divide-y [&>*]:min-w-0", className)}
      {...props}
    />
  );
}

/** Turns a field trigger into a row: no field chrome, label start, value end. */
const formRowClassName = cn(
  "flex h-auto min-h-14! w-full items-center justify-start gap-3 rounded-none border-0 bg-transparent px-4 py-3 text-start text-base font-normal shadow-none",
  "hover:bg-accent/40 dark:bg-transparent dark:hover:bg-accent/40 data-placeholder:text-foreground",
  // Inside the card, which clips what sits outside the row.
  "focus-visible:-outline-offset-2",
);

/** The value at a row's end; muted, as the label is what the row is about. */
const formRowValueClassName = "text-muted-foreground ms-auto min-w-0 truncate text-end";

function FormRowLabel({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="form-row-label" className={cn("text-foreground shrink-0", className)} {...props} />;
}

function FormRowValue({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="form-row-value" className={cn(formRowValueClassName, className)} {...props} />;
}

export { FormRowGroup, FormRowLabel, FormRowValue, formRowClassName, formRowValueClassName };
