import * as React from "react";

import { Icons } from "./icons";
import { cn } from "../../lib/utils";

interface EmptyPlaceholderProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  title?: string;
  description?: string;
}

export function EmptyPlaceholder({ className, children, icon, title, description, ...props }: EmptyPlaceholderProps) {
  return (
    <div
      className={cn(
        "animate-in fade-in-50 flex flex-col items-center justify-center rounded-md p-8 text-center",
        className,
      )}
      {...props}
    >
      <div className="max-w-105 mx-auto flex flex-col items-center justify-center text-center">
        {icon && <div className="bg-muted flex size-20 items-center justify-center rounded-full">{icon}</div>}
        {title && <EmptyPlaceholder.Title>{title}</EmptyPlaceholder.Title>}
        {description && <EmptyPlaceholder.Description>{description}</EmptyPlaceholder.Description>}
        {children}
      </div>
    </div>
  );
}

interface EmptyPlaceholderIconProps extends Partial<React.SVGProps<SVGSVGElement>> {
  name: keyof typeof Icons;
}

EmptyPlaceholder.Icon = function EmptyPlaceHolderIcon({ name, className, ...props }: EmptyPlaceholderIconProps) {
  const Icon = Icons[name];

  if (!Icon) {
    return null;
  }

  // Filter out problematic props that might cause type issues
  const { children: _children, dominantBaseline: _dominantBaseline, ...validProps } = props;

  return (
    <div className="bg-muted flex h-20 w-20 items-center justify-center rounded-full">
      <Icon className={cn("h-10 w-10", className)} {...validProps} />
    </div>
  );
};

type EmptyPlacholderTitleProps = React.HTMLAttributes<HTMLHeadingElement>;

EmptyPlaceholder.Title = function EmptyPlaceholderTitle({ className, ...props }: EmptyPlacholderTitleProps) {
  return <h2 className={cn("mt-6 text-xl font-semibold", className)} {...props} />;
};

type EmptyPlacholderDescriptionProps = React.HTMLAttributes<HTMLParagraphElement>;

EmptyPlaceholder.Description = function EmptyPlaceholderDescription({
  className,
  ...props
}: EmptyPlacholderDescriptionProps) {
  return (
    <p
      className={cn("text-muted-foreground mb-8 mt-2 text-center text-sm font-normal leading-6", className)}
      {...props}
    />
  );
};
