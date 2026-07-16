import { isWeb } from "@/adapters";
import { isAppleDevice } from "@/lib/device-utils";
import { useAuth } from "@/context/auth-context";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { type NavLink, type NavigationProps, isPathActive } from "./app-navigation";
import { ConnectNavItem } from "./connect-nav-item";
import { resolveNavigationIcon } from "./navigation-icons";

interface AppSidebarProps {
  navigation: NavigationProps;
}

const modKey = isAppleDevice() ? "⌘" : "Ctrl";

export function AppSidebar({ navigation }: AppSidebarProps) {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(true);
  const { logout, requiresAuth } = useAuth();
  const addonMenuItems = navigation?.addonMenuItems ?? navigation?.addons ?? [];

  return (
    <div
      className={cn({
        "light:bg-secondary/50 hidden h-full border-r pt-12 transition-[width] duration-300 ease-in-out md:flex md:flex-shrink-0 md:overflow-hidden": true,
        "md:w-sidebar": !collapsed,
        "md:w-sidebar-collapsed": collapsed,
      })}
      data-tauri-drag-region="true"
    >
      <div className="z-20 w-full rounded-xl md:flex">
        <div className="flex w-full flex-col">
          <div className="flex w-full flex-1 flex-col overflow-y-auto">
            <div data-tauri-drag-region="true" className="flex-1">
              <nav
                data-tauri-drag-region="true"
                aria-label={t("common:layout.sidebar")}
                className="flex shrink-0 flex-col p-2"
              >
                <div
                  data-tauri-drag-region="true"
                  className="draggable flex items-center justify-center pb-6"
                >
                  <Link to="/">
                    <img
                      className={`h-10 w-10 rounded-full bg-transparent shadow-lg transition-transform duration-700 ease-in-out [transform-style:preserve-3d] hover:[transform:rotateY(-180deg)] ${
                        collapsed ? "[transform:rotateY(180deg)]" : ""
                      }`}
                      aria-hidden="true"
                      src="/logo.png"
                    />
                  </Link>

                  <span
                    className={cn(
                      "text-md text-foreground/90 ml-2 font-serif text-xl font-bold transition-opacity delay-100 duration-300 ease-in-out",
                      {
                        "sr-only opacity-0": collapsed,
                        "block opacity-100": !collapsed,
                      },
                    )}
                  >
                    Wealthfolio
                  </span>
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    // Trigger the launcher by dispatching Cmd/Ctrl+K
                    const event = new KeyboardEvent("keydown", {
                      key: "k",
                      code: "KeyK",
                      keyCode: 75,
                      which: 75,
                      metaKey: true,
                      ctrlKey: true,
                      bubbles: true,
                      cancelable: true,
                    });
                    document.dispatchEvent(event);
                  }}
                  className={cn(
                    "text-foreground [&_svg]:size-5! mb-4 h-12 transition-all duration-300",
                    collapsed
                      ? "justify-center rounded-md"
                      : "bg-muted/50 hover:bg-muted/80 justify-start rounded-full px-4 shadow-none",
                  )}
                  title={t("common:layout.search_shortcut", { shortcut: `${modKey}+K` })}
                >
                  <span aria-hidden="true">
                    <Icons.Search2 className="h-5 w-5 opacity-60" />
                  </span>
                  <span
                    className={cn({
                      "text-muted-foreground ml-2 flex-1 text-left text-sm transition-opacity delay-100 duration-300 ease-in-out": true,
                      "sr-only opacity-0": collapsed,
                      "block opacity-100": !collapsed,
                    })}
                  >
                    {t("common:layout.search")}
                  </span>
                  {!collapsed && (
                    <kbd className="bg-background text-muted-foreground pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border px-1.5 font-mono text-[10px] font-medium opacity-100">
                      <span className="text-xs">{modKey}</span>K
                    </kbd>
                  )}
                </Button>

                {navigation?.primary?.map((item) => (
                  <NavItem key={item.title} item={item} collapsed={collapsed} />
                ))}

                {navigation?.pinnedAddons?.map((item) => (
                  <PinnedAddonNavItem
                    key={item.id ?? item.href}
                    item={item}
                    collapsed={collapsed}
                    onSetPinned={navigation.setAddonPinned}
                  />
                ))}

                {addonMenuItems.length > 0 && (
                  <AddonsMenu
                    addons={addonMenuItems}
                    collapsed={collapsed}
                    onSetPinned={navigation.setAddonPinned}
                  />
                )}
              </nav>
            </div>

            <div className="flex shrink-0 flex-col p-2">
              {navigation?.secondary?.map((item) => (
                <NavItem key={item.title} item={item} collapsed={collapsed} />
              ))}
              <ConnectNavItem collapsed={collapsed} />
              {isWeb && requiresAuth && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={logout}
                  className={cn(
                    "text-foreground [&_svg]:size-5! mb-1 h-12 rounded-md transition-all duration-300",
                    collapsed ? "justify-center" : "justify-start",
                  )}
                  title={t("common:layout.logout")}
                >
                  <span aria-hidden="true">
                    <Icons.LogOut className="h-5 w-5" />
                  </span>
                  <span
                    className={cn({
                      "ml-2 transition-opacity delay-100 duration-300 ease-in-out": true,
                      "sr-only opacity-0": collapsed,
                      "block opacity-100": !collapsed,
                    })}
                  >
                    {t("common:layout.logout")}
                  </span>
                </Button>
              )}
              <Separator className="mt-0" />
              <div className="flex justify-end">
                <Button
                  title={t("common:layout.toggle_sidebar")}
                  variant="ghost"
                  onClick={() => setCollapsed(!collapsed)}
                  className="text-muted-foreground [&_svg]:size-5! cursor-pointer rounded-md hover:bg-transparent"
                  aria-label={
                    collapsed
                      ? t("common:layout.expand_sidebar")
                      : t("common:layout.collapse_sidebar")
                  }
                >
                  <Icons.PanelLeftOpen
                    size={18}
                    className={`h-5 w-5 transition-transform duration-500 ease-in-out ${!collapsed ? "rotate-180" : ""}`}
                    aria-label={
                      collapsed
                        ? t("common:layout.expand_sidebar")
                        : t("common:layout.collapse_sidebar")
                    }
                  />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface PinnedAddonNavItemProps {
  item: NavLink;
  collapsed: boolean;
  onSetPinned?: (item: NavLink, pinned: boolean) => void;
}

function PinnedAddonNavItem({ item, collapsed, onSetPinned }: PinnedAddonNavItemProps) {
  const { t } = useTranslation();
  if (collapsed || !onSetPinned) {
    return <NavItem item={item} collapsed={collapsed} />;
  }

  return (
    <div className="group relative">
      <NavItem item={item} collapsed={collapsed} className="pr-10" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="hover:bg-accent pointer-events-none absolute right-1 top-1/2 z-10 h-8 w-8 -translate-y-1/2 rounded-full opacity-0 transition-opacity focus:pointer-events-auto focus:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100"
            title={t("common:layout.addon_options", { name: item.title })}
            aria-label={t("common:layout.addon_options", { name: item.title })}
          >
            <Icons.MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-48">
          <DropdownMenuItem onClick={() => onSetPinned(item, false)}>
            <Icons.PinOff className="mr-2 h-4 w-4" />
            {t("common:layout.unpin_from_sidebar")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

interface NavItemProps {
  item: NavLink;
  collapsed: boolean;
  className?: string;
  onClick?: () => void;
}

function NavItem({ item, collapsed, className, ...props }: NavItemProps) {
  const location = useLocation();
  const isActive = isPathActive(location.pathname, item.href);

  return (
    <Button
      key={item.title}
      variant={isActive ? "secondary" : "ghost"}
      asChild
      className={cn(
        "text-foreground [&_svg]:size-5! mb-1 h-12 rounded-md transition-all duration-300",
        collapsed ? "justify-center" : "justify-start",
        className,
      )}
    >
      <Link
        key={item.title}
        to={item.href}
        title={item.title}
        aria-current={isActive ? "page" : undefined}
        {...props}
      >
        <span aria-hidden="true">{resolveNavigationIcon(item.icon, "h-5 w-5")}</span>

        <span
          className={cn({
            "ml-2 transition-opacity delay-100 duration-300 ease-in-out": true,
            "sr-only opacity-0": collapsed,
            "block opacity-100": !collapsed,
          })}
        >
          {item.title}
        </span>
      </Link>
    </Button>
  );
}

interface AddonsMenuProps {
  addons: NavLink[];
  collapsed: boolean;
  onSetPinned?: (item: NavLink, pinned: boolean) => void;
}

function AddonsMenu({ addons, collapsed, onSetPinned }: AddonsMenuProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const hasActiveAddon = addons.some((addon) => isPathActive(location.pathname, addon.href));

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant={hasActiveAddon ? "secondary" : "ghost"}
          className={cn(
            "text-foreground [&_svg]:size-5! mb-1 h-12 rounded-md transition-all duration-300",
            collapsed ? "justify-center" : "justify-start",
          )}
        >
          <span aria-hidden="true">
            <Icons.Addons className="h-5 w-5" />
          </span>
          <span
            className={cn({
              "ml-2 transition-opacity delay-100 duration-300 ease-in-out": true,
              "sr-only opacity-0": collapsed,
              "block opacity-100": !collapsed,
            })}
          >
            {t("common:addons")}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side={collapsed ? "right" : "bottom"}
        align="start"
        className="w-max min-w-56 max-w-[calc(100vw-2rem)]"
      >
        {addons.map((addon) => {
          const isActive = isPathActive(location.pathname, addon.href);
          const pinAddon = () => {
            onSetPinned?.(addon, true);
            setOpen(false);
          };

          return (
            <div
              key={addon.id ?? addon.href}
              className={cn(
                "hover:bg-accent focus-within:bg-accent group flex h-12 items-center rounded-sm transition-colors",
                isActive && "bg-secondary",
              )}
            >
              <DropdownMenuItem
                asChild
                className="h-12 min-w-0 flex-1 gap-3 px-3 py-3 text-sm font-medium"
              >
                <Link to={addon.href} onClick={() => setOpen(false)}>
                  <span
                    aria-hidden="true"
                    className="flex size-5 shrink-0 items-center justify-center"
                  >
                    {resolveNavigationIcon(addon.icon, "h-5 w-5")}
                  </span>
                  <span className="whitespace-nowrap">{addon.title}</span>
                </Link>
              </DropdownMenuItem>
              {onSetPinned && (
                <button
                  type="button"
                  className="hover:bg-background focus:bg-background group-hover:bg-background hover:ring-border focus:ring-border group-hover:ring-border mr-1 flex size-8 shrink-0 items-center justify-center rounded-full opacity-0 outline-none transition-[background-color,box-shadow,opacity] hover:ring-1 focus:opacity-100 focus:ring-1 group-hover:opacity-100 group-hover:ring-1"
                  title={t("common:layout.pin_to_sidebar")}
                  aria-label={t("common:layout.pin_addon_to_sidebar", { name: addon.title })}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    pinAddon();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    pinAddon();
                  }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") {
                      return;
                    }

                    event.preventDefault();
                    event.stopPropagation();
                    pinAddon();
                  }}
                >
                  <Icons.Pin className="h-4 w-4" />
                </button>
              )}
            </div>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
