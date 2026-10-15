import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

import { buttonVariants } from "./button-variants";

export interface ButtonProps extends Omit<ButtonPrimitive.Props, "className">, VariantProps<typeof buttonVariants> {
  className?: string;
}

// Renders `type="button"`: a submit button says `type="submit"`. A link that looks
// like a button is the link itself with `buttonVariants`, not a Button: Button gives
// whatever it renders button semantics.
function Button({ className, variant, size, ...props }: ButtonProps) {
  return <ButtonPrimitive data-slot="button" className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { Button };
