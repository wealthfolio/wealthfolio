import { useRef, useState, type ComponentProps } from "react";

import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui";

/** Longest text the tooltip shows before it too is cut off. */
export const TRUNCATED_TEXT_TOOLTIP_MAX_CHARS = 300;

interface TruncatedTextProps extends Omit<ComponentProps<"span">, "children"> {
  text: string;
}

/**
 * Single-line text that truncates to its container. Only when it actually
 * overflows does hovering show the full text in a tooltip, itself capped so a
 * pathological note cannot fill the viewport.
 */
export function TruncatedText({ text, className, ...props }: TruncatedTextProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  return (
    <Tooltip
      open={open}
      onOpenChange={(next) => {
        const el = ref.current;
        setOpen(next && el !== null && el.scrollWidth > el.clientWidth);
      }}
    >
      <TooltipTrigger
        render={<span ref={ref} className={cn("block min-w-0 truncate", className)} {...props} />}
      >
        {text}
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="start"
        className="max-w-md whitespace-pre-wrap break-words"
      >
        {text.length > TRUNCATED_TEXT_TOOLTIP_MAX_CHARS
          ? `${text.slice(0, TRUNCATED_TEXT_TOOLTIP_MAX_CHARS)}…`
          : text}
      </TooltipContent>
    </Tooltip>
  );
}
