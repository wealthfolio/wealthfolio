import { Progress as ProgressPrimitive } from "@base-ui/react/progress";

import { cn } from "../../lib/utils";

interface ProgressProps extends Omit<ProgressPrimitive.Root.Props, "className"> {
  className?: string;
}

function Progress({ className, ...props }: ProgressProps) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn("bg-secondary relative h-4 w-full overflow-hidden rounded-full", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="bg-primary data-indeterminate:w-0 h-full transition-all"
      />
    </ProgressPrimitive.Root>
  );
}

export { Progress };
