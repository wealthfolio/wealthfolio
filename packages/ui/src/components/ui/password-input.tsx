import * as React from "react";

import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Icons } from "./icons";
import { Input } from "./input";

interface PasswordInputProps extends Omit<React.ComponentProps<typeof Input>, "type"> {
  showLabel: string;
  hideLabel: string;
}

export function PasswordInput({ id, className, disabled, showLabel, hideLabel, ...props }: PasswordInputProps) {
  const generatedId = React.useId();
  const inputId = id ?? generatedId;
  const [visible, setVisible] = React.useState(false);
  const label = visible ? hideLabel : showLabel;

  return (
    <div className="relative">
      <Input
        {...props}
        id={inputId}
        type={visible ? "text" : "password"}
        disabled={disabled}
        className={cn("pe-10", className)}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-foreground absolute end-1 top-1/2 size-8 -translate-y-1/2"
        disabled={disabled}
        aria-label={label}
        aria-controls={inputId}
        title={label}
        onClick={() => setVisible((current) => !current)}
      >
        <span aria-hidden>{visible ? <Icons.EyeOff className="size-4" /> : <Icons.Eye className="size-4" />}</span>
      </Button>
    </div>
  );
}
