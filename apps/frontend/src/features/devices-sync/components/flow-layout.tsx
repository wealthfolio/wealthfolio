// FlowLayout
// One template for every pairing and restore screen, in a frame of one size:
// a hero area of fixed height (QR code, device link or status badge), the
// title, the step's content, then the actions pinned to the bottom. Every
// step keeps the same skeleton, so nothing moves when the step changes.
// ==========================================================================

import { cn } from "@/lib/utils";
import { Icons } from "@wealthfolio/ui";
import { MotionConfig, motion } from "motion/react";
import type { ReactNode } from "react";

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

export type FlowTone = "primary" | "success" | "error" | "warning" | "neutral";

const TONE_CLASS: Record<FlowTone, string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success/10 text-success",
  error: "bg-destructive/10 text-destructive",
  warning: "bg-warning/10 text-warning",
  neutral: "bg-muted text-muted-foreground",
};

const HALO_CLASS: Record<FlowTone, string> = {
  primary: "bg-primary/10",
  success: "bg-success/10",
  error: "bg-destructive/10",
  warning: "bg-warning/10",
  neutral: "bg-muted",
};

interface BadgeProps {
  tone: FlowTone;
  /** A soft breathing halo while the step is working. */
  working?: boolean;
  children: ReactNode;
}

/** A large status badge; keyed changes replay a short scale-in. */
function Badge({ tone, working, children }: BadgeProps) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 380, damping: 26 }}
      className="relative flex size-20 items-center justify-center"
    >
      {working && (
        <motion.span
          aria-hidden
          className={cn("absolute inset-0 rounded-full", HALO_CLASS[tone])}
          animate={{ scale: [1, 1.45], opacity: [0.8, 0] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: "easeOut" }}
        />
      )}
      <span
        className={cn(
          "relative flex size-20 items-center justify-center rounded-full",
          TONE_CLASS[tone],
        )}
      >
        {children}
      </span>
    </motion.div>
  );
}

/** A check that draws itself once the badge has appeared. */
function DrawnCheck() {
  return (
    <svg viewBox="0 0 24 24" className="size-9" fill="none" aria-hidden>
      <motion.path
        d="M5 12.5l4.5 4.5L19 7.5"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.45, delay: 0.15, ease: EASE_OUT }}
      />
    </svg>
  );
}

/** The badge icon for a step that is working, succeeded or failed. */
export function FlowIcon({ kind }: { kind: "working" | "success" | "error" }) {
  switch (kind) {
    case "working":
      return <Icons.Spinner className="size-8 animate-spin" aria-hidden />;
    case "success":
      return <DrawnCheck />;
    case "error":
      return <Icons.AlertTriangle className="size-8" aria-hidden />;
  }
}

interface FlowScreenProps {
  title: ReactNode;
  description?: ReactNode;
  /** Status badge in the hero area. */
  icon?: ReactNode;
  /** An illustration in the hero area, in place of a badge. */
  visual?: ReactNode;
  tone?: FlowTone;
  /** The step is working; the badge breathes. */
  working?: boolean;
  /** Buttons, primary first; they stack full width at the bottom. */
  actions?: ReactNode;
  /** A quiet line at the bottom for steps that need nothing from the user. */
  footnote?: ReactNode;
  /** Announce title changes; for steps that update while the user waits. */
  live?: boolean;
  /** Changes when the screen's state changes, replaying its entrance. */
  stateKey?: string;
  children?: ReactNode;
  className?: string;
  "data-testid"?: string;
  "data-phase"?: string;
}

export function FlowScreen({
  title,
  description,
  icon,
  visual,
  tone = "primary",
  working,
  actions,
  footnote,
  live,
  stateKey,
  children,
  className,
  ...data
}: FlowScreenProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: EASE_OUT }}
      className={cn("flex min-w-0 flex-1 flex-col gap-6", className)}
      {...data}
    >
      <header className="flex flex-col items-center gap-5 text-center">
        {/* Fixed height, so the title sits at the same place on every step. */}
        <div className="flex h-32 w-full items-center justify-center">
          {visual ??
            (icon && (
              <Badge key={`badge-${stateKey}`} tone={tone} working={working}>
                {icon}
              </Badge>
            ))}
        </div>
        <motion.div
          key={`text-${stateKey}`}
          initial={stateKey ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2 }}
          className="flex flex-col gap-2"
          aria-live={live ? "polite" : undefined}
        >
          <h2 className="text-xl font-semibold leading-tight tracking-tight">{title}</h2>
          {description && (
            <p className="text-muted-foreground mx-auto max-w-[44ch] whitespace-pre-line break-words text-sm leading-relaxed">
              {description}
            </p>
          )}
        </motion.div>
      </header>
      {children}
      {/* Pinned to the bottom, in the same place on every step. */}
      {(actions || footnote) && (
        <div className="mt-auto flex flex-col gap-2">
          {actions}
          {footnote && (
            <p className="text-muted-foreground flex items-center justify-center gap-1.5 text-center text-xs">
              {footnote}
            </p>
          )}
        </div>
      )}
    </motion.div>
  );
}

/**
 * Hosts flow screens in the setup dialog at one size: a minimum height that
 * fits the largest step on desktop, the full sheet on phones (`fill`). Steps fill it,
 * so their actions line up at the bottom. Applies the user's reduced-motion
 * preference to everything inside.
 */
export function FlowFrame({ children, fill = false }: { children: ReactNode; fill?: boolean }) {
  return (
    <MotionConfig reducedMotion="user">
      {/* The negative margin keeps focus rings and the corner control unclipped. */}
      <div
        className={cn(
          "-m-2 flex flex-col",
          fill ? "min-h-0 flex-1 overflow-y-auto" : "min-h-[544px]",
        )}
      >
        <div className="flex flex-1 flex-col p-2">{children}</div>
      </div>
    </MotionConfig>
  );
}

/** A code both devices compare, split in two groups so it reads at a glance. */
export function PairingCodeText({ code, className }: { code: string; className?: string }) {
  const groups = code.length > 3 ? [code.slice(0, 3), code.slice(3)] : [code];
  return (
    <span className={cn("inline-flex gap-[0.6em] font-mono font-semibold", className)}>
      {groups.map((group, index) => (
        <span key={index} className="tracking-[0.2em]">
          {group}
        </span>
      ))}
    </span>
  );
}
