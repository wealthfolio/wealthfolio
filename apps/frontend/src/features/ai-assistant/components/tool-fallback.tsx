import {
  useAssistantState,
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { cn } from "@/lib/utils";
import { Spinner } from "@wealthfolio/ui";

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

/** A call that failed, was refused or was skipped: the server sends `{ error }`. */
function resultError(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || !("error" in result)) {
    return undefined;
  }
  const { error } = result as { error: unknown };
  return typeof error === "string" ? error : undefined;
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
  const error = isRunning || isCancelled ? undefined : resultError(result);
  const notUsed = isCancelled || error !== undefined;

  const resultData: unknown = hasResultMeta(result) ? result.data : (error ?? result);

  return (
    <div className="py-0.5">
      {/* Compact one-liner */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className={cn(
          "text-muted-foreground flex items-center gap-2 text-xs",
          "hover:text-foreground transition-colors",
          notUsed && "line-through opacity-60",
        )}
      >
        {isRunning ? (
          <Spinner className="h-3.5 w-3.5 shrink-0" />
        ) : notUsed ? (
          <Icons.XCircle className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <Icons.Check className="text-success h-3.5 w-3.5 shrink-0" />
        )}
        <span>
          {isRunning
            ? t("ai:tools.calling", { toolName })
            : isCancelled
              ? t("ai:tools.cancelled", { toolName })
              : error !== undefined
                ? t("ai:tools.notUsed", { toolName })
                : t("ai:tools.used", { toolName })}
        </span>
        <Icons.ChevronDown
          className={cn("h-3 w-3 shrink-0 transition-transform", expanded && "rotate-180")}
        />
      </button>

      {/* Expandable debug details */}
      {expanded && (
        <div className="text-muted-foreground ms-5.5 mt-1.5 space-y-1.5 text-xs">
          <pre className="bg-muted/50 max-h-40 overflow-auto rounded p-2 whitespace-pre-wrap">
            {argsText}
          </pre>
          {!isCancelled && resultData !== undefined && (
            <pre className="bg-muted/50 max-h-40 overflow-auto rounded p-2 whitespace-pre-wrap">
              {typeof resultData === "string" ? resultData : JSON.stringify(resultData, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

/** Tools whose own card explains a failed call. */
const TOOLS_SHOWING_THEIR_ERRORS = new Set(["import_csv"]);

/**
 * Renders each tool call with its registered card, or with `ToolFallback`.
 * A call that did not run has no data for its card, so it gets the fallback,
 * which says the tool was not used.
 */
export function ToolCallPart(props: ToolCallMessagePartProps) {
  const Card = useAssistantState(({ tools }) => tools.tools[props.toolName]?.[0]);
  const notRun =
    resultError(props.result) !== undefined && !TOOLS_SHOWING_THEIR_ERRORS.has(props.toolName);
  const Render = Card && !notRun ? Card : ToolFallback;
  return <Render {...props} />;
}
