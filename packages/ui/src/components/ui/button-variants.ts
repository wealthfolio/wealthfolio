import { cva } from "class-variance-authority";

// Outline and ghost buttons stay filled while the popup they open (menu, select,
// popover) is open; a disclosure (collapsible, accordion) only sets aria-expanded.
export const buttonVariants = cva(
  "group/button inline-flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap rounded-(--button-radius) border border-transparent bg-clip-padding select-none active:not-aria-[haspopup]:translate-y-px text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-invalid:outline-destructive aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default:
          "border-(color:--button-border) bg-primary bg-(image:--button-image) shadow-(--button-shadow) font-(weight:--button-weight) text-primary-foreground hover:bg-primary/90 disabled:bg-none disabled:shadow-none data-disabled:bg-none data-disabled:shadow-none",
        destructive:
          "bg-destructive-subtle font-(weight:--button-weight) text-destructive-subtle-foreground hover:bg-destructive-subtle-border/50",
        outline:
          "border border-(color:--button-outline-border) bg-(--button-outline-bg) bg-(image:--button-outline-image) shadow-(--button-outline-shadow) hover:bg-(--button-outline-hover-bg) hover:text-accent-foreground aria-[haspopup]:aria-expanded:bg-accent aria-[haspopup]:aria-expanded:text-accent-foreground dark:aria-[haspopup]:aria-expanded:bg-input/50",
        secondary:
          "border-(color:--button-secondary-border) bg-(--button-secondary-bg) bg-(image:--button-secondary-image) shadow-(--button-secondary-shadow) font-(weight:--button-weight) text-secondary-foreground hover:bg-(--button-secondary-hover-bg)",
        // A button that opens a picker in a form: it wears SelectTrigger's
        // surface, border, radius, label weight and hover, so pickers and
        // selects match in every theme.
        field:
          "border-(color:--field-border) bg-input-bg dark:bg-input/30 dark:hover:bg-input/50 shadow-(--field-glow) rounded-(--control-radius) font-normal",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 aria-[haspopup]:aria-expanded:bg-accent aria-[haspopup]:aria-expanded:text-accent-foreground dark:aria-[haspopup]:aria-expanded:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-(--control-size) px-5 py-2.5 has-[>svg]:px-4",
        xs: "h-8 gap-1 px-2.5 has-[>svg]:px-2",
        sm: "h-9 gap-1.5 px-4 has-[>svg]:px-3",
        lg: "h-11 px-7 has-[>svg]:px-5",
        icon: "size-10",

        "icon-xs": "size-8",
        "icon-sm": "size-9",
        "icon-lg": "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);
