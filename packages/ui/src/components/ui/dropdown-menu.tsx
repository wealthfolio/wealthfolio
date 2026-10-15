"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import * as React from "react";

import { cn } from "../../lib/utils";
import { Icons } from "./icons";

function DropdownMenu(props: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal(props: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
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
  return (
    <MenuPrimitive.Portal>
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
            "bg-popover text-popover-foreground data-open:animate-in data-closed:animate-out data-closed:fade-out-0 data-open:fade-in-0 data-closed:zoom-out-95 data-open:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 max-h-(--available-height) origin-(--transform-origin) z-50 min-w-32 overflow-y-auto overflow-x-hidden rounded-md border p-1 shadow-md outline-none",
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
      className={cn("px-2 py-1.5 text-sm font-semibold", inset && "pl-8", className)}
      {...props}
    />
  );
}

interface DropdownMenuItemProps extends Omit<MenuPrimitive.Item.Props, "className"> {
  className?: string;
  inset?: boolean;
  variant?: "default" | "destructive";
}

function DropdownMenuItem({ className, inset, variant, ...props }: DropdownMenuItemProps) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        inset && "pl-8",
        variant === "destructive" && "text-destructive focus:text-destructive",
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
      className={cn(
        "focus:bg-accent data-popup-open:bg-accent flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        inset && "pl-8",
        className,
      )}
      {...props}
    >
      {children}
      <Icons.ChevronRight className="ml-auto" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  side = "right",
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
      className={cn("max-h-none overflow-hidden shadow-lg", className)}
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
        "focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors",
        className,
      )}
      closeOnClick={closeOnClick}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
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
        "focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none transition-colors",
        className,
      )}
      closeOnClick={closeOnClick}
      {...props}
    >
      <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
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
      className={cn("bg-muted -mx-1 my-1 h-px", className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn("ml-auto text-xs tracking-widest opacity-60", className)}
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
