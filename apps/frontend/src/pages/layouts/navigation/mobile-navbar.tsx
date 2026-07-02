import { LiquidGlass } from "@/components/liquid-glass";
import { SyncStatusIcon } from "@/features/wealthfolio-connect/components/sync-status-icon";
import { useAggregatedSyncStatus } from "@/features/wealthfolio-connect/hooks";
import { useHapticFeedback } from "@/hooks/use-haptic-feedback";
import { useI18n } from "@/i18n/i18n-provider";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  Icons,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@wealthfolio/ui";
import { motion } from "motion/react";
import React, { useCallback, useId, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { type NavigationProps, isPathActive } from "./app-navigation";

interface MobileNavBarProps {
  navigation: NavigationProps;
}

export function MobileNavBar({ navigation }: MobileNavBarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [addonsSheetOpen, setAddonsSheetOpen] = useState(false);
  const { triggerHaptic } = useHapticFeedback();
  const uniqueId = useId();
  const { status: syncStatus } = useAggregatedSyncStatus();
  const { t } = useI18n();

  const containerClassName = "pointer-events-none fixed inset-x-0 bottom-0 z-50";

  const handleNavigation = useCallback(
    (href: string, isActive: boolean) => {
      if (isActive) return;
      triggerHaptic();
      navigate(href);
    },
    [triggerHaptic, navigate],
  );

  const renderIcon = useCallback((icon?: React.ReactNode) => {
    if (!icon) {
      return <Icons.ArrowRight className="size-6" />;
    }

    if (React.isValidElement<{ className?: string }>(icon)) {
      return icon.props.className ? icon : React.cloneElement(icon, { className: "size-6" });
    }

    if (typeof icon === "function") {
      const IconComponent = icon as React.ComponentType<{ className?: string }>;
      return <IconComponent className="size-6" />;
    }

    return <span className="size-6">{icon}</span>;
  }, []);

  const primaryItems = navigation?.primary ?? [];
  const secondaryItems = navigation?.secondary ?? [];
  const addonItems = navigation?.addons ?? [];

  const searchItem = {
    title: t("navigation.search"),
    href: "#search",
    icon: <Icons.Search2 className="size-6" />,
  };

  const visibleItems = [primaryItems[0], primaryItems[1], searchItem].filter(Boolean);

  const menuItems = [...primaryItems.slice(2), ...secondaryItems];

  const hasMenu = menuItems.length > 0 || addonItems.length > 0;
  const hasAddons = addonItems.length > 0;
  const columnCount = visibleItems.length + (hasMenu ? 1 : 0);

  return (
    <div className={containerClassName}>
      {/* Lift off bottom by the design gap while respecting safe area */}
      <div className="flex justify-center px-4 pb-[var(--mobile-nav-bottom-offset)]">
        <LiquidGlass
          variant="floating"
          intensity="subtle"
          className={cn("pointer-events-auto w-full px-1 py-1", "h-[var(--mobile-nav-ui-height)]")}
        >
          <nav
            aria-label={t("navigation.primary")}
            className={cn("grid place-items-center gap-2")}
            style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
          >
            {visibleItems.map((item) => {
              const isActive = isPathActive(location.pathname, item.href);
              const isSearch = item.href === "#search";

              return (
                <Link
                  to={item.href}
                  onClick={(e) => {
                    if (isSearch) {
                      e.preventDefault();
                      triggerHaptic();
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
                    } else {
                      handleNavigation(item.href, isActive);
                    }
                  }}
                  aria-label={item.title}
                  className="text-foreground relative z-10 flex h-14 w-full items-center justify-center rounded-full transition-colors"
                  key={item.href}
                  aria-current={isActive ? "page" : undefined}
                >
                  {isActive && (
                    <motion.div
                      layoutId={`mobile-nav-indicator-${uniqueId}`}
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

            {hasMenu && (
              <DropdownMenu open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <button
                    onClick={triggerHaptic}
                    aria-label={t("navigation.moreOptions")}
                    className="text-foreground relative z-10 flex h-14 w-full items-center justify-center rounded-full transition-colors"
                  >
                    {(menuItems.some((item) => isPathActive(location.pathname, item.href)) ||
                      addonItems.some((item) => isPathActive(location.pathname, item.href))) && (
                      <motion.div
                        layoutId={`mobile-nav-indicator-${uniqueId}`}
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
                  className="w-42 mb-0 mr-0 flex flex-col gap-1 border-0 bg-transparent p-0 shadow-none ring-0 ring-offset-0"
                >
                  {menuItems.map((item) => {
                    const isActive = isPathActive(location.pathname, item.href);
                    return (
                      <LiquidGlass key={item.href} variant="floating" intensity="subtle">
                        <Link
                          to={item.href}
                          onClick={() => {
                            handleNavigation(item.href, isActive);
                            setMobileMenuOpen(false);
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

                  {/* Connect with status icon */}
                  <LiquidGlass variant="floating" intensity="subtle">
                    <Link
                      to="/connect"
                      onClick={() => {
                        const isActive = isPathActive(location.pathname, "/connect");
                        handleNavigation("/connect", isActive);
                        setMobileMenuOpen(false);
                      }}
                      aria-current={
                        isPathActive(location.pathname, "/connect") ? "page" : undefined
                      }
                      className="relative z-10 flex w-full items-center gap-3 rounded-full px-3 py-2 text-sm"
                    >
                      <span className="flex size-6 shrink-0 items-center justify-center">
                        <SyncStatusIcon status={syncStatus} className="size-5" />
                      </span>
                      <span className="truncate text-left">{t("navigation.connect")}</span>
                    </Link>
                  </LiquidGlass>

                  {hasAddons && (
                    <LiquidGlass variant="floating" intensity="subtle">
                      <button
                        onClick={() => {
                          triggerHaptic();
                          setMobileMenuOpen(false);
                          setAddonsSheetOpen(true);
                        }}
                        className="relative z-10 flex w-full items-center gap-3 rounded-full px-3 py-2 text-sm"
                      >
                        <span className="flex size-6 shrink-0 items-center justify-center">
                          <Icons.Addons className="size-5" />
                        </span>
                        <span className="truncate text-left">{t("navigation.addons")}</span>
                      </button>
                    </LiquidGlass>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </nav>
        </LiquidGlass>
      </div>

      {/* Add-ons Sheet */}
      <Sheet open={addonsSheetOpen} onOpenChange={setAddonsSheetOpen}>
        <SheetContent side="bottom" className="px-4 pb-8">
          <SheetHeader>
            <SheetTitle>{t("navigation.addons")}</SheetTitle>
          </SheetHeader>
          <div className="mt-4 flex flex-col gap-2">
            {addonItems.map((item) => {
              const isActive = isPathActive(location.pathname, item.href);
              return (
                <Link
                  key={item.href}
                  to={item.href}
                  onClick={() => {
                    handleNavigation(item.href, isActive);
                    setAddonsSheetOpen(false);
                  }}
                  className={cn(
                    "flex h-12 items-center gap-3 rounded-lg px-4 transition-colors",
                    isActive ? "bg-secondary" : "hover:bg-secondary/50",
                  )}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center">
                    {renderIcon(item.icon)}
                  </span>
                  <span className="text-base font-medium">{item.title}</span>
                </Link>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
