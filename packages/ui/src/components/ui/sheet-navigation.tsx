"use client";

import { useRender } from "@base-ui/react/use-render";
import * as React from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/utils";
import { Icons } from "./icons";

interface SheetNavigationContextValue {
  layer: HTMLElement | null;
  register: () => () => void;
}

const SheetNavigationContext = React.createContext<SheetNavigationContextValue | null>(null);

/** How tall a screen opened from a short sheet gets, so its list has room. */
const SCREEN_MIN_HEIGHT = "min(36rem, 85dvh)";

/**
 * Lets a field's picker open as a screen inside the same sheet, with a back
 * button, instead of a second sheet on top. SheetContent provides it on phones.
 * The content stays mounted underneath, so what was typed is kept, and is inert
 * while a screen shows. Pickers outside one keep their own sheet or popover.
 * With `enabled` false it renders its children alone.
 */
function SheetNavigation({ children, enabled = true }: { children: React.ReactNode; enabled?: boolean }) {
  const [layer, setLayer] = React.useState<HTMLDivElement | null>(null);
  const [openScreens, setOpenScreens] = React.useState(0);
  const register = React.useCallback(() => {
    setOpenScreens((count) => count + 1);
    return () => setOpenScreens((count) => count - 1);
  }, []);
  const value = React.useMemo(() => ({ layer, register }), [layer, register]);
  const screenShown = openScreens > 0;

  // No wrapper element, so the sheet's own child styles still apply; the content
  // beside the layer is made inert here instead. A sheet that scrolls as a whole
  // holds still while a screen covers what is visible of it.
  React.useLayoutEffect(() => {
    const container = layer?.parentElement;
    if (!screenShown || !layer || !container) return;
    const content = Array.from(container.children).filter(
      (element) => element !== layer && !element.hasAttribute("inert"),
    );
    content.forEach((element) => element.setAttribute("inert", ""));
    const { overflowY, minHeight } = container.style;
    // Never taller than the space the sheet has: an open keyboard shrinks it, and a
    // minimum above that would push the screen's header and search off the top.
    container.style.minHeight = `min(${SCREEN_MIN_HEIGHT}, 100%)`;
    container.style.overflowY = "hidden";
    const measure = () => {
      layer.style.setProperty("--sheet-screen-top", `${container.scrollTop}px`);
      layer.style.setProperty("--sheet-screen-height", `${container.clientHeight}px`);
    };
    measure();
    // The keyboard resizes the sheet while a screen shows; the screen follows it.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(container);
    return () => {
      observer?.disconnect();
      content.forEach((element) => element.removeAttribute("inert"));
      container.style.overflowY = overflowY;
      container.style.minHeight = minHeight;
      layer.style.removeProperty("--sheet-screen-top");
      layer.style.removeProperty("--sheet-screen-height");
    };
  }, [layer, screenShown]);

  if (!enabled) return children;

  return (
    <SheetNavigationContext.Provider value={value}>
      {children}
      <div ref={setLayer} data-slot="sheet-navigation-layer" className="contents" />
    </SheetNavigationContext.Provider>
  );
}

/** Whether this component is inside a SheetNavigation, where pickers open as screens. */
function useInSheetNavigation() {
  return React.useContext(SheetNavigationContext) !== null;
}

interface SheetScreenProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** What to focus on open; the screen itself by default, so touch opens no keyboard. */
  initialFocus?: React.RefObject<HTMLElement | null>;
}

/**
 * A screen pushed over the sheet's content. Back, Escape and Android Back (which
 * the app sends as Escape) return to the content and focus what opened it.
 */
function SheetScreen({ open, onOpenChange, title, children, className, initialFocus }: SheetScreenProps) {
  const navigation = React.useContext(SheetNavigationContext);
  const { t } = useTranslation();
  const titleId = React.useId();
  const screenRef = React.useRef<HTMLDivElement>(null);

  React.useLayoutEffect(() => {
    if (!open || !navigation) return;
    const opener = document.activeElement;
    const unregister = navigation.register();
    // A list's keys (arrows, Enter) are handled on its command root, so a screen with
    // one focuses it rather than itself; neither opens the keyboard on touch.
    const commandRoot = screenRef.current?.querySelector<HTMLElement>("[cmdk-root]");
    // A screen opened from another screen covers it; the covered one leaves the tab
    // order and the accessibility tree until this one closes.
    const self = screenRef.current;
    const covered = Array.from(self?.parentElement?.children ?? []).filter(
      (element) => element !== self && element.hasAttribute("data-sheet-screen") && !element.hasAttribute("inert"),
    );
    covered.forEach((element) => element.setAttribute("inert", ""));
    (initialFocus?.current ?? commandRoot ?? screenRef.current)?.focus({ preventScroll: true });
    return () => {
      covered.forEach((element) => element.removeAttribute("inert"));
      unregister();
      // The content is inert until the count above re-renders. Focus goes back to the
      // opener only if it was lost with the screen: a choice may have moved it on.
      requestAnimationFrame(() => {
        const active = document.activeElement;
        const focusLost = !active || active === document.body || !active.isConnected;
        if (focusLost && opener instanceof HTMLElement && opener.isConnected) {
          opener.focus({ preventScroll: true });
        }
      });
    };
  }, [open, navigation, initialFocus]);

  if (!open || !navigation?.layer) return null;

  return createPortal(
    <div
      ref={screenRef}
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      data-sheet-screen=""
      className={cn(
        "bg-(--sheet-bg) animate-in slide-in-from-end motion-reduce:animate-none absolute inset-x-0 top-[var(--sheet-screen-top,0px)] z-10 flex h-[var(--sheet-screen-height,100%)] flex-col outline-none duration-200",
        // List rows get a full touch target. A command list highlights its first row
        // for the keyboard; on touch that reads as already chosen, so rows only
        // highlight while pressed and the check mark shows the choice.
        "[&_[data-slot=command-item]]:min-h-12 [&_[data-slot=command-item]]:gap-3 [&_[data-slot=command-item]]:text-base",
        // Icon tiles and check marks grow with the text.
        "[&_[data-slot=icon-tile]]:size-8 [&_[data-slot=icon-tile]]:rounded-lg [&_[data-slot=icon-tile]_svg]:size-4 [&_[data-slot=command-item-check]]:size-4",
        "pointer-coarse:[&_[data-slot=command-item][data-selected=true]]:bg-transparent pointer-coarse:[&_[data-slot=command-item][data-selected]:active]:bg-accent",
        className,
      )}
      onKeyDown={(event) => {
        // Stops the sheet's own Escape handling, which listens on the document.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onOpenChange(false);
      }}
    >
      <div className="grid shrink-0 grid-cols-[2.75rem_minmax(0,1fr)_2.75rem] items-center gap-2 border-b px-3 py-3">
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="hover:bg-muted focus-visible:outline-ring flex size-11 items-center justify-center rounded-full transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid"
        >
          <Icons.ChevronLeft className="size-5 rtl:rotate-180" aria-hidden="true" />
          <span className="sr-only">{t("ui:sheet.back", "Back")}</span>
        </button>
        <h2 id={titleId} className="text-foreground truncate text-center text-lg font-semibold">
          {title}
        </h2>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </div>,
    navigation.layer,
  );
}

interface SheetScreenTriggerProps {
  render: React.ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Makes a field's trigger open its SheetScreen. */
function SheetScreenTrigger({ render, open, onOpenChange }: SheetScreenTriggerProps) {
  return useRender({
    render,
    props: {
      onClick: () => onOpenChange(true),
      "aria-haspopup": "dialog",
      "aria-expanded": open,
    },
  });
}

export { SheetNavigation, SheetScreen, SheetScreenTrigger, useInSheetNavigation };
