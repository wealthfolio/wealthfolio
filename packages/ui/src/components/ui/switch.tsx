import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const switchRootVariants = cva(
  "focus-visible:ring-ring focus-visible:ring-offset-background data-checked:bg-primary data-unchecked:bg-input peer inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 data-disabled:cursor-not-allowed data-disabled:opacity-50",
  {
    variants: {
      size: {
        default: "h-6 w-11",
        sm: "h-4.5 w-8",
      },
    },
    defaultVariants: { size: "default" },
  },
);

const switchThumbVariants = cva(
  "bg-background pointer-events-none block rounded-full shadow-lg ring-0 transition-transform data-unchecked:translate-x-0",
  {
    variants: {
      size: {
        default: "h-5 w-5 data-checked:translate-x-5",
        sm: "h-3.5 w-3.5 data-checked:translate-x-3.5",
      },
    },
    defaultVariants: { size: "default" },
  },
);

interface SwitchProps extends Omit<SwitchPrimitive.Root.Props, "className">, VariantProps<typeof switchRootVariants> {
  className?: string;
}

function Switch({ className, size, ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root data-slot="switch" className={cn(switchRootVariants({ size }), className)} {...props}>
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className={cn(switchThumbVariants({ size }))} />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
