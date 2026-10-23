"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import * as React from "react";

import { cn } from "../../lib/utils";
import { usePortalScopeProps } from "./portal-scope";
import { Icons } from "./icons";

function DropdownMenu(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal(props: MenuPrimitive.Portal.Props) {
  const scopeProps = usePortalScopeProps();
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...scopeProps} {...props} />;
}

function DropdownMenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

interface DropdownMenuContentProps
  extends
    Omit<MenuPrimitive.Popup.Props, "className">,
    Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset"> {
  className?: string;
}

function DropdownMenuContent({
  className,
  side = "bottom",
  sideOffset = 4,
  align = "center",
  alignOffset = 0,
  ...props
}: DropdownMenuContentProps) {
  const scopeProps = usePortalScopeProps();
  return (
    <MenuPrimitive.Portal {...scopeProps}>
      <MenuPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        className="isolate z-50 outline-none"
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-start-2 data-[side=inline-start]:slide-in-from-end-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 max-h-(--available-height) origin-(--transform-origin) ring-foreground/5 dark:ring-foreground/10 rounded-(--popup-radius) shadow-(--popup-shadow) z-50 min-w-32 overflow-y-auto overflow-x-hidden p-1 outline-none ring-1 duration-100",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuGroup(props: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

interface DropdownMenuLabelProps extends Omit<MenuPrimitive.GroupLabel.Props, "className"> {
  className?: string;
  inset?: boolean;
}

/** Labels the `DropdownMenuGroup` or `DropdownMenuRadioGroup` it sits in. */
function DropdownMenuLabel({ className, inset, ...props }: DropdownMenuLabelProps) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn("data-inset:ps-9.5 px-3 py-2 text-sm font-semibold", className)}
      {...props}
    />
  );
}

interface DropdownMenuItemProps extends Omit<MenuPrimitive.Item.Props, "className" | "onSelect"> {
  className?: string;
  inset?: boolean;
  variant?: "default" | "destructive";
  /**
   * @deprecated Radix's callback, kept so addons built against earlier SDKs keep working.
   * Use `onClick`, and `closeOnClick={false}` to keep the menu open.
   */
  onSelect?: (event: Event) => void;
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  onSelect,
  onClick,
  ...props
}: DropdownMenuItemProps) {
  // Radix kept the menu open when onSelect called preventDefault().
  const handleClick: MenuPrimitive.Item.Props["onClick"] = onSelect
    ? (event) => {
        onClick?.(event);
        onSelect(event.nativeEvent);
        if (event.nativeEvent.defaultPrevented) event.preventBaseUIHandler();
      }
    : onClick;
  return (
    <MenuPrimitive.Item
      onClick={handleClick}
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 data-inset:ps-9.5 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive-subtle data-[variant=destructive]:focus:text-destructive-subtle-foreground group/dropdown-menu-item relative flex cursor-pointer select-none items-center gap-2.5 rounded-[calc(var(--popup-radius)-0.125rem)] px-3 py-2 text-sm outline-none transition-colors [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSub(props: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

interface DropdownMenuSubTriggerProps extends Omit<MenuPrimitive.SubmenuTrigger.Props, "className"> {
  className?: string;
  inset?: boolean;
}

function DropdownMenuSubTrigger({ className, inset, children, ...props }: DropdownMenuSubTriggerProps) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "focus:bg-accent data-popup-open:bg-accent data-inset:ps-9.5 flex cursor-default select-none items-center gap-2.5 rounded-[calc(var(--popup-radius)-0.125rem)] px-3 py-2 text-sm outline-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {children}
      <Icons.ChevronRight className="ms-auto rtl:rotate-180" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  side = "inline-end",
  sideOffset = 0,
  align = "start",
  ...props
}: DropdownMenuContentProps) {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      side={side}
      sideOffset={sideOffset}
      align={align}
      className={cn("max-h-none overflow-hidden", className)}
      {...props}
    />
  );
}

interface DropdownMenuCheckboxItemProps extends Omit<MenuPrimitive.CheckboxItem.Props, "className"> {
  className?: string;
}

// Checkbox and radio items close the menu like other items, as Radix's did. Pass
// `closeOnClick={false}` to keep it open.
function DropdownMenuCheckboxItem({
  className,
  children,
  closeOnClick = true,
  ...props
}: DropdownMenuCheckboxItemProps) {
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 ps-9.5 relative flex cursor-default select-none items-center rounded-[calc(var(--popup-radius)-0.125rem)] py-2 pe-3 text-sm outline-none transition-colors",
        className,
      )}
      closeOnClick={closeOnClick}
      {...props}
    >
      <span className="absolute start-3 flex h-3.5 w-3.5 items-center justify-center">
        <MenuPrimitive.CheckboxItemIndicator>
          <Icons.Check className="h-4 w-4" />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup(props: MenuPrimitive.RadioGroup.Props) {
  return <MenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

interface DropdownMenuRadioItemProps extends Omit<MenuPrimitive.RadioItem.Props, "className"> {
  className?: string;
}

function DropdownMenuRadioItem({ className, children, closeOnClick = true, ...props }: DropdownMenuRadioItemProps) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 ps-9.5 relative flex cursor-default select-none items-center rounded-[calc(var(--popup-radius)-0.125rem)] py-2 pe-3 text-sm outline-none transition-colors",
        className,
      )}
      closeOnClick={closeOnClick}
      {...props}
    >
      <span className="absolute start-3 flex h-3.5 w-3.5 items-center justify-center">
        <MenuPrimitive.RadioItemIndicator>
          <Icons.Circle className="h-2 w-2 fill-current" />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

interface DropdownMenuSeparatorProps extends Omit<MenuPrimitive.Separator.Props, "className"> {
  className?: string;
}

function DropdownMenuSeparator({ className, ...props }: DropdownMenuSeparatorProps) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("bg-border/50 -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "group-focus/dropdown-menu-item:text-accent-foreground ms-auto text-xs tracking-widest opacity-60",
        className,
      )}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
};
