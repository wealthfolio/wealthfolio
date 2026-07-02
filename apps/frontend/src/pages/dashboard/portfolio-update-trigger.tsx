import { ReactNode } from "react";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@wealthfolio/ui/components/ui/hover-card";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import {
  useUpdatePortfolioMutation,
  useRecalculatePortfolioMutation,
} from "@/hooks/use-calculate-portfolio";
import { useI18n } from "@/i18n/i18n-provider";
import { translateUiText } from "@/i18n/ui-text";
import { formatDateTime } from "@/lib/utils";

// Rename interface
interface PortfolioUpdateTriggerProps {
  lastCalculatedAt: string | undefined;
  children: ReactNode;
  /** Informational notes about the displayed return (e.g. why TWR is unavailable for this scope). */
  notices?: string[];
}

function isLikelyEnglishSentence(text: string) {
  return /[A-Za-z]{3,}/.test(text);
}

function localizeNotice(language: "en" | "zh-CN", notice: string) {
  const translated = translateUiText(language, notice);
  if (language === "zh-CN" && translated === notice && isLikelyEnglishSentence(notice)) {
    return "部分绩效数据暂不可用。";
  }
  return translated;
}

// Rename function
export function PortfolioUpdateTrigger({
  lastCalculatedAt,
  children,
  notices = [],
}: PortfolioUpdateTriggerProps) {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
  // Instantiate the mutation hooks inside the component
  const updatePortfolioMutation = useUpdatePortfolioMutation();
  const recalculatePortfolioMutation = useRecalculatePortfolioMutation();
  const formattedLastCalculatedAt = lastCalculatedAt ? formatDateTime(lastCalculatedAt) : null;

  // Define handlers internally
  const handleUpdate = () => {
    updatePortfolioMutation.mutate();
  };

  const handleRecalculate = () => {
    recalculatePortfolioMutation.mutate();
  };

  return (
    <HoverCard>
      <HoverCardTrigger className="inline-flex cursor-pointer items-center">
        {children}
      </HoverCardTrigger>
      <HoverCardContent align="start" className="w-80 shadow-none">
        <div className="flex flex-col space-y-4">
          {notices.length > 0 && (
            <div className="flex gap-2.5 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3">
              <Icons.AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
              <div className="space-y-1.5">
                {notices.map((notice) => (
                  <p key={notice} className="text-foreground/80 text-xs font-light leading-relaxed">
                    {localizeNotice(language, notice)}
                  </p>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-2">
            <h4 className="flex text-sm font-light">
              <Icons.Calendar className="mr-2 h-4 w-4" />
              {isChinese ? "截至：" : "As of:"}{" "}
              <Badge className="ml-1 font-medium" variant="secondary">
                {/* Use lastCalculatedAt prop */}
                {formattedLastCalculatedAt
                  ? `${formattedLastCalculatedAt.date} ${formattedLastCalculatedAt.time}`
                  : "-"}
              </Badge>
            </h4>
          </div>
          <Button
            onClick={handleUpdate} // Use internal handler
            variant="outline"
            size="sm"
            className="rounded-full"
            disabled={updatePortfolioMutation.isPending} // Use internal mutation state
          >
            {updatePortfolioMutation.isPending ? (
              <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Icons.Refresh className="mr-2 h-4 w-4" />
            )}
            {updatePortfolioMutation.isPending
              ? isChinese
                ? "正在更新报价..."
                : "Updating quotes..."
              : isChinese
                ? "更新报价"
                : "Update quotes"}
          </Button>
          <Button
            onClick={handleRecalculate}
            variant="outline"
            size="sm"
            className="rounded-full"
            disabled={recalculatePortfolioMutation.isPending}
          >
            {recalculatePortfolioMutation.isPending ? (
              <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Icons.Clock className="mr-2 h-4 w-4" />
            )}
            {recalculatePortfolioMutation.isPending
              ? isChinese
                ? "正在重建历史..."
                : "Rebuilding history..."
              : isChinese
                ? "重建完整历史"
                : "Rebuild full history"}
          </Button>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}
