import * as React from "react";
import { OTPInput, OTPInputContext } from "input-otp";

import { cn } from "../../lib/utils";
import { Icons } from "./icons";

function InputOTP({
  className,
  containerClassName,
  ...props
}: React.ComponentProps<typeof OTPInput> & { containerClassName?: string }) {
  return (
    <OTPInput
      data-slot="input-otp"
      // Codes are read and typed left to right in right-to-left pages too.
      containerClassName={cn("flex items-center gap-2 [direction:ltr] has-[:disabled]:opacity-50", containerClassName)}
      spellCheck={false}
      className={cn("disabled:cursor-not-allowed", className)}
      {...props}
    />
  );
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-group"
      className={cn("has-aria-invalid:border-destructive flex items-center", className)}
      {...props}
    />
  );
}

function InputOTPSlot({ index, className, ...props }: React.ComponentProps<"div"> & { index: number }) {
  const inputOTPContext = React.useContext(OTPInputContext);
  const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {};

  return (
    <div
      data-slot="input-otp-slot"
      data-active={isActive}
      className={cn(
        "border-input bg-input-bg dark:bg-input/30 aria-invalid:border-destructive data-[active=true]:outline-ring data-[active=true]:outline-solid relative flex h-10 w-10 items-center justify-center border-y border-e text-sm outline-none transition-all first:rounded-s-md first:border-s last:rounded-e-md data-[active=true]:z-10 data-[active=true]:outline-2 pointer-coarse:data-[active=true]:-outline-offset-2",
        className,
      )}
      {...props}
    >
      {char}
      {hasFakeCaret && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div className="animate-caret-blink bg-foreground h-4 w-px duration-1000" />
        </div>
      )}
    </div>
  );
}

function InputOTPSeparator({ ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-separator"
      className="flex items-center [&_svg:not([class*='size-'])]:size-4"
      role="separator"
      {...props}
    >
      <Icons.Dot />
    </div>
  );
}

export { InputOTP, InputOTPGroup, InputOTPSlot, InputOTPSeparator };
