import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { ListCategorizationContextArgs, ListCategorizationContextOutput } from "../../types";
import { Spinner } from "@wealthfolio/ui";
import { unwrapSpendingResult } from "./spending-result-utils";

type Props = ToolCallMessagePartProps<
  ListCategorizationContextArgs,
  ListCategorizationContextOutput
>;

export function ListCategorizationContextContentImpl({ result, status }: Props) {
  const { t } = useTranslation();
  const isLoading = status?.type === "running";
  if (isLoading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
        <Spinner className="h-3 w-3" />
        <span>{t("ai:categorizationContext.loading")}</span>
      </div>
    );
  }
  const summary = unwrapSpendingResult<ListCategorizationContextOutput>(result)?.summary;
  if (!summary) return null;

  const { total, deterministicallyProposed, needsAiJudgement } = summary;
  return (
    <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
      <Icons.Sparkles className="h-3 w-3" />
      <span>
        {t("ai:categorizationContext.loaded", {
          total,
          deterministic: deterministicallyProposed,
          needsAi: needsAiJudgement,
        })}
      </span>
    </div>
  );
}

const ListCategorizationContextContent = memo(ListCategorizationContextContentImpl);

export const ListCategorizationContextToolUI = makeAssistantToolUI<
  ListCategorizationContextArgs,
  ListCategorizationContextOutput
>({
  toolName: "list_categorization_context",
  render: (props) => <ListCategorizationContextContent {...props} />,
});
