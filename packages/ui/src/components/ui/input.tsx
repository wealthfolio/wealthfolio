import { Input as InputPrimitive } from "@base-ui/react/input";
import * as React from "react";

import { cn } from "../../lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-(color:--field-border) bg-input-bg h-input-height shadow-(--field-shadow) rounded-(--control-radius) w-full min-w-0 border px-3 py-1 text-base outline-none transition-colors file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2 pointer-coarse:focus-visible:-outline-offset-2",
        "aria-invalid:outline-destructive aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

Input.displayName = "Input";
export { Input };
