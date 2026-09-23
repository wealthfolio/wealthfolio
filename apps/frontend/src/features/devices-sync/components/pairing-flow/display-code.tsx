// DisplayCode
// Shows the pairing code for the issuer device
// =============================================

import { cn } from "@/lib/utils";
import { Icons, Skeleton } from "@wealthfolio/ui";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { AnimatePresence, motion } from "motion/react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FlowScreen, PairingCodeText } from "../flow-layout";

/** Fills the hero area with its padding (112 + 2 × 8 = 128px). */
const QR_SIZE = 112;
/** The countdown turns to a warning colour for the final minute. */
const EXPIRY_WARNING_SECONDS = 60;

interface DisplayCodeProps {
  title: string;
  description: string;
  /** `null` while the code is being generated. */
  code: string | null;
  expiresAt: Date | null;
  onCancel: () => void;
  /** Replaces an expired code with a new one. */
  onRenew: () => void;
}

function useSecondsLeft(expiresAt: Date | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);
  if (!expiresAt) return null;
  return Math.max(0, Math.floor((expiresAt.getTime() - now) / 1000));
}

export function DisplayCode({
  title,
  description,
  code,
  expiresAt,
  onCancel,
  onRenew,
}: DisplayCodeProps) {
  const { t } = useTranslation();
  const secondsLeft = useSecondsLeft(expiresAt);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
    },
    [],
  );

  if (code && secondsLeft === 0) {
    return (
      <FlowScreen
        tone="neutral"
        icon={<Icons.Clock className="size-8" aria-hidden />}
        title={t("sync:displayCode.expiredTitle")}
        description={t("sync:displayCode.expiredDescription")}
        actions={
          <>
            <Button className="w-full" onClick={onRenew}>
              {t("sync:displayCode.newCode")}
            </Button>
            <Button variant="ghost" className="w-full" onClick={onCancel}>
              {t("common:cancel")}
            </Button>
          </>
        }
      />
    );
  }

  const handleCopy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return; // Clipboard access denied; the code stays readable on screen.
    }
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1800);
  };

  const minutes = Math.floor((secondsLeft ?? 0) / 60);
  const seconds = ((secondsLeft ?? 0) % 60).toString().padStart(2, "0");
  const expiringSoon = secondsLeft !== null && secondsLeft <= EXPIRY_WARNING_SECONDS;

  return (
    <FlowScreen
      title={title}
      description={description}
      visual={
        <div className="rounded-2xl bg-white p-2 shadow-sm ring-1 ring-black/5">
          {/* The QR fades in over its placeholder, so generation has no layout shift. */}
          {code ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.25 }}
            >
              <QRCodeSVG value={code} size={QR_SIZE} level="M" marginSize={0} />
            </motion.div>
          ) : (
            <Skeleton
              className="rounded-lg"
              style={{ width: QR_SIZE, height: QR_SIZE }}
              aria-label={t("sync:displayCode.generating")}
            />
          )}
        </div>
      }
      actions={
        <Button variant="ghost" className="w-full" onClick={onCancel}>
          {t("common:cancel")}
        </Button>
      }
    >
      <div className="flex flex-col items-center gap-2">
        {code ? (
          <button
            type="button"
            onClick={handleCopy}
            aria-label={t("sync:displayCode.copyCode")}
            className="hover:bg-muted focus-visible:ring-ring group flex h-11 items-center gap-2.5 rounded-full px-4 transition-colors focus-visible:outline-none focus-visible:ring-2 active:scale-[0.97]"
          >
            <PairingCodeText code={code} className="text-xl" />
            <span className="text-muted-foreground group-hover:text-foreground relative size-4 transition-colors">
              <AnimatePresence initial={false} mode="popLayout">
                <motion.span
                  key={copied ? "copied" : "copy"}
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={{ duration: 0.15 }}
                  className="absolute inset-0"
                >
                  {copied ? (
                    <Icons.Check className="text-success size-4" aria-hidden />
                  ) : (
                    <Icons.Copy className="size-4" aria-hidden />
                  )}
                </motion.span>
              </AnimatePresence>
            </span>
          </button>
        ) : (
          <Skeleton className="h-11 w-40 rounded-full" />
        )}

        <p
          className={cn(
            "h-4 text-xs tabular-nums transition-colors duration-300",
            copied ? "text-success" : expiringSoon ? "text-warning" : "text-muted-foreground",
          )}
        >
          {copied
            ? t("sync:displayCode.copied")
            : code && secondsLeft !== null
              ? t("sync:displayCode.expiresIn", { time: `${minutes}:${seconds}` })
              : null}
        </p>
        {/* Only the copy confirmation is announced, not the ticking countdown. */}
        <span className="sr-only" aria-live="polite">
          {copied ? t("sync:displayCode.copied") : ""}
        </span>
      </div>
    </FlowScreen>
  );
}
