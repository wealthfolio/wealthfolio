import { isWeb } from "@/adapters";
import { useAuth } from "@/context/auth-context";
import { useI18n } from "@/i18n/i18n-provider";
import { isAppleDevice } from "@/lib/device-utils";
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
import { Link, useLocation } from "react-router-dom";
import { type NavLink, type NavigationProps, isPathActive } from "./app-navigation";
import { ConnectNavItem } from "./connect-nav-item";

interface AppSidebarProps {
  navigation: NavigationProps;
}

const modKey = isAppleDevice() ? "⌘" : "Ctrl";

export function AppSidebar({ navigation }: AppSidebarProps) {
  const [collapsed, setCollapsed] = useState(true);
  const { logout, requiresAuth } = useAuth();
  const { t } = useI18n();

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
                aria-label="Sidebar"
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
                  title={`${t("navigation.search")} (${modKey}+K)`}
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
                    {t("navigation.search.placeholder")}
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

                {navigation?.addons && navigation.addons.length > 0 && (
                  <AddonsMenu addons={navigation.addons} collapsed={collapsed} />
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
                  title={t("navigation.logout")}
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
                    {t("navigation.logout")}
                  </span>
                </Button>
              )}
              <Separator className="mt-0" />
              <div className="flex justify-end">
                <Button
                  title={t("navigation.toggleSidebar")}
                  variant="ghost"
                  onClick={() => setCollapsed(!collapsed)}
                  className="text-muted-foreground [&_svg]:size-5! cursor-pointer rounded-md hover:bg-transparent"
                  aria-label={
                    collapsed ? t("navigation.expandSidebar") : t("navigation.collapseSidebar")
                  }
                >
                  <Icons.PanelLeftOpen
                    size={18}
                    className={`h-5 w-5 transition-transform duration-500 ease-in-out ${!collapsed ? "rotate-180" : ""}`}
                    aria-label={
                      collapsed ? t("navigation.expandSidebar") : t("navigation.collapseSidebar")
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
        <span aria-hidden="true">{item.icon ?? <Icons.ArrowRight className="h-5 w-5" />}</span>

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
}

function AddonsMenu({ addons, collapsed }: AddonsMenuProps) {
  const location = useLocation();
  const { t } = useI18n();
  const hasActiveAddon = addons.some((addon) => isPathActive(location.pathname, addon.href));

  return (
    <DropdownMenu>
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
            {t("navigation.addons")}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={collapsed ? "right" : "bottom"} align="start" className="w-56">
        {addons.map((addon) => {
          const isActive = isPathActive(location.pathname, addon.href);
          return (
            <DropdownMenuItem key={addon.href} asChild>
              <Link
                to={addon.href}
                className={cn(
                  "flex h-12 w-full cursor-pointer items-center gap-3 px-3 py-3",
                  isActive && "bg-secondary",
                )}
              >
                <span
                  aria-hidden="true"
                  className="flex size-5 shrink-0 items-center justify-center"
                >
                  {addon.icon ?? <Icons.ArrowRight className="h-5 w-5" />}
                </span>
                <span className="text-sm font-medium">{addon.title}</span>
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
