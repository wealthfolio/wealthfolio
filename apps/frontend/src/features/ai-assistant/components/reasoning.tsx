"use client";

import type { CSSProperties } from "react";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";

import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@wealthfolio/ui/components/ui/collapsible";

import { cn } from "@/lib/utils";
import {
  useAssistantState,
  useMessagePartReasoning,
  type ReasoningGroupComponent,
  type ReasoningMessagePartComponent,
} from "@assistant-ui/react";

const MS_IN_S = 1000;

/**
 * Motion-based shimmer text animation for streaming state.
 */
const Shimmer = memo(({ children, duration = 2 }: { children: string; duration?: number }) => {
  const spread = children.length * 2;
  return (
    <motion.p
      animate={{ backgroundPosition: "0% center" }}
      initial={{ backgroundPosition: "100% center" }}
      transition={{ duration, ease: "linear", repeat: Infinity }}
      className="relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent [background-repeat:no-repeat,padding-box]"
      style={
        {
          "--spread": `${spread}px`,
          backgroundImage:
            "linear-gradient(90deg, #0000 calc(50% - var(--spread)), var(--color-background), #0000 calc(50% + var(--spread))), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
        } as CSSProperties
      }
    >
      {children}
    </motion.p>
  );
});
Shimmer.displayName = "Shimmer";

/**
 * Renders a single reasoning part's text.
 * Consecutive reasoning parts are automatically grouped by ReasoningGroup.
 */
const ReasoningImpl: ReasoningMessagePartComponent = () => {
  const { text } = useMessagePartReasoning();
  return <p className="whitespace-pre-wrap">{text}</p>;
};

/**
 * Collapsible reasoning group using Radix Collapsible.
 * Collapsed by default; user can toggle open/closed manually.
 */
const ReasoningGroupImpl: ReasoningGroupComponent = ({ children, startIndex, endIndex }) => {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const startTimeRef = useRef<number | null>(null);

  const isStreaming = useAssistantState(({ message }) => {
    if (message.status?.type !== "running") return false;
    const lastIndex = message.parts.length - 1;
    if (lastIndex < 0) return false;
    const lastType = message.parts[lastIndex]?.type;
    if (lastType !== "reasoning") return false;
    return lastIndex >= startIndex && lastIndex <= endIndex;
  });

  // Track streaming start/end and compute duration
  useEffect(() => {
    if (isStreaming) {
      if (startTimeRef.current === null) {
        startTimeRef.current = Date.now();
      }
    } else if (startTimeRef.current !== null) {
      setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
      startTimeRef.current = null;
    }
  }, [isStreaming]);

  const thinkingMessage = useMemo(() => {
    if (isStreaming || duration === 0) {
      return <Shimmer duration={1}>{t("ai:reasoning.thinking")}</Shimmer>;
    }
    if (duration === undefined) {
      return <span>{t("ai:reasoning.thoughtFewSeconds")}</span>;
    }
    return <span>{t("ai:reasoning.thoughtForSeconds", { count: duration })}</span>;
  }, [isStreaming, duration, t]);

  return (
    <Collapsible className="not-prose mb-4" open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 text-sm transition-colors">
        <Icons.Brain className="size-4" />
        {thinkingMessage}
        <Icons.ChevronDown
          className={cn("size-4 transition-transform", isOpen ? "rotate-180" : "rotate-0")}
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "text-muted-foreground mt-4 text-sm outline-none",
          "data-[state=open]:animate-in data-[state=open]:slide-in-from-top-2",
          "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2",
        )}
      >
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
};

export const Reasoning = memo(ReasoningImpl);
Reasoning.displayName = "Reasoning";

export const ReasoningGroup = memo(ReasoningGroupImpl);
ReasoningGroup.displayName = "ReasoningGroup";
