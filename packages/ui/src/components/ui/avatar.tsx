import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";

import { cn } from "../../lib/utils";

interface AvatarProps extends Omit<AvatarPrimitive.Root.Props, "className"> {
  className?: string;
}

function Avatar({ className, ...props }: AvatarProps) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn("relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full", className)}
      {...props}
    />
  );
}

interface AvatarImageProps extends Omit<AvatarPrimitive.Image.Props, "className"> {
  className?: string;
}

function AvatarImage({ className, ...props }: AvatarImageProps) {
  return (
    <AvatarPrimitive.Image
      data-slot="avatar-image"
      className={cn("aspect-square h-full w-full", className)}
      {...props}
    />
  );
}

interface AvatarFallbackProps extends Omit<AvatarPrimitive.Fallback.Props, "className"> {
  className?: string;
}

function AvatarFallback({ className, ...props }: AvatarFallbackProps) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      className={cn("bg-muted flex h-full w-full items-center justify-center rounded-full", className)}
      {...props}
    />
  );
}

export { Avatar, AvatarImage, AvatarFallback };
