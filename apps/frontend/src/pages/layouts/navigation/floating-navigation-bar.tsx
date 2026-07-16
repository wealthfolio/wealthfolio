import { LiquidGlass } from "@/components/liquid-glass";
import { SyncStatusIcon } from "@/features/wealthfolio-connect/components/sync-status-icon";
import { useAggregatedSyncStatus } from "@/features/wealthfolio-connect/hooks";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, Icons } from "@wealthfolio/ui";
import { motion } from "motion/react";
import { useCallback, useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { type NavigationProps, isPathActive } from "./app-navigation";
import { resolveNavigationIcon } from "./navigation-icons";

interface FloatingNavigationBarProps {
  navigation: NavigationProps;
}

export function FloatingNavigationBar({ navigation }: FloatingNavigationBarProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [overflowOpen, setOverflowOpen] = useState(false);
  const uniqueId = useId();
  const { status: syncStatus } = useAggregatedSyncStatus();
  const baseButtonClass =
    "text-foreground relative z-10 flex size-11 shrink-0 items-center justify-center rounded-full transition-colors";

  const handleNavigation = useCallback(
    (href: string, isActive: boolean) => {
      if (isActive) return;
      navigate(href);
    },
    [navigate],
  );

  const renderIcon = useCallback((icon?: ReactNode) => resolveNavigationIcon(icon, "size-6"), []);

  const primaryItems = navigation?.primary ?? [];
  const secondaryItems = navigation?.secondary ?? [];
  const pinnedAddonItems = navigation?.pinnedAddons ?? [];
  const addonMenuItems = navigation?.addonMenuItems ?? navigation?.addons ?? [];

  const baseItems = [...primaryItems, ...pinnedAddonItems, ...secondaryItems];
  const visibleCount = 15;
  const visibleItems = baseItems.slice(0, visibleCount);
  const overflowItems = baseItems.slice(visibleCount);
  const moreItems = [...overflowItems, ...addonMenuItems];
  const hasMoreItems = moreItems.length > 0;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40">
      <div className="flex justify-center px-4 pb-[var(--mobile-nav-bottom-offset)]">
        <LiquidGlass
          variant="floating"
          intensity="subtle"
          className={cn(
            "scrollbar-hide pointer-events-auto w-fit max-w-[calc(100vw-2rem)] overflow-x-auto px-1 py-1.5",
            "h-[var(--mobile-nav-ui-height)]",
          )}
        >
          <nav
            aria-label={t("common:layout.floating_navigation")}
            className="flex items-center gap-0"
          >
            {visibleItems.map((item) => {
              const isActive = isPathActive(location.pathname, item.href);
              return (
                <Link
                  key={item.href}
                  to={item.href}
                  onClick={() => handleNavigation(item.href, isActive)}
                  aria-label={item.title}
                  className={baseButtonClass}
                  aria-current={isActive ? "page" : undefined}
                >
                  {isActive && (
                    <motion.div
                      layoutId={`floating-nav-indicator-${uniqueId}`}
                      className="absolute inset-0 -z-10 rounded-full border border-black/10 bg-black/5 shadow-sm dark:border-white/10 dark:bg-white/10"
                      initial={false}
                      transition={{
                        type: "spring",
                        stiffness: 400,
                        damping: 30,
                      }}
                    />
                  )}
                  <span
                    className="relative flex size-7 shrink-0 items-center justify-center outline-none"
                    aria-hidden="true"
                  >
                    {renderIcon(item.icon)}
                  </span>
                </Link>
              );
            })}
            <button
              type="button"
              aria-label={t("common:layout.open_launcher")}
              className={baseButtonClass}
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
            >
              <span
                className="relative flex size-7 shrink-0 items-center justify-center outline-none"
                aria-hidden="true"
              >
                <Icons.Search2 className="size-6" />
              </span>
            </button>
            {/* Connect with status icon */}
            <Link
              to="/connect"
              onClick={() =>
                handleNavigation("/connect", isPathActive(location.pathname, "/connect"))
              }
              aria-label={t("common:connect")}
              className={baseButtonClass}
              aria-current={isPathActive(location.pathname, "/connect") ? "page" : undefined}
            >
              {isPathActive(location.pathname, "/connect") && (
                <motion.div
                  layoutId={`floating-nav-indicator-${uniqueId}`}
                  className="absolute inset-0 -z-10 rounded-full border border-black/10 bg-black/5 shadow-sm dark:border-white/10 dark:bg-white/10"
                  initial={false}
                  transition={{
                    type: "spring",
                    stiffness: 400,
                    damping: 30,
                  }}
                />
              )}
              <span
                className="relative flex size-7 shrink-0 items-center justify-center outline-none"
                aria-hidden="true"
              >
                <SyncStatusIcon status={syncStatus} className="size-6" />
              </span>
            </Link>
            {hasMoreItems && (
              <DropdownMenu open={overflowOpen} onOpenChange={setOverflowOpen}>
                <DropdownMenuTrigger asChild>
                  <button
                    aria-label={t("common:layout.more_navigation")}
                    className={baseButtonClass}
                  >
                    {moreItems.some((item) => isPathActive(location.pathname, item.href)) && (
                      <motion.div
                        layoutId={`floating-nav-indicator-${uniqueId}`}
                        className="absolute inset-0 -z-10 rounded-full border border-black/10 bg-black/5 shadow-sm dark:border-white/10 dark:bg-white/10"
                        initial={false}
                        transition={{
                          type: "spring",
                          stiffness: 400,
                          damping: 30,
                        }}
                      />
                    )}
                    <span
                      className="relative flex size-7 shrink-0 items-center justify-center outline-none"
                      aria-hidden="true"
                    >
                      <Icons.CirclesFour className="size-6" />
                    </span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="end"
                  sideOffset={16}
                  className="mb-0 mr-0 flex w-48 flex-col gap-1 border-0 bg-transparent p-0 shadow-none ring-0 ring-offset-0"
                >
                  {moreItems.map((item) => {
                    const isActive = isPathActive(location.pathname, item.href);
                    return (
                      <LiquidGlass key={item.href} variant="floating" intensity="subtle">
                        <Link
                          to={item.href}
                          onClick={() => {
                            handleNavigation(item.href, isActive);
                            setOverflowOpen(false);
                          }}
                          aria-current={isActive ? "page" : undefined}
                          className="relative z-10 flex w-full items-center gap-3 rounded-full px-3 py-2 text-sm"
                        >
                          <span className="flex size-6 shrink-0 items-center justify-center">
                            {renderIcon(item.icon)}
                          </span>
                          <span className="truncate text-left">{item.title}</span>
                        </Link>
                      </LiquidGlass>
                    );
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </nav>
        </LiquidGlass>
      </div>
    </div>
  );
}
