import type { AgentAccessToken } from "@/adapters";
import { cn } from "@/lib/utils";
import {
  dateFnsLocaleFor,
  useDateFormatting,
  useLocalizationSettings,
  type DateFormatting,
} from "@wealthfolio/ui";
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
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@wealthfolio/ui/components/ui/tooltip";
import { formatDistanceToNowStrict, type Locale } from "date-fns";
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAccessTokens } from "../hooks/use-access-tokens";
import { matchPreset, presetLabel, scopeLabel } from "../scopes";
import { PatEditDialog } from "./pat-edit-dialog";
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
const formatCreated = (t: TFunction, value: string, formatting: DateFormatting) =>
  t("settings:agentAccess.pat_created", {
    date: formatting.formatDate(new Date(value)),
  });

/** "Expires in 78 days" / "No expiration" / "Expired Apr 1". */
function formatExpiry(
  t: TFunction,
  expiresAt: string | null,
  formatting: DateFormatting,
  locale: Locale,
): string {
  if (!expiresAt) return t("settings:agentAccess.pat_no_expiration");
  const date = new Date(expiresAt);
  if (date < new Date())
    return t("settings:agentAccess.pat_expired_on", {
      date: formatting.formatDate(date),
    });
  return t("settings:agentAccess.pat_expires_in", {
    duration: formatDistanceToNowStrict(date, { locale }),
  });
}

/** "Last used 2 hours ago" / "Never used". */
const formatLastUsed = (t: TFunction, lastUsedAt: string | null, locale: Locale) =>
  lastUsedAt
    ? t("settings:agentAccess.pat_last_used", {
        time: formatDistanceToNowStrict(new Date(lastUsedAt), { addSuffix: true, locale }),
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
      <TooltipTrigger render={<Badge variant="secondary" className="cursor-default font-normal" />}>
        {label}
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p className="mb-1 font-medium">{t("settings:agentAccess.pat_scopes_tooltip")}</p>
        <ul className="text-background/70 space-y-0.5">
          {scopes.map((scope) => (
            <li key={scope}>{scopeLabel(t, scope)}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

export function PatTable({ serverUrl }: { serverUrl?: string } = {}) {
  const formatting = useDateFormatting();
  const { uiLocale } = useLocalizationSettings();
  const dateFnsLocale = dateFnsLocaleFor(uiLocale);
  const { t } = useTranslation();
  const { tokens, isLoading, createMutation, updateMutation, deleteMutation } = useAccessTokens();
  const [editing, setEditing] = useState<AgentAccessToken | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [removing, setRemoving] = useState<AgentAccessToken | null>(null);

  return (
    <Card>
      <CardHeader className="max-sm:has-data-[slot=card-action]:grid-cols-1">
        <CardTitle role="heading" aria-level={2} className="text-lg">
          {t("settings:agentAccess.pat_title")}
        </CardTitle>
        <CardDescription>{t("settings:agentAccess.pat_description")}</CardDescription>
        <CardAction className="max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:justify-self-stretch max-sm:pt-1.5">
          <Button size="sm" className="max-sm:w-full" onClick={() => setCreateOpen(true)}>
            <Icons.Plus className="me-2 h-4 w-4" />
            {t("settings:agentAccess.pat_create")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 rounded-md" />
            <Skeleton className="h-16 rounded-md" />
          </div>
        ) : tokens.length === 0 ? (
          <p className="text-muted-foreground py-8 text-center text-sm">
            {t("settings:agentAccess.pat_empty")}
          </p>
        ) : (
          <ul className="settings-list divide-y" aria-label={t("settings:agentAccess.pat_title")}>
            {tokens.map((token) => {
              const status = tokenStatus(token);
              const inactive = status !== "active";
              return (
                <li
                  key={token.id}
                  className={cn(
                    "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 py-3 first:pt-0 last:pb-0 sm:grid-cols-[auto_minmax(0,1fr)_auto]",
                  )}
                >
                  <div
                    className={cn(
                      "bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-lg",
                      inactive && "opacity-60",
                    )}
                  >
                    <Icons.ShieldCheck className="size-5" weight="duotone" />
                  </div>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        dir="auto"
                        className={cn(
                          "truncate text-sm font-medium rtl:text-right",
                          inactive && "text-muted-foreground",
                        )}
                      >
                        {token.name}
                      </span>
                      <Badge variant="secondary" className="font-normal">
                        {t(STATUS_LABEL_KEY[status])}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {formatCreated(t, token.createdAt, formatting)} ·{" "}
                      {formatExpiry(t, token.expiresAt, formatting, dateFnsLocale)} ·{" "}
                      {formatLastUsed(t, token.lastUsedAt, dateFnsLocale)}
                    </p>
                  </div>
                  <div className="col-span-2 flex flex-wrap items-center justify-end gap-3 sm:col-span-1">
                    <ScopeBadge scopes={token.scopes} />
                    <Button variant="outline" size="sm" onClick={() => setEditing(token)}>
                      {t("settings:agentAccess.edit_permissions")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-destructive hover:text-destructive hover:border-destructive/40 rounded-full"
                      onClick={() => setRemoving(token)}
                    >
                      {t("settings:agentAccess.pat_remove")}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>

      {editing && (
        <PatEditDialog
          key={editing.id}
          token={editing}
          onClose={() => setEditing(null)}
          onSave={(scopes) => updateMutation.mutateAsync({ id: editing.id, scopes })}
          isSaving={updateMutation.isPending}
        />
      )}

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
              variant="destructive"
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
