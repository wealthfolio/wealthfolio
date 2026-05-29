import { updateToolResult } from "@/adapters";
import { useCategorizationRuleMutations } from "@/features/spending/hooks/use-categorization-rules";
import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import { makeAssistantToolUI } from "@assistant-ui/react";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { memo, useEffect, useState } from "react";
import { useRuntimeContext } from "../../hooks/use-runtime-context";
import type { CreateCategorizationRuleArgs, CreateCategorizationRuleOutput } from "../../types";

type CreateCategorizationRuleToolUIContentProps = ToolCallMessagePartProps<
  CreateCategorizationRuleArgs,
  CreateCategorizationRuleOutput
>;

function formatMatchType(value?: string): string {
  return (value ?? "contains").replace(/_/g, " ");
}

function nextClientRuleId(): string | null {
  return globalThis.crypto?.randomUUID?.() ?? null;
}

function CreateCategorizationRuleLoadingState() {
  return (
    <Card className="bg-muted/40 border-primary/10 w-full overflow-hidden">
      <CardContent className="flex items-center gap-3 py-5">
        <div className="bg-primary/10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full">
          <Icons.Sparkles className="text-primary h-4 w-4 animate-pulse" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Drafting rule...</p>
        </div>
        <Icons.Spinner className="text-muted-foreground h-4 w-4 shrink-0 animate-spin" />
      </CardContent>
    </Card>
  );
}

function CreateCategorizationRuleLegacyState({
  result,
}: {
  result: CreateCategorizationRuleOutput;
}) {
  const title = result.ruleName ?? "Categorization rule";
  const message = result.message ?? "Rule created.";

  return (
    <Card className="bg-card w-full overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-sm">{title}</CardTitle>
            <p className="text-muted-foreground mt-1 text-xs">{message}</p>
          </div>
          <Badge variant="default" className="shrink-0">
            Created
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm sm:grid-cols-2">
        {result.pattern ? (
          <div>
            <div className="text-muted-foreground text-xs">Pattern</div>
            <div className="truncate font-medium">{result.pattern}</div>
          </div>
        ) : null}
        {result.matchType ? (
          <div>
            <div className="text-muted-foreground text-xs">Match</div>
            <div className="truncate font-medium">{formatMatchType(result.matchType)}</div>
          </div>
        ) : null}
        {result.categoryPath ? (
          <div>
            <div className="text-muted-foreground text-xs">Category</div>
            <div className="truncate font-medium">{result.categoryPath}</div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function CreateCategorizationRuleToolUIContentImpl({
  result,
  status,
  toolCallId,
}: CreateCategorizationRuleToolUIContentProps) {
  const runtime = useRuntimeContext();
  const threadId = runtime.currentThreadId;
  const { create } = useCategorizationRuleMutations();
  const [localSubmitted, setLocalSubmitted] = useState(false);
  const [persistError, setPersistError] = useState(false);
  const [createError, setCreateError] = useState(false);
  const [ruleIdOverride, setRuleIdOverride] = useState<string | null | undefined>(undefined);
  const resultRuleId = result?.rule?.id ?? null;

  useEffect(() => {
    setCreateError(false);
    setRuleIdOverride(undefined);
  }, [resultRuleId]);

  if (status?.type === "running") return <CreateCategorizationRuleLoadingState />;
  if (!result) return null;
  const rule = result.rule;
  if (!rule) return <CreateCategorizationRuleLegacyState result={result} />;

  const isSubmitted =
    localSubmitted || result.submitted === true || result.draftStatus === "created";
  const accountLabel = result.accountName ?? (rule.accountId ? "Scoped account" : "All accounts");
  const categoryPath = result.categoryPath ?? "Selected category";
  const message =
    result.message ?? `Drafted rule: anything matching "${rule.pattern}" will be ${categoryPath}.`;

  const handleCreate = async () => {
    setPersistError(false);
    setCreateError(false);

    let created: Awaited<ReturnType<typeof create.mutateAsync>>;
    try {
      const ruleToCreate = ruleIdOverride === undefined ? rule : { ...rule, id: ruleIdOverride };
      created = await create.mutateAsync(ruleToCreate);
    } catch (error) {
      setCreateError(true);
      setRuleIdOverride(nextClientRuleId());
      console.error("Failed to create categorization rule:", error);
      return;
    }

    setLocalSubmitted(true);

    if (!threadId || !toolCallId) {
      setPersistError(true);
      return;
    }

    try {
      await updateToolResult({
        threadId,
        toolCallId,
        resultPatch: {
          submitted: true,
          draftStatus: "created",
          ruleId: created.id,
          submittedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      setPersistError(true);
      console.error("Failed to update categorization rule tool result:", error);
    }
  };

  return (
    <Card className="bg-card w-full overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-sm">{rule.name}</CardTitle>
            <p className="text-muted-foreground mt-1 text-xs">{message}</p>
          </div>
          <Badge variant={isSubmitted ? "default" : "secondary"} className="shrink-0">
            {isSubmitted ? "Created" : "Draft"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <div>
            <div className="text-muted-foreground text-xs">Pattern</div>
            <div className="truncate font-medium">{rule.pattern}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Match</div>
            <div className="truncate font-medium">{formatMatchType(rule.matchType)}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Category</div>
            <div className="truncate font-medium">{categoryPath}</div>
          </div>
          <div>
            <div className="text-muted-foreground text-xs">Scope</div>
            <div className="truncate font-medium">{accountLabel}</div>
          </div>
        </div>

        <div className="flex items-center justify-end">
          <Button size="sm" onClick={handleCreate} disabled={isSubmitted || create.isPending}>
            {create.isPending ? (
              <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
            ) : isSubmitted ? (
              <Icons.Check className="mr-2 h-4 w-4" />
            ) : null}
            {isSubmitted ? "Rule created" : createError ? "Retry create" : "Create rule"}
          </Button>
        </div>
        {createError ? (
          <p className="text-destructive text-xs">
            Rule was not created. Retry will use a fresh draft id.
          </p>
        ) : null}
        {persistError ? (
          <p className="text-destructive text-xs">
            Rule created, but this chat could not be updated. Refresh rules before retrying from
            this draft.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

const CreateCategorizationRuleToolUIContent = memo(CreateCategorizationRuleToolUIContentImpl);

export const CreateCategorizationRuleToolUI = makeAssistantToolUI<
  CreateCategorizationRuleArgs,
  CreateCategorizationRuleOutput
>({
  toolName: "create_categorization_rule",
  render: (props) => <CreateCategorizationRuleToolUIContent {...props} />,
});
