import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

import { cn } from "../../lib/utils";

interface SeparatorProps extends Omit<SeparatorPrimitive.Props, "className"> {
  className?: string;
}

function Separator({ className, orientation = "horizontal", ...props }: SeparatorProps) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn("bg-border shrink-0", orientation === "horizontal" ? "h-px w-full" : "h-full w-px", className)}
      {...props}
    />
  );
}

export { Separator };
