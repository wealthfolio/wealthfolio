import { Select as SelectPrimitive } from "@base-ui/react/select";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "./portal-scope";
import { Icons } from "./icons";

// Pass `items` (an array of `{ value, label }` or a value-to-label record) so
// `SelectValue` shows the selected item's label rather than its raw value.
const Select = SelectPrimitive.Root;

function SelectGroup(props: SelectPrimitive.Group.Props) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue(props: SelectPrimitive.Value.Props) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

interface SelectTriggerProps extends Omit<SelectPrimitive.Trigger.Props, "className"> {
  className?: string;
}

function SelectTrigger({ className, children, ...props }: SelectTriggerProps) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn(
        "border-(color:--field-border) shadow-(--field-glow) bg-input-bg dark:bg-input/30 focus-visible:outline-solid focus-visible:outline-ring data-placeholder:text-muted-foreground h-input-height aria-invalid:outline-destructive aria-invalid:border-destructive dark:hover:bg-input/50 rounded-(--control-radius) flex w-full items-center justify-between gap-2 whitespace-nowrap border px-3 py-2 text-sm outline-none transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-1.5 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon className="flex shrink-0 opacity-50">
        <Icons.ChevronDown className="h-4 w-4" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

interface SelectScrollButtonProps extends Omit<SelectPrimitive.ScrollUpArrow.Props, "className"> {
  className?: string;
}

function SelectScrollUpButton({ className, ...props }: SelectScrollButtonProps) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn("bg-popover top-0 z-10 flex w-full cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <Icons.ChevronUp className="h-4 w-4" />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({ className, ...props }: SelectScrollButtonProps) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn("bg-popover bottom-0 z-10 flex w-full cursor-default items-center justify-center py-1", className)}
      {...props}
    >
      <Icons.ChevronDown className="h-4 w-4" />
    </SelectPrimitive.ScrollDownArrow>
  );
}

interface SelectContentProps
  extends
    Omit<SelectPrimitive.Popup.Props, "className">,
    Pick<SelectPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset" | "alignItemWithTrigger"> {
  className?: string;
}

function SelectContent({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  alignItemWithTrigger = true,
  ...props
}: SelectContentProps) {
  const scopeProps = usePortalScopeProps();
  return (
    <SelectPrimitive.Portal {...scopeProps}>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className="isolate z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-align-trigger={alignItemWithTrigger}
          className={cn(
            "bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-start-2 data-[side=inline-start]:slide-in-from-end-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 max-h-(--available-height) origin-(--transform-origin) ring-foreground/5 dark:ring-foreground/10 rounded-(--popup-radius) shadow-(--popup-shadow) relative z-50 min-w-[max(8rem,var(--anchor-width))] overflow-y-auto overflow-x-hidden ring-1 duration-100 data-[align-trigger=true]:animate-none",
            className,
          )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List className="p-1">{children}</SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

interface SelectLabelProps extends Omit<SelectPrimitive.GroupLabel.Props, "className"> {
  className?: string;
}

/** Labels the `SelectGroup` it sits in. */
function SelectLabel({ className, ...props }: SelectLabelProps) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn("py-2 pe-8 ps-2 text-sm font-semibold", className)}
      {...props}
    />
  );
}

interface SelectItemProps extends Omit<SelectPrimitive.Item.Props, "className"> {
  className?: string;
}

function SelectItem({ className, children, ...props }: SelectItemProps) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 relative flex w-full cursor-default select-none items-center rounded-[calc(var(--popup-radius)-0.125rem)] py-2 pe-8 ps-2 text-sm outline-none",
        className,
      )}
      {...props}
    >
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <span className="absolute end-2 flex h-3.5 w-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <Icons.Check className="h-3.5 w-3.5" />
        </SelectPrimitive.ItemIndicator>
      </span>
    </SelectPrimitive.Item>
  );
}

interface SelectSeparatorProps extends Omit<SelectPrimitive.Separator.Props, "className"> {
  className?: string;
}

function SelectSeparator({ className, ...props }: SelectSeparatorProps) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn("bg-border/50 pointer-events-none -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

export {
  Select,
  SelectGroup,
  SelectValue,
  SelectTrigger,
  SelectContent,
  SelectLabel,
  SelectItem,
  SelectSeparator,
  SelectScrollUpButton,
  SelectScrollDownButton,
};
