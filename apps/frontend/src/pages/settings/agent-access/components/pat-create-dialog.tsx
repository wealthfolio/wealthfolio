import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CreateAgentAccessTokenInput } from "@/adapters";
import { cn } from "@/lib/utils";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { toast } from "@wealthfolio/ui/components/ui/use-toast";
import { buildClientConfig, STANDARD_PRESET_ID } from "../mcp-client-config";
import {
  applyScopeDependencies,
  READ_SCOPES,
  scopeDescription,
  scopeLabel,
  SCOPES,
  type ScopeKey,
} from "../scopes";

const EXPIRY_OPTIONS = [
  {
    value: "7",
    short: "settings:agentAccess.expiry_7d_short",
    label: "settings:agentAccess.expiry_7d_label",
  },
  {
    value: "30",
    short: "settings:agentAccess.expiry_30d_short",
    label: "settings:agentAccess.expiry_30d_label",
  },
  {
    value: "90",
    short: "settings:agentAccess.expiry_90d_short",
    label: "settings:agentAccess.expiry_90d_label",
  },
  {
    value: "365",
    short: "settings:agentAccess.expiry_1yr_short",
    label: "settings:agentAccess.expiry_1yr_label",
  },
  {
    value: "none",
    short: "settings:agentAccess.expiry_never_short",
    label: "settings:agentAccess.expiry_never_label",
  },
] as const;

const READ_GROUP = SCOPES.filter((scope) => scope.group === "read");
const WRITE_GROUP = SCOPES.filter((scope) => scope.group === "write");

interface PatCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Creates the token and resolves with the secret (shown once). */
  onCreate: (input: CreateAgentAccessTokenInput) => Promise<string>;
  isCreating: boolean;
  /** MCP server URL used to render a ready-to-paste client config (optional). */
  serverUrl?: string;
}

export function PatCreateDialog({
  open,
  onOpenChange,
  onCreate,
  isCreating,
  serverUrl,
}: PatCreateDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<string>("90");
  // Default to read-only: the common case is one edit away.
  const [selected, setSelected] = useState<Set<ScopeKey>>(() => new Set(READ_SCOPES));
  const [newToken, setNewToken] = useState<string | null>(null);

  const selectedScopes = useMemo<ScopeKey[]>(() => applyScopeDependencies(selected), [selected]);
  const expiryLabelKey = EXPIRY_OPTIONS.find((option) => option.value === expiry)?.label ?? "";
  const expiryLabel = expiryLabelKey ? t(expiryLabelKey) : "";
  const canCreate = name.trim().length > 0 && selectedScopes.length > 0 && !isCreating;

  const reset = () => {
    setName("");
    setExpiry("90");
    setSelected(new Set(READ_SCOPES));
    setNewToken(null);
  };

  const handleOpenChange = (value: boolean) => {
    if (!value) reset();
    onOpenChange(value);
  };

  const toggleScope = (key: ScopeKey) => {
    // Store only the user's raw selection; dependencies are derived in
    // `selectedScopes`. Baking them into state here would leave implied scopes
    // stuck on after their dependent write scopes are unchecked.
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleCreate = async () => {
    if (!canCreate) return;
    const expiresAt =
      expiry === "none"
        ? undefined
        : new Date(Date.now() + Number(expiry) * 24 * 60 * 60 * 1000).toISOString();
    try {
      setNewToken(await onCreate({ name: name.trim(), expiresAt, scopes: selectedScopes }));
    } catch (_error) {
      // Error toast is handled by the mutation; keep the dialog open.
    }
  };

  const handleCopy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast({
        title: t("settings:agentAccess.copied_title"),
        description: t("settings:agentAccess.copied_generic", { label }),
      });
    } catch (error) {
      toast({
        title: t("settings:agentAccess.copy_failed_title"),
        description: t("settings:agentAccess.copy_failed_generic", { label }),
        variant: "destructive",
      });
      console.error("Failed to copy to clipboard:", error);
    }
  };

  const configJson =
    newToken && serverUrl ? buildClientConfig(STANDARD_PRESET_ID, serverUrl, newToken) : "";

  const renderScope = (scope: (typeof SCOPES)[number]) => {
    const checked = selectedScopes.includes(scope.key);
    const label = scopeLabel(t, scope.key);
    const description = scopeDescription(t, scope.key);
    const locked =
      (scope.key === "activities:draft" && selectedScopes.includes("activities:write")) ||
      (scope.key === "classification:suggest" && selectedScopes.includes("classification:write"));
    return (
      <button
        key={scope.key}
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={t("settings:agentAccess.dialog_scope_aria", { label, description })}
        disabled={locked}
        title={locked ? t("settings:agentAccess.scope_locked_title") : description}
        onClick={() => toggleScope(scope.key)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors",
          "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
          checked
            ? "border-success/50 bg-success/10"
            : "border-border hover:border-muted-foreground/30 hover:bg-muted/40",
          locked && "cursor-not-allowed opacity-80",
        )}
      >
        <span className="truncate font-medium">{label}</span>
        <span
          className={cn(
            "grid h-4 w-4 shrink-0 place-items-center transition-colors",
            checked
              ? "bg-success rounded-[5px] text-white"
              : "border-muted-foreground/30 rounded-full border-2",
          )}
          aria-hidden
        >
          {checked && <Icons.Check className="h-2.5 w-2.5" strokeWidth={3} />}
        </span>
      </button>
    );
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn("overflow-hidden p-0", newToken === null ? "sm:max-w-5xl" : "sm:max-w-lg")}
      >
        {newToken === null ? (
          <div className="md:grid md:grid-cols-[1fr_22rem]">
            {/* Left: the form */}
            <div className="flex flex-col md:max-h-[85vh]">
              <div className="space-y-1 px-6 pb-4 pt-6">
                <DialogTitle>{t("settings:agentAccess.dialog_new_title")}</DialogTitle>
                <DialogDescription>
                  {t("settings:agentAccess.dialog_new_description")}
                </DialogDescription>
              </div>

              <div className="flex-1 space-y-6 overflow-y-auto px-6 pb-6">
                <div className="space-y-1.5">
                  <Label htmlFor="pat-name">{t("common:name")}</Label>
                  <Input
                    id="pat-name"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder={t("settings:agentAccess.dialog_name_placeholder")}
                    autoFocus
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>{t("settings:agentAccess.dialog_expires")}</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {EXPIRY_OPTIONS.map((option) => {
                      const active = expiry === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={active}
                          onClick={() => setExpiry(option.value)}
                          className={cn(
                            "rounded-full border px-3.5 py-1 text-sm transition-colors",
                            "focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2",
                            active
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border text-muted-foreground hover:bg-muted/50",
                          )}
                        >
                          {t(option.short)}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
                    {t("settings:agentAccess.dialog_read_access")}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">{READ_GROUP.map(renderScope)}</div>
                </div>

                <div className="space-y-2">
                  <p className="text-muted-foreground text-xs font-medium uppercase tracking-wider">
                    {t("settings:agentAccess.dialog_write_access")}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">{WRITE_GROUP.map(renderScope)}</div>
                </div>
              </div>
            </div>

            {/* Right: live capability summary + action */}
            <aside className="bg-muted/30 flex flex-col border-t md:max-h-[85vh] md:border-l md:border-t-0">
              <div className="flex-1 space-y-3 overflow-y-auto px-5 py-6">
                <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">
                  {t("settings:agentAccess.dialog_capabilities_title")}
                </p>
                {selectedScopes.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {t("settings:agentAccess.dialog_capabilities_empty")}
                  </p>
                ) : (
                  <ul className="space-y-2.5">
                    {selectedScopes.map((key) => (
                      <li key={key} className="flex items-start gap-2 text-sm">
                        <span className="bg-success mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full text-white">
                          <Icons.Check className="h-2.5 w-2.5" strokeWidth={3} />
                        </span>
                        <span className="text-foreground/90">{scopeDescription(t, key)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="space-y-3 border-t px-5 py-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {t("settings:agentAccess.dialog_expires")}
                  </span>
                  <span className="font-medium">{expiryLabel}</span>
                </div>
                <Button
                  className="w-full"
                  disabled={!canCreate}
                  onClick={() => void handleCreate()}
                >
                  {isCreating
                    ? t("settings:agentAccess.dialog_creating")
                    : t("settings:agentAccess.dialog_create_token")}
                </Button>
                <Button
                  variant="ghost"
                  className="text-muted-foreground h-8 w-full"
                  onClick={() => handleOpenChange(false)}
                >
                  {t("common:cancel")}
                </Button>
              </div>
            </aside>
          </div>
        ) : (
          <div className="space-y-4 p-6">
            <div className="space-y-1">
              <DialogTitle>{t("settings:agentAccess.dialog_created_title")}</DialogTitle>
              <DialogDescription>
                {t("settings:agentAccess.dialog_created_description")}
              </DialogDescription>
            </div>
            <div className="space-y-1.5">
              <Label>{t("settings:agentAccess.dialog_access_token")}</Label>
              <div className="flex items-center gap-2">
                <p className="bg-muted min-w-0 flex-1 select-all truncate rounded-md px-3 py-2 font-mono text-xs">
                  {newToken}
                </p>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  onClick={() => void handleCopy(newToken, t("settings:agentAccess.token_label"))}
                >
                  <Icons.Copy className="h-4 w-4" />
                  <span className="sr-only">
                    {t("settings:agentAccess.dialog_copy_token_aria")}
                  </span>
                </Button>
              </div>
            </div>

            {serverUrl && (
              <div className="space-y-1.5">
                <Label>{t("settings:agentAccess.dialog_client_config")}</Label>
                <p className="text-muted-foreground text-sm">
                  {t("settings:agentAccess.dialog_client_config_desc")}
                </p>
                <div className="flex items-start gap-2">
                  <pre className="bg-muted text-muted-foreground max-h-64 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-all rounded-md px-3 py-2 font-mono text-xs leading-relaxed">
                    {configJson}
                  </pre>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0"
                    onClick={() =>
                      void handleCopy(configJson, t("settings:agentAccess.dialog_client_config"))
                    }
                  >
                    <Icons.Copy className="h-4 w-4" />
                    <span className="sr-only">
                      {t("settings:agentAccess.dialog_copy_config_aria")}
                    </span>
                  </Button>
                </div>
              </div>
            )}
            <div className="flex justify-end">
              <Button onClick={() => handleOpenChange(false)}>
                {t("settings:agentAccess.dialog_done")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
