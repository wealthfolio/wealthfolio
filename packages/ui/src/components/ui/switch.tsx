import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "../../lib/utils";

interface SwitchProps extends Omit<SwitchPrimitive.Root.Props, "className"> {
  className?: string;
  size?: "sm" | "default";
}

function Switch({ className, size = "default", ...props }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      data-size={size}
      className={cn(
        "focus-visible:outline-solid focus-visible:outline-ring data-checked:bg-(--switch-on) data-unchecked:bg-(--switch-off) aria-invalid:border-destructive data-[size=sm]:h-4.5 group/switch data-disabled:cursor-not-allowed data-disabled:opacity-50 h-(--switch-height) w-(--switch-width) peer relative inline-flex shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:outline-2 focus-visible:outline-offset-2 data-[size=sm]:w-8",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block rounded-full bg-(--switch-thumb) shadow-(--switch-thumb-shadow) ring-0 transition-transform group-data-[size=default]/switch:size-(--switch-thumb-size) group-data-[size=sm]/switch:size-3.5 group-data-[size=default]/switch:data-checked:translate-x-[calc(var(--switch-width)-var(--switch-thumb-size)-0.25rem)] group-data-[size=sm]/switch:data-checked:translate-x-3.5 data-unchecked:translate-x-0 rtl:group-data-[size=default]/switch:data-checked:-translate-x-[calc(var(--switch-width)-var(--switch-thumb-size)-0.25rem)] rtl:group-data-[size=sm]/switch:data-checked:-translate-x-3.5"
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
