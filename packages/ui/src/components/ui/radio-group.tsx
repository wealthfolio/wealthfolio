"use client";

import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group";

import { cn } from "../../lib/utils";
import { Icons } from "./icons";

interface RadioGroupProps extends Omit<RadioGroupPrimitive.Props, "className"> {
  className?: string;
}

function RadioGroup({ className, ...props }: RadioGroupProps) {
  return <RadioGroupPrimitive data-slot="radio-group" className={cn("grid gap-2", className)} {...props} />;
}

interface RadioGroupItemProps extends Omit<RadioPrimitive.Root.Props, "className"> {
  className?: string;
}

function RadioGroupItem({ className, ...props }: RadioGroupItemProps) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "border-primary text-primary focus-visible:outline-solid focus-visible:outline-ring data-disabled:cursor-not-allowed data-disabled:opacity-50 inline-flex aspect-square h-4 w-4 items-center justify-center rounded-full border focus-visible:outline-2 focus-visible:outline-offset-2",
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator data-slot="radio-group-indicator" className="flex items-center justify-center">
        <Icons.Circle className="h-2.5 w-2.5 fill-current text-current" />
      </RadioPrimitive.Indicator>
    </RadioPrimitive.Root>
  );
}

export { RadioGroup, RadioGroupItem };
