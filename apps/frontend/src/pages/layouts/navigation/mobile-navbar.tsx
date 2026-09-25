import { LiquidGlass } from "@/components/liquid-glass";
import { ProfileAvatar } from "@/features/profiles/profile-avatar";
import { useProfile } from "@/features/profiles/profile-context";
import { MobileProfileMenu } from "@/features/profiles/mobile-profile-menu";
import { SyncStatusIcon } from "@/features/wealthfolio-connect/components/sync-status-icon";
import { useAggregatedSyncStatus } from "@/features/wealthfolio-connect/hooks";
import { useHapticFeedback } from "@/hooks/use-haptic-feedback";
import { cn } from "@/lib/utils";
import { Icons, Sheet, SheetContent, SheetTitle } from "@wealthfolio/ui";
import { motion } from "motion/react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { type NavLink, type NavigationProps, isPathActive } from "./app-navigation";
import { resolveNavigationIcon } from "./navigation-icons";

interface MobileNavBarProps {
  navigation: NavigationProps;
}

export function MobileNavBar({ navigation }: MobileNavBarProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [profileView, setProfileView] = useState(false);
  const [isLandscape, setIsLandscape] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(orientation: landscape)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(orientation: landscape)");
    const onOrientationChange = () => setIsLandscape(query.matches);
    onOrientationChange();
    query.addEventListener("change", onOrientationChange);
    return () => query.removeEventListener("change", onOrientationChange);
  }, []);

  const profileContext = useProfile();
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const profileButtonRef = useRef<HTMLButtonElement>(null);
  const showProfileView = (show: boolean) => {
    setProfileView(show);
    requestAnimationFrame(() => {
      (show ? backButtonRef : profileButtonRef).current?.focus();
    });
  };
  const closeMenu = () => setMobileMenuOpen(false);
  const { triggerHaptic } = useHapticFeedback();
  const uniqueId = useId();
  const { status: syncStatus } = useAggregatedSyncStatus();

  const containerClassName = "pointer-events-none fixed inset-x-0 bottom-0 z-50";
  const buttonClassName =
    "text-foreground relative z-10 flex h-14 w-full items-center justify-center rounded-full transition-colors landscape:size-11";

  const handleNavigation = useCallback(
    (href: string, isActive: boolean) => {
      if (isActive) return;
      triggerHaptic();
      navigate(href);
    },
    [triggerHaptic, navigate],
  );

  const renderIcon = useCallback((icon?: ReactNode) => resolveNavigationIcon(icon, "size-6"), []);

  const primaryItems = navigation?.primary ?? [];
  const secondaryItems = navigation?.secondary ?? [];
  const pinnedAddonItems = navigation?.pinnedAddons ?? [];
  const addonMenuItems = navigation?.addonMenuItems ?? navigation?.addons ?? [];
  const directPinnedAddonItems = pinnedAddonItems.slice(0, 1);
  const overflowPinnedAddonItems = pinnedAddonItems.slice(1);

  const searchItem = {
    title: t("common:search"),
    href: "#search",
    icon: <Icons.Search2 className="size-6" />,
  };

  // Landscape has room to keep Holdings directly accessible alongside Dashboard and Insights.
  const visiblePrimaryCount = isLandscape ? 3 : 2;
  const visibleItems = [
    ...primaryItems.slice(0, visiblePrimaryCount),
    ...directPinnedAddonItems,
    searchItem,
  ].filter(Boolean);

  const addonItems = [...overflowPinnedAddonItems, ...addonMenuItems];
  const standardMenuItems: NavLink[] = [
    ...primaryItems.slice(visiblePrimaryCount),
    ...secondaryItems,
    {
      title: t("common:connect"),
      href: "/connect",
      icon: <SyncStatusIcon status={syncStatus} className="size-6" />,
    },
  ];
  const moreItems = [...standardMenuItems, ...addonItems];
  const hasMenu = moreItems.length > 0;

  return (
    <div className={containerClassName}>
      {/* Lift off bottom by the design gap while respecting safe area */}
      <div className="flex justify-center px-4 pb-[var(--mobile-nav-bottom-offset)]">
        <LiquidGlass
          variant="floating"
          intensity="subtle"
          className={cn(
            "pointer-events-auto w-full px-1 py-1 landscape:w-fit landscape:py-1.5",
            "h-[var(--mobile-nav-ui-height)]",
          )}
        >
          <nav
            aria-label={t("common:layout.primary_navigation")}
            className="grid auto-cols-fr grid-flow-col place-items-center gap-2 landscape:auto-cols-[2.75rem]"
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
                  className={buttonClassName}
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
              <button
                onClick={() => {
                  triggerHaptic();
                  setProfileView(false);
                  setMobileMenuOpen(true);
                }}
                aria-label={t("common:layout.more_options")}
                className={buttonClassName}
              >
                {moreItems.some((item) => isPathActive(location.pathname, item.href)) && (
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
            )}
          </nav>
        </LiquidGlass>
      </div>

      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="bg-background inset-x-4 bottom-4 flex max-h-[min(82dvh,720px)] flex-col gap-0 overflow-hidden rounded-[2rem] border-0 px-0 pb-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] pt-0 shadow-2xl"
        >
          <div className="bg-muted mx-auto mt-4 h-1.5 w-14 shrink-0 rounded-full" />
          <div className="flex shrink-0 items-center justify-between px-8 pb-4 pt-7">
            <div className="flex min-w-0 items-center gap-3">
              {profileView && (
                <button
                  ref={backButtonRef}
                  type="button"
                  onClick={() => showProfileView(false)}
                  className="hover:bg-muted flex size-11 shrink-0 items-center justify-center rounded-full"
                  aria-label={t("common:back")}
                >
                  <Icons.ArrowLeft className="size-5" />
                </button>
              )}
              <SheetTitle
                className={cn("truncate font-semibold", profileView ? "text-lg" : "text-2xl")}
              >
                {profileView ? t("common:profiles.yourProfile") : t("common:layout.more")}
              </SheetTitle>
            </div>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              className="bg-muted text-foreground hover:bg-muted/80 flex size-11 items-center justify-center rounded-full transition-colors"
              aria-label={t("common:layout.close_more_menu")}
            >
              <Icons.Close className="size-5" />
            </button>
          </div>

          <div className="scrollbar-hide min-h-0 overflow-y-auto px-8">
            {profileView ? (
              <MobileProfileMenu onAction={closeMenu} />
            ) : (
              <>
                {profileContext?.profile && (
                  <div className="border-border/70 border-b pb-3">
                    <button
                      ref={profileButtonRef}
                      type="button"
                      onClick={() => showProfileView(true)}
                      aria-label={t("common:profiles.menuLabel", {
                        name: profileContext.profile.name,
                      })}
                      className="hover:bg-muted flex min-h-14 w-full items-center gap-4 rounded-lg text-left"
                    >
                      <ProfileAvatar
                        id={profileContext.profile.avatarId}
                        className="mx-0 size-8 shrink-0 rounded-full"
                      />
                      <span className="min-w-0 flex-1 truncate font-semibold">
                        {profileContext.profile.name}
                      </span>
                      <Icons.ChevronRight className="text-muted-foreground size-5 shrink-0" />
                    </button>
                  </div>
                )}
                <div className="divide-border/70 divide-y">
                  {standardMenuItems.map((item) => {
                    const isActive = isPathActive(location.pathname, item.href);

                    return (
                      <Link
                        key={item.href}
                        to={item.href}
                        onClick={() => {
                          handleNavigation(item.href, isActive);
                          setMobileMenuOpen(false);
                        }}
                        aria-current={isActive ? "page" : undefined}
                        className={cn(
                          "group flex h-16 items-center gap-4 transition-colors",
                          isActive ? "text-primary" : "text-foreground",
                        )}
                      >
                        <span className="flex size-7 shrink-0 items-center justify-center">
                          {renderIcon(item.icon)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-lg font-semibold">
                          {item.title}
                        </span>
                        <Icons.ChevronRight className="text-muted-foreground/50 size-5 shrink-0 transition-transform group-hover:translate-x-0.5" />
                      </Link>
                    );
                  })}
                </div>

                {addonItems.length > 0 && (
                  <div className="pt-6">
                    <div className="text-muted-foreground pb-3 text-xs font-semibold uppercase tracking-[0.35em]">
                      {t("common:addons")}
                    </div>
                    <div className="divide-border/70 divide-y">
                      {addonItems.map((item) => {
                        const isActive = isPathActive(location.pathname, item.href);

                        return (
                          <Link
                            key={item.href}
                            to={item.href}
                            onClick={() => {
                              handleNavigation(item.href, isActive);
                              setMobileMenuOpen(false);
                            }}
                            aria-current={isActive ? "page" : undefined}
                            className={cn(
                              "group flex h-16 items-center gap-4 transition-colors",
                              isActive ? "text-primary" : "text-foreground",
                            )}
                          >
                            <span className="flex size-7 shrink-0 items-center justify-center">
                              {renderIcon(item.icon)}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-lg font-semibold">
                              {item.title}
                            </span>
                            <Icons.ChevronRight className="text-muted-foreground/50 size-5 shrink-0 transition-transform group-hover:translate-x-0.5" />
                          </Link>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
