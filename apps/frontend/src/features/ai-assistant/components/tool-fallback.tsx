import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { cn } from "@/lib/utils";

function hasResultMeta(
  result: unknown,
): result is { data: unknown; meta: Record<string, unknown> } {
  return (
    typeof result === "object" &&
    result !== null &&
    "data" in result &&
    "meta" in result &&
    typeof (result as { meta: unknown }).meta === "object"
  );
}

export const ToolFallback: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
}) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const isRunning = status?.type === "running";
  const isCancelled = status?.type === "incomplete" && status.reason === "cancelled";

  const resultData = hasResultMeta(result) ? result.data : result;

  return (
    <div className="py-0.5">
      {/* Compact one-liner */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "text-muted-foreground flex items-center gap-2 text-xs",
          "hover:text-foreground transition-colors",
          isCancelled && "line-through opacity-60",
        )}
      >
        {isRunning ? (
          <Icons.Spinner className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : isCancelled ? (
          <Icons.XCircle className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <Icons.Check className="text-success h-3.5 w-3.5 shrink-0" />
        )}
        <span>
          {isRunning
            ? t("ai:tools.calling", { toolName })
            : isCancelled
              ? t("ai:tools.cancelled", { toolName })
              : t("ai:tools.used", { toolName })}
        </span>
        <Icons.ChevronDown
          className={cn("h-3 w-3 shrink-0 transition-transform", expanded && "rotate-180")}
        />
      </button>

      {/* Expandable debug details */}
      {expanded && (
        <div className="text-muted-foreground ml-5.5 mt-1.5 space-y-1.5 text-xs">
          <pre className="bg-muted/50 max-h-40 overflow-auto whitespace-pre-wrap rounded p-2">
            {argsText}
          </pre>
          {!isCancelled && resultData !== undefined && (
            <pre className="bg-muted/50 max-h-40 overflow-auto whitespace-pre-wrap rounded p-2">
              {typeof resultData === "string" ? resultData : JSON.stringify(resultData, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};
