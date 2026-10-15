import { cva } from "class-variance-authority";

// The surface status alerts use, for panels and cards that carry a status but hold
// other content: the status's subtle colour at 60%, a hairline in its text colour and
// light along the top edge. Text keeps its own colour; Alert adds the status's.
export const statusSurfaceVariants = cva(
  "border shadow-[inset_0_1px_0_0_var(--surface-highlight)]",
  {
    variants: {
      status: {
        destructive: "border-destructive-subtle-foreground/12 bg-destructive-subtle/60",
        success: "border-success-subtle-foreground/12 bg-success-subtle/60",
        warning: "border-warning-subtle-foreground/12 bg-warning-subtle/60",
        info: "border-info-subtle-foreground/12 bg-info-subtle/60",
      },
    },
  },
);
