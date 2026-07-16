import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { memo } from "react";
import { useTranslation } from "react-i18next";
import type { ListCategorizationContextArgs, ListCategorizationContextOutput } from "../../types";

type Props = ToolCallMessagePartProps<
  ListCategorizationContextArgs,
  ListCategorizationContextOutput
>;

function ListCategorizationContextContentImpl({ result, status }: Props) {
  const { t } = useTranslation();
  const isLoading = status?.type === "running";
  if (isLoading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 px-1 text-xs">
        <Icons.Spinner className="h-3 w-3 animate-spin" />
        <span>{t("ai:categorizationContext.loading")}</span>
      </div>
    );
  }
  if (!result) return null;

  const { total, deterministicallyProposed, needsAiJudgement } = result.summary;
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
