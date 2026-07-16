import type { FC } from "react";
import { useTranslation } from "react-i18next";
import { Badge, Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { cn } from "@/lib/utils";
import { useChatModelContext } from "../hooks/use-chat-model-context";

/**
 * Badge toggle for enabling/disabling thinking mode.
 * Only visible when the current model supports thinking.
 */
export const ThinkingToggle: FC = () => {
  const { t } = useTranslation();
  const { supportsThinking, thinkingEnabled, toggleThinking } = useChatModelContext();

  // Don't render if model doesn't support thinking
  if (!supportsThinking) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant={thinkingEnabled ? "default" : "outline"}
          className={cn(
            "h-5 cursor-pointer select-none gap-1 px-1.5 text-[10px] font-normal transition-colors",
            thinkingEnabled
              ? "bg-primary/90 hover:bg-primary"
              : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
          onClick={toggleThinking}
          role="switch"
          aria-checked={thinkingEnabled}
          aria-label={thinkingEnabled ? t("ai:thinking.disable") : t("ai:thinking.enable")}
        >
          <Icons.Brain className="size-3" />
          <span>{t("ai:thinking.label")}</span>
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {thinkingEnabled ? t("ai:thinking.clickToDisable") : t("ai:thinking.clickToEnable")}
      </TooltipContent>
    </Tooltip>
  );
};
