import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { format, formatDistanceToNowStrict } from "date-fns";
import type { AgentAccessToken } from "@/adapters";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@wealthfolio/ui/components/ui/alert-dialog";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { useAccessTokens } from "../hooks/use-access-tokens";
import { matchPreset, presetLabel, scopeLabel } from "../scopes";
import { PatCreateDialog } from "./pat-create-dialog";

type TokenStatus = "active" | "expired" | "revoked";

const STATUS_LABEL_KEY: Record<TokenStatus, string> = {
  active: "settings:agentAccess.pat_status_active",
  expired: "settings:agentAccess.pat_status_expired",
  revoked: "settings:agentAccess.pat_status_revoked",
};

function tokenStatus(token: AgentAccessToken): TokenStatus {
  if (token.revokedAt) return "revoked";
  if (token.expiresAt && new Date(token.expiresAt) < new Date()) return "expired";
  return "active";
}

/** "Created Mar 12, 2026". */
const formatCreated = (t: TFunction, value: string) =>
  t("settings:agentAccess.pat_created", { date: format(new Date(value), "MMM dd, yyyy") });

/** "Expires in 78 days" / "No expiration" / "Expired Apr 1". */
function formatExpiry(t: TFunction, expiresAt: string | null): string {
  if (!expiresAt) return t("settings:agentAccess.pat_no_expiration");
  const date = new Date(expiresAt);
  if (date < new Date())
    return t("settings:agentAccess.pat_expired_on", { date: format(date, "MMM d") });
  return t("settings:agentAccess.pat_expires_in", { duration: formatDistanceToNowStrict(date) });
}

/** "Last used 2 hours ago" / "Never used". */
const formatLastUsed = (t: TFunction, lastUsedAt: string | null) =>
  lastUsedAt
    ? t("settings:agentAccess.pat_last_used", {
        time: formatDistanceToNowStrict(new Date(lastUsedAt), { addSuffix: true }),
      })
    : t("settings:agentAccess.pat_never_used");

/** A muted chip summarizing a token's scopes; hover to view the exact list. */
function ScopeBadge({ scopes }: { scopes: string[] }) {
  const { t } = useTranslation();
  if (scopes.length === 0) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  const preset = matchPreset(scopes);
  const label = preset
    ? presetLabel(t, preset)
    : t("settings:agentAccess.pat_scope_custom", { count: scopes.length });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="secondary" className="cursor-default font-normal">
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p className="mb-1 font-medium">{t("settings:agentAccess.pat_scopes_tooltip")}</p>
        <ul className="text-muted-foreground space-y-0.5">
          {scopes.map((scope) => (
            <li key={scope}>{scopeLabel(t, scope)}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

export function PatTable({ serverUrl }: { serverUrl?: string } = {}) {
  const { t } = useTranslation();
  const { tokens, isLoading, createMutation, deleteMutation } = useAccessTokens();
  const [createOpen, setCreateOpen] = useState(false);
  const [removing, setRemoving] = useState<AgentAccessToken | null>(null);

  return (
    <Card className="rounded-lg">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0 p-6 pb-4">
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-base font-semibold tracking-tight">
            {t("settings:agentAccess.pat_title")}
          </CardTitle>
          <CardDescription className="text-xs">
            {t("settings:agentAccess.pat_description")}
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Icons.Plus className="mr-2 h-4 w-4" />
          {t("settings:agentAccess.pat_create")}
        </Button>
      </CardHeader>
      <CardContent className="p-6 pt-0">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
          </div>
        ) : tokens.length === 0 ? (
          <div className="text-muted-foreground rounded-md border border-dashed py-8 text-center text-xs">
            {t("settings:agentAccess.pat_empty")}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {tokens.map((token) => {
              const status = tokenStatus(token);
              const inactive = status !== "active";
              return (
                <div
                  key={token.id}
                  className={cn(
                    "grid grid-cols-[auto_1fr_auto] items-center gap-4 rounded-md border px-4 py-3.5 transition-colors",
                    inactive
                      ? "border-border border-dashed bg-transparent opacity-80"
                      : "bg-muted/30 border-border",
                  )}
                >
                  <div
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-md border",
                      inactive
                        ? "border-border/60 text-muted-foreground bg-transparent"
                        : "bg-background border-border text-foreground",
                    )}
                  >
                    <Icons.ShieldCheck size={18} weight="duotone" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{token.name}</span>
                      <Badge variant="secondary" className="font-normal">
                        {t(STATUS_LABEL_KEY[status])}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {formatCreated(t, token.createdAt)} · {formatExpiry(t, token.expiresAt)} ·{" "}
                      {formatLastUsed(t, token.lastUsedAt)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <ScopeBadge scopes={token.scopes} />
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:border-destructive/40 rounded-full"
                      onClick={() => setRemoving(token)}
                    >
                      {t("settings:agentAccess.pat_remove")}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      <PatCreateDialog
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open) createMutation.reset();
        }}
        onCreate={async (input) => {
          const created = await createMutation.mutateAsync(input);
          return created.token;
        }}
        isCreating={createMutation.isPending}
        serverUrl={serverUrl}
      />

      <AlertDialog open={removing !== null} onOpenChange={(value) => !value && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings:agentAccess.pat_remove_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {removing
                ? t("settings:agentAccess.pat_remove_desc_named", { name: removing.name })
                : t("settings:agentAccess.pat_remove_desc_generic")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("common:cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (!removing) return;
                deleteMutation.mutate(removing.id, { onSuccess: () => setRemoving(null) });
              }}
            >
              {t("settings:agentAccess.pat_remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
