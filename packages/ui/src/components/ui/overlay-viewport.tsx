import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";

/** Less than this off the page's height is browser chrome, not a keyboard. */
const KEYBOARD_MIN_HEIGHT = 150;

interface OverlayViewportProps {
  children: ReactNode;
  /** Full-screen surfaces such as the camera own their system-bar clearance. */
  safeArea?: boolean;
}

/**
 * A containing block for fixed popups, including their slide/zoom animations.
 * Keep this outside the popup: consumer padding (including p-0), flex/grid
 * children and custom footers must not remove system-bar clearance.
 */
export function OverlayViewport({ children, safeArea = true }: OverlayViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const element = viewportRef.current;
    if (!safeArea || !viewport || !element) return;

    // WKWebView can leave the CSS layout viewport behind the keyboard, and
    // innerHeight can change during panning without resizing fixed containers.
    // Follow the visible window without changing the page or popup children.
    let frame: number | undefined;
    let wasKeyboardOpen = false;
    const update = () => {
      frame = undefined;
      element.style.setProperty("--overlay-visual-top", `${Math.max(0, viewport.offsetTop)}px`);
      element.style.setProperty(
        "--overlay-visual-bottom",
        `${Math.max(0, document.documentElement.clientHeight - viewport.height - viewport.offsetTop)}px`,
      );
      // An open keyboard covers the home indicator, so the safe area below it is not
      // reserved. WKWebView can shrink the page with the keyboard, which leaves the
      // visual offset above at 0; the shrunken height is what shows the keyboard.
      const keyboardOpen =
        Math.min(viewport.height, window.innerHeight) < document.documentElement.clientHeight - KEYBOARD_MIN_HEIGHT;
      if (keyboardOpen) element.style.setProperty("--overlay-safe-bottom", "0px");
      else element.style.removeProperty("--overlay-safe-bottom");
      // The keyboard shrinks the popup after focus moves, so the field just tapped can
      // end up under the keyboard until something is typed. Bring it back into view.
      const active = document.activeElement;
      if (keyboardOpen && !wasKeyboardOpen && active instanceof HTMLElement && element.contains(active)) {
        active.scrollIntoView({ block: "nearest" });
      }
      wasKeyboardOpen = keyboardOpen;
    };
    const schedule = () => {
      if (frame === undefined) frame = requestAnimationFrame(update);
    };
    update();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    return () => {
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [safeArea]);

  if (!safeArea) return children;

  return (
    <div
      ref={viewportRef}
      data-slot="overlay-viewport"
      // Not clipped: a bottom sheet reaches past the bottom into the home-indicator area.
      className="pointer-events-none fixed z-50"
      style={{
        top: "calc(var(--inset-top, env(safe-area-inset-top, 0px)) + var(--overlay-visual-top, 0px))",
        right: "var(--inset-right, env(safe-area-inset-right, 0px))",
        bottom:
          "max(var(--overlay-safe-bottom, var(--inset-bottom, env(safe-area-inset-bottom, 0px))), var(--keyboard-inset-bottom, 0px), var(--overlay-visual-bottom, 0px))",
        left: "var(--inset-left, env(safe-area-inset-left, 0px))",
        transform: "translateZ(0)",
        // The safe area below the overlay while no keyboard covers it, for a bottom
        // sheet to fill so the page does not show between it and the screen's edge.
        ["--sheet-safe-bottom" as string]:
          "var(--overlay-safe-bottom, var(--inset-bottom, env(safe-area-inset-bottom, 0px)))",
      }}
    >
      {children}
    </div>
  );
}

/** Cap a caller's preferred height to the overlay's usable containing block. */
function constrainHeight(style?: CSSProperties): CSSProperties {
  const maxHeight = style?.maxHeight;
  if (maxHeight === undefined) return style ?? {};
  const preferredHeight =
    typeof maxHeight === "number"
      ? `${maxHeight}px`
      : maxHeight && maxHeight !== "none"
        ? maxHeight
        : "var(--overlay-max-height, 100%)";
  return { ...style, maxHeight: `min(100%, ${preferredHeight})` };
}

/** Preserve Base UI state-dependent style callbacks as well as plain styles. */
export function overlayContentStyle<State>(
  style?: CSSProperties | ((state: State) => CSSProperties | undefined),
): CSSProperties | ((state: State) => CSSProperties) {
  return typeof style === "function" ? (state: State) => constrainHeight(style(state)) : constrainHeight(style);
}
