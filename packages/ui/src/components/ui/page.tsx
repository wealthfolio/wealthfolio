import * as React from "react";

import { cn } from "../../lib/utils";
import { Button } from "./button";
import { Icons } from "./icons";

interface PageContextValue {
  scrollY: number;
  isScrolled: boolean;
}

const PageContext = React.createContext<PageContextValue>({
  scrollY: 0,
  isScrolled: false,
});

export const usePage = () => React.useContext(PageContext);

interface PageScrollContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  withMobileNavOffset?: boolean;
}

const MOBILE_NAV_SCROLL_OFFSET = "var(--mobile-nav-total-offset)";

export const PageScrollContainer = React.forwardRef<HTMLDivElement, PageScrollContainerProps>(
  function PageScrollContainer({ className, children, withMobileNavOffset = false, style, ...props }, ref) {
    const computedStyle = withMobileNavOffset
      ? {
          scrollPaddingBottom: MOBILE_NAV_SCROLL_OFFSET,
          ...style,
        }
      : style;

    return (
      <div
        ref={ref}
        data-page-scroll-container
        data-with-mobile-nav-offset={withMobileNavOffset ? "true" : undefined}
        className={cn(
          // `relative` stops WebKitGTK painting the sticky page header over this scrollbar
          "momentum-scroll scroll-pt-header relative min-h-0 w-full max-w-full flex-1 overflow-y-auto overflow-x-hidden",
          withMobileNavOffset && "scroll-pb-nav",
          className,
        )}
        style={computedStyle}
        {...props}
      >
        {children}
      </div>
    );
  },
);

PageScrollContainer.displayName = "PageScrollContainer";

interface PageProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  containerMode?: boolean;
}

export function Page({ children, className, containerMode = false, ...props }: PageProps) {
  const [scrollY, setScrollY] = React.useState(0);
  const [isScrolled, setIsScrolled] = React.useState(false);
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    // Always look for the parent scroll container marked with data-page-scroll-container
    const container = scrollContainerRef.current?.closest("[data-page-scroll-container]");

    if (!container) return;

    const handleScroll = () => {
      const currentScrollY = container.scrollTop;
      setScrollY(currentScrollY);
      setIsScrolled(currentScrollY > 10);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [containerMode]);

  if (containerMode) {
    return (
      <PageContext.Provider value={{ scrollY, isScrolled }}>
        <div ref={scrollContainerRef} className={cn("relative w-full", "bg-background", className)} {...props}>
          {children}
        </div>
      </PageContext.Provider>
    );
  }

  return (
    <PageContext.Provider value={{ scrollY, isScrolled }}>
      <div ref={scrollContainerRef} className={cn("relative w-full", "bg-background", className)} {...props}>
        {children}
      </div>
    </PageContext.Provider>
  );
}

interface PageHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  heading?: string;
  headingPrefix?: string;
  text?: string;
  onBack?: () => void;
  showBorderOnScroll?: boolean;
  actions?: React.ReactNode;
  dragRegion?: boolean;
}

export function PageHeader({
  children,
  heading,
  headingPrefix,
  text,
  onBack,
  className,
  showBorderOnScroll = true,
  actions,
  dragRegion = true,
  ...props
}: PageHeaderProps) {
  const { isScrolled } = usePage();

  const titleContent = heading ? (
    <div data-tauri-drag-region={dragRegion ? "true" : undefined} className="flex min-w-0 items-center gap-3">
      {headingPrefix && (
        <>
          <h1 className="text-muted-foreground truncate text-lg font-semibold md:text-xl">{headingPrefix}</h1>
          <div className="bg-border h-5 w-px md:h-6" />
        </>
      )}
      <div className="flex min-w-0 flex-col">
        <h1 className="truncate text-lg font-semibold md:text-xl">{heading}</h1>
        {text && <p className="text-muted-foreground truncate text-sm md:text-base">{text}</p>}
      </div>
    </div>
  ) : null;

  return (
    <header
      className={cn(
        "sticky top-0 z-50",
        // Native app feel with backdrop blur
        "bg-background/80 supports-[backdrop-filter]:bg-background/60 backdrop-blur-xl",
        // Smooth transitions
        "transition-all duration-300 ease-out",
        // Border animation on scroll
        showBorderOnScroll && ["border-b", isScrolled ? "border-border shadow-sm" : "border-transparent shadow-none"],
        "pt-safe md:pt-2",
        className,
      )}
      {...props}
    >
      {dragRegion && (
        <div data-tauri-drag-region="true" className="pointer-events-auto absolute inset-x-0 top-0 h-6 opacity-0" />
      )}

      <div className="p-4">
        <div className="mx-auto">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              {onBack && (
                <Button variant="ghost" size="icon" onClick={onBack}>
                  <Icons.ArrowLeft className="size-5" />
                </Button>
              )}
              {titleContent ?? children}
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </div>
        </div>
      </div>
    </header>
  );
}

interface PageContentProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  withPadding?: boolean;
  containerMode?: boolean;
}

export function PageContent({
  children,
  className,
  withPadding = true,
  containerMode = false,
  ...props
}: PageContentProps) {
  return (
    <div
      data-ptr-content
      data-page-content="true"
      className={cn(
        withPadding && "px-2 py-2 md:px-4 md:py-2",
        // In containerMode, the scroll container handles bottom padding for mobile nav
        // In standalone mode, add extra bottom padding on desktop
        !containerMode && "pb-safe md:pb-6 lg:pb-8",
        "min-h-[calc(100vh-4rem)] md:min-h-[calc(100vh-5rem)]",
        className,
      )}
      {...props}
    >
      <div className="mx-auto space-y-6">{children}</div>
    </div>
  );
}
