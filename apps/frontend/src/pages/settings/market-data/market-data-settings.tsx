import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@wealthfolio/ui/components/ui/tabs";
import { useMemo, useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { SettingsHeader } from "../settings-header";

import { getSecret, type MarketDataProviderSetting } from "@/adapters";
import { useI18n } from "@/i18n/i18n-provider";
import {
  useRecalculatePortfolioMutation,
  useUpdatePortfolioMutation,
} from "@/hooks/use-calculate-portfolio";
import {
  useCustomProviders,
  useDeleteCustomProvider,
  useUpdateCustomProvider,
} from "@/hooks/use-custom-providers";
import { QueryKeys } from "@/lib/query-keys";
import type { CustomProviderWithSources } from "@/lib/types/custom-provider";
import { cn } from "@/lib/utils";
import { ActionConfirm } from "@wealthfolio/ui";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@wealthfolio/ui/components/ui/collapsible";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import {
  useDeleteApiKey,
  useMarketDataProviderSettings,
  useSetApiKey,
  useUpdateMarketDataProviderSettings,
} from "./use-market-data-settings";
import { CustomProviderForm } from "./custom-provider-form";

interface ProviderSettingsProps {
  provider: MarketDataProviderSetting;
  priorityValue: number;
  onUpdate: (settings: { priority?: number; enabled?: boolean }) => void;
  onPriorityChange: (value: string) => void;
  onPrioritySave: () => void;
  isLast?: boolean;
}

function ProviderSettings({
  provider,
  priorityValue,
  onUpdate,
  onPriorityChange,
  onPrioritySave,
  isLast = false,
}: ProviderSettingsProps) {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [isLoadingKey, setIsLoadingKey] = useState(false);
  const [hasLoadedKey, setHasLoadedKey] = useState(false);

  const { mutate: setApiKey } = useSetApiKey();
  const { mutate: deleteApiKey } = useDeleteApiKey();

  const handleRevealApiKey = async () => {
    if (hasLoadedKey) {
      setShowApiKey(!showApiKey);
      return;
    }

    setIsLoadingKey(true);
    try {
      const key = await getSecret(provider.id);
      if (key) {
        setApiKeyValue(key);
      }
      setHasLoadedKey(true);
      setShowApiKey(true);
    } finally {
      setIsLoadingKey(false);
    }
  };

  const handleSaveApiKey = () => {
    if (apiKeyValue && apiKeyValue.trim() !== "") {
      setApiKey(
        { providerId: provider.id, apiKey: apiKeyValue },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: QueryKeys.secrets.apiKey(provider.id) });
          },
        },
      );
    } else {
      deleteApiKey(
        { providerId: provider.id },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: QueryKeys.secrets.apiKey(provider.id) });
            setHasLoadedKey(false);
          },
        },
      );
    }
  };

  // Feature icons and display names mapping
  const getFeatureDisplay = (feature: string) => {
    const normalized = feature.toLowerCase();
    if (normalized.includes("real-time")) {
      return { icon: <Icons.Activity2 className="h-3 w-3" />, label: "Quote" };
    }
    if (normalized.includes("historical")) {
      return { icon: <Icons.Clock className="h-3 w-3" />, label: "Historical" };
    }
    if (normalized.includes("search")) {
      return { icon: <Icons.Search className="h-3 w-3" />, label: "Search" };
    }
    if (normalized.includes("profile")) {
      return { icon: <Icons.FileText className="h-3 w-3" />, label: "Profiles" };
    }
    return { icon: null, label: feature };
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className={cn("hover:bg-accent/30 transition-colors", !isLast && "border-b")}>
        {/* Main row */}
        <div className="flex items-center gap-4 px-4 py-3">
          {/* Logo */}
          <div className="flex h-9 w-9 shrink-0 items-center justify-center">
            {provider.logoFilename ? (
              <img
                src={`/market-data/${provider.logoFilename}`}
                alt=""
                className="h-9 w-9 rounded-lg object-contain"
              />
            ) : (
              <div className="bg-muted flex h-9 w-9 items-center justify-center rounded-lg">
                <Icons.Globe className="text-muted-foreground h-5 w-5" />
              </div>
            )}
          </div>

          {/* Name, description and capabilities */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="font-medium">{provider.name}</span>
              {provider.capabilities?.coverage && (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                  {provider.capabilities.coverage}
                </Badge>
              )}
              {provider.enabled && provider.requiresApiKey && !provider.hasApiKey && (
                <Badge
                  variant="outline"
                  className="border-warning/20 bg-warning/10 text-warning shrink-0 text-xs"
                >
                  <Icons.AlertTriangle className="mr-1 h-3 w-3" />
                  API Key Required
                </Badge>
              )}
              {provider.assetCount > 0 && (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                  {provider.assetCount} {provider.assetCount === 1 ? "asset" : "assets"}
                </Badge>
              )}
              {provider.errorCount > 0 && (
                <Popover>
                  <PopoverTrigger asChild>
                    <Badge
                      variant="outline"
                      className="border-destructive/20 bg-destructive/10 text-destructive hover:bg-destructive/20 shrink-0 cursor-pointer text-xs"
                    >
                      <Icons.XCircle className="mr-1 h-3 w-3" />
                      {provider.errorCount} {provider.errorCount === 1 ? "error" : "errors"}
                    </Badge>
                  </PopoverTrigger>
                  <PopoverContent className="w-80 p-0" align="start">
                    <div className="border-b px-3 py-2">
                      <h4 className="text-sm font-medium">Sync Errors</h4>
                      <p className="text-muted-foreground text-xs">
                        {provider.errorCount} {provider.errorCount === 1 ? "asset" : "assets"}{" "}
                        failed to sync
                      </p>
                    </div>
                    <div className="max-h-60 overflow-auto p-2">
                      {provider.uniqueErrors.length > 0 ? (
                        <ul className="space-y-2">
                          {provider.uniqueErrors.map((error, index) => (
                            <li
                              key={index}
                              className="bg-destructive/5 text-destructive rounded-md p-2 text-xs"
                            >
                              {error}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-muted-foreground p-2 text-xs">
                          No error details available
                        </p>
                      )}
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>
            {/* Description - smaller text */}
            {provider.description && (
              <p className="text-muted-foreground mt-0.5 text-xs">{provider.description}</p>
            )}
            {/* Capability features */}
            {provider.capabilities && provider.capabilities.features.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {provider.capabilities.features.map((feature) => {
                  const { icon, label } = getFeatureDisplay(feature);
                  return (
                    <span
                      key={feature}
                      className="text-muted-foreground inline-flex items-center gap-1 text-[11px]"
                    >
                      {icon}
                      {label}
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          {/* Controls */}
          <div className="flex shrink-0 items-center gap-2">
            <CollapsibleTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground h-8 w-8"
              >
                <Icons.Settings className="h-4 w-4" />
              </Button>
            </CollapsibleTrigger>
            <Switch
              id={`${provider.id}-enabled`}
              checked={provider.enabled}
              onCheckedChange={(checked) => onUpdate({ enabled: checked })}
              className="data-[state=checked]:bg-success"
            />
          </div>
        </div>

        {/* Expandable settings */}
        <CollapsibleContent>
          <div className="bg-muted/30 border-t px-4 py-4">
            <div className="grid gap-6 md:grid-cols-2">
              {/* Left column - Capabilities */}
              <div className="space-y-4">
                <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                  Capabilities
                </h4>
                <div className="space-y-3">
                  {provider.capabilities?.instruments && (
                    <div className="flex items-start gap-3">
                      <Icons.TrendingUp className="text-muted-foreground mt-0.5 h-4 w-4" />
                      <div>
                        <p className="text-xs font-medium">Instruments</p>
                        <p className="text-muted-foreground text-xs">
                          {provider.capabilities.instruments}
                        </p>
                      </div>
                    </div>
                  )}
                  {provider.capabilities?.coverage && (
                    <div className="flex items-start gap-3">
                      <Icons.Globe className="text-muted-foreground mt-0.5 h-4 w-4" />
                      <div>
                        <p className="text-xs font-medium">Coverage</p>
                        <p className="text-muted-foreground text-xs">
                          {provider.capabilities.coverage}
                        </p>
                      </div>
                    </div>
                  )}
                  {provider.capabilities?.features && provider.capabilities.features.length > 0 && (
                    <div className="flex items-start gap-3">
                      <Icons.Sparkles className="text-muted-foreground mt-0.5 h-4 w-4" />
                      <div>
                        <p className="text-xs font-medium">Features</p>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {provider.capabilities.features.map((feature) => (
                            <Badge
                              key={feature}
                              variant="secondary"
                              className="h-5 px-1.5 text-[10px] font-normal"
                            >
                              {feature}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                  {provider.url && (
                    <div className="flex items-start gap-3">
                      <Icons.ExternalLink className="text-muted-foreground mt-0.5 h-4 w-4" />
                      <div>
                        <p className="text-xs font-medium">Website</p>
                        <a
                          href={provider.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary text-xs hover:underline"
                        >
                          {provider.url}
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Right column - Settings */}
              <div className="space-y-4">
                <h4 className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                  Settings
                </h4>
                <div className="space-y-4">
                  {provider.requiresApiKey && (
                    <div className="space-y-2">
                      <Label htmlFor={`apikey-${provider.id}`} className="text-xs font-medium">
                        API Key
                      </Label>
                      <div className="flex items-center gap-2">
                        <Input
                          id={`apikey-${provider.id}`}
                          type={showApiKey ? "text" : "password"}
                          value={
                            hasLoadedKey
                              ? apiKeyValue
                              : provider.hasApiKey
                                ? "••••••••••••••••••••••••"
                                : ""
                          }
                          onChange={(e) => setApiKeyValue(e.target.value)}
                          placeholder={provider.hasApiKey ? "" : "Enter API key"}
                          className="grow font-mono text-xs"
                          readOnly={!hasLoadedKey && provider.hasApiKey}
                        />
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 w-8"
                          onClick={handleRevealApiKey}
                          disabled={isLoadingKey}
                          aria-label={showApiKey ? "Hide API key" : "Show API key"}
                        >
                          {isLoadingKey ? (
                            <Icons.Spinner className="h-3.5 w-3.5 animate-spin" />
                          ) : showApiKey ? (
                            <Icons.EyeOff className="h-3.5 w-3.5" />
                          ) : (
                            <Icons.Eye className="h-3.5 w-3.5" />
                          )}
                        </Button>
                        <Button
                          onClick={handleSaveApiKey}
                          size="sm"
                          className="h-8"
                          disabled={provider.hasApiKey && !hasLoadedKey}
                        >
                          Save
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-3">
                    <Label className="text-xs font-medium">Priority</Label>
                    <div className="flex items-center">
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7 rounded-r-none"
                        onClick={() => {
                          const newVal = Math.max(1, (priorityValue ?? 1) - 1);
                          onPriorityChange(String(newVal));
                          onPrioritySave();
                        }}
                      >
                        <Icons.MinusCircle className="h-3 w-3" />
                      </Button>
                      <div className="bg-muted flex h-7 w-10 items-center justify-center border-y text-xs font-medium">
                        {priorityValue ?? 1}
                      </div>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-7 w-7 rounded-l-none"
                        onClick={() => {
                          const newVal = (priorityValue ?? 1) + 1;
                          onPriorityChange(String(newVal));
                          onPrioritySave();
                        }}
                      >
                        <Icons.PlusCircle className="h-3 w-3" />
                      </Button>
                    </div>
                    <span className="text-muted-foreground text-[10px]">
                      Lower = higher priority
                    </span>
                  </div>

                  {/* Sync Status */}
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">Sync Status</Label>
                    {provider.errorCount > 0 ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Icons.XCircle className="h-4 w-4 text-red-500" />
                          <span className="text-xs font-medium text-red-500">
                            {provider.errorCount} {provider.errorCount === 1 ? "asset" : "assets"}{" "}
                            with errors
                          </span>
                        </div>
                        {provider.lastSyncError && (
                          <p className="bg-destructive/10 text-destructive rounded-md p-2 text-xs">
                            {provider.lastSyncError}
                          </p>
                        )}
                        {provider.lastSyncedAt && (
                          <p className="text-muted-foreground text-xs">
                            Last sync: {new Date(provider.lastSyncedAt).toLocaleString()}
                          </p>
                        )}
                      </div>
                    ) : provider.assetCount === 0 ? (
                      <div className="flex items-center gap-2">
                        <Icons.MinusCircle className="text-muted-foreground h-4 w-4" />
                        <span className="text-muted-foreground text-xs">
                          No assets using this provider
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Icons.CheckCircle className="h-4 w-4 text-green-500" />
                        <span className="text-muted-foreground text-xs">
                          {provider.lastSyncedAt
                            ? `Last sync: ${new Date(provider.lastSyncedAt).toLocaleString()}`
                            : "Pending sync"}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function CustomProviderCard({
  provider,
  onEdit,
  onDelete,
  onToggleEnabled,
  isDeleting = false,
  isToggling = false,
  isLast = false,
}: {
  provider: CustomProviderWithSources;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  isDeleting?: boolean;
  isToggling?: boolean;
  isLast?: boolean;
}) {
  const { language } = useI18n();
  const isChinese = language === "zh-CN";
  const latestSource = provider.sources.find((s) => s.kind === "latest");
  const historicalSource = provider.sources.find((s) => s.kind === "historical");

  return (
    <div className={cn("hover:bg-accent/30 transition-colors", !isLast && "border-b")}>
      <div className="flex items-center gap-4 px-4 py-3">
        <div className="bg-muted flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
          <Icons.Globe className="text-muted-foreground h-5 w-5" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{provider.name}</span>
            {!provider.enabled && (
              <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                Disabled
              </Badge>
            )}
          </div>
          {provider.description && (
            <p className="text-muted-foreground mt-0.5 text-xs">{provider.description}</p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {latestSource && (
              <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
                <Icons.Activity2 className="h-3 w-3" />
                {latestSource.format.toUpperCase()}
              </span>
            )}
            {historicalSource && (
              <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
                <Icons.Clock className="h-3 w-3" />
                Historical
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Switch
            id={`${provider.id}-enabled`}
            checked={provider.enabled}
            onCheckedChange={onToggleEnabled}
            disabled={isToggling}
            className="data-[state=checked]:bg-success"
          />
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground h-8 w-8"
            onClick={onEdit}
          >
            <Icons.Pencil className="h-4 w-4" />
          </Button>
          <ActionConfirm
            handleConfirm={onDelete}
            isPending={isDeleting}
            confirmTitle={isChinese ? "要删除自定义数据源吗？" : "Delete Custom Provider?"}
            confirmMessage={
              isChinese
                ? `这会永久删除“${provider.name}”，并将其从所有使用它的资产中移除。`
                : `This will permanently delete "${provider.name}" and remove it from all assets using it.`
            }
            confirmButtonText={isChinese ? "删除" : "Delete"}
            cancelButtonText={isChinese ? "取消" : "Cancel"}
            confirmButtonVariant="destructive"
            button={
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive h-8 w-8"
              >
                <Icons.Trash className="h-4 w-4" />
              </Button>
            }
          />
        </div>
      </div>
    </div>
  );
}

export default function MarketDataSettingsPage() {
  const { data: providers, isLoading, error } = useMarketDataProviderSettings();
  const { mutate: updateSettings } = useUpdateMarketDataProviderSettings();
  const { mutate: updatePortfolio, isPending: isUpdating } = useUpdatePortfolioMutation();
  const { mutate: recalculatePortfolio, isPending: isRecalculating } =
    useRecalculatePortfolioMutation();
  const { data: customProviders = [] } = useCustomProviders();
  const { mutate: deleteCustomProvider } = useDeleteCustomProvider();
  const { mutate: updateCustomProvider } = useUpdateCustomProvider();

  const [priorityInputs, setPriorityInputs] = useState<Record<string, number>>({});
  const [customFormOpen, setCustomFormOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<CustomProviderWithSources | undefined>();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Split providers into built-in providers and the CUSTOM_SCRAPER aggregate
  const { builtinProviders, customScraperErrors } = useMemo(() => {
    if (!providers) return { builtinProviders: [], customScraperErrors: undefined };
    const builtin: MarketDataProviderSetting[] = [];
    let scraperInfo: MarketDataProviderSetting | undefined;
    for (const p of providers) {
      if (p.id === "CUSTOM_SCRAPER") {
        scraperInfo = p;
      } else {
        builtin.push(p);
      }
    }
    builtin.sort((a, b) => {
      if (a.enabled === b.enabled) return a.priority - b.priority;
      return a.enabled ? -1 : 1;
    });
    return { builtinProviders: builtin, customScraperErrors: scraperInfo };
  }, [providers]);

  useEffect(() => {
    if (providers) {
      const initialPriorityInputs: Record<string, number> = {};
      providers.forEach((p: MarketDataProviderSetting) => {
        initialPriorityInputs[p.id] = p.priority;
      });
      setPriorityInputs(initialPriorityInputs);
    }
  }, [providers]);

  const handleUpdateSetting = (
    providerId: string,
    settingsToUpdate: { priority?: number; enabled?: boolean },
  ) => {
    const provider = providers?.find((p) => p.id === providerId);
    if (!provider) return;

    updateSettings({
      providerId,
      priority: settingsToUpdate.priority ?? provider.priority,
      enabled: settingsToUpdate.enabled ?? provider.enabled,
    });
  };

  const handlePriorityInputChange = (providerId: string, value: string) => {
    const numValue = parseInt(value, 10);
    setPriorityInputs((prev) => ({ ...prev, [providerId]: isNaN(numValue) ? 0 : numValue }));
  };

  const handlePrioritySave = (providerId: string) => {
    const newPriority = priorityInputs[providerId];
    const provider = providers?.find((p) => p.id === providerId);
    if (provider && newPriority !== provider.priority) {
      handleUpdateSetting(providerId, { priority: newPriority });
    }
  };

  if (isLoading) {
    return (
      <div className="text-foreground space-y-6">
        <SettingsHeader heading="Market Data" text="Configure your market data providers." />
        <Separator />
        <div className="overflow-hidden rounded-lg border">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
            <div key={i} className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0">
              <Skeleton className="h-9 w-9 rounded-lg" />
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
                <Skeleton className="h-3 w-64" />
                <div className="flex gap-3">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Skeleton className="h-8 w-8 rounded-md" />
                <Skeleton className="h-5 w-9 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-foreground space-y-6">
        <SettingsHeader heading="Market Data" text="Configure your market data providers." />
        <Separator />
        <div className="border-destructive/20 bg-destructive/5 rounded-lg border p-6">
          <div className="flex items-start gap-3">
            <Icons.XCircle className="text-destructive mt-0.5 h-5 w-5 shrink-0" />
            <div className="space-y-2">
              <h3 className="text-destructive font-medium">Failed to load market data settings</h3>
              <p className="text-muted-foreground text-sm">{error.message}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.location.reload()}
                className="mt-2"
              >
                <Icons.Refresh className="mr-2 h-4 w-4" />
                Retry
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="text-foreground space-y-6">
      <SettingsHeader
        heading="Market Data"
        text="Configure your market data providers."
        actionsInline
      >
        <div className="flex items-center gap-2">
          <Button
            asChild
            variant="outline"
            size="icon"
            className="sm:hidden"
            aria-label="Import quotes"
          >
            <Link to="/settings/market-data/import">
              <Icons.Import className="h-4 w-4" />
            </Link>
          </Button>
          <Button
            asChild
            variant="outline"
            size="sm"
            className="hidden sm:inline-flex"
            aria-label="Import historical quotes"
          >
            <Link to="/settings/market-data/import">
              <Icons.Import className="mr-2 h-4 w-4" />
              Import
            </Link>
          </Button>
          {/* Mobile icon-only actions */}
          <ActionConfirm
            handleConfirm={() => recalculatePortfolio()}
            isPending={isRecalculating}
            confirmTitle="Rebuild Full History?"
            confirmMessage="This will rebuild quote history from your first activity date (up to 5 years) and recalculate the portfolio. Use this to fix gaps or sync issues."
            confirmButtonText="Rebuild"
            pendingText="Rebuilding..."
            cancelButtonText="Cancel"
            confirmButtonVariant="destructive"
            button={
              <Button
                variant="outline"
                size="icon"
                className="sm:hidden"
                disabled={isRecalculating}
                aria-label="Rebuild full history"
              >
                {isRecalculating ? (
                  <Icons.Spinner className="h-4 w-4 animate-spin" />
                ) : (
                  <Icons.Clock className="h-4 w-4" />
                )}
              </Button>
            }
          />
          <Button
            size="icon"
            className="sm:hidden"
            disabled={isUpdating}
            onClick={() => updatePortfolio()}
            aria-label="Update"
          >
            {isUpdating ? (
              <Icons.Spinner className="h-4 w-4 animate-spin" />
            ) : (
              <Icons.Refresh className="h-4 w-4" />
            )}
          </Button>

          {/* Desktop buttons with labels */}
          <ActionConfirm
            handleConfirm={() => recalculatePortfolio()}
            isPending={isRecalculating}
            confirmTitle="Rebuild Full History?"
            confirmMessage="This will rebuild quote history from your first activity date (up to 5 years) and recalculate the portfolio. Use this to fix gaps or sync issues."
            confirmButtonText="Rebuild"
            pendingText="Rebuilding..."
            cancelButtonText="Cancel"
            confirmButtonVariant="destructive"
            button={
              <Button
                variant="outline"
                size="sm"
                className="hidden sm:inline-flex"
                disabled={isRecalculating}
              >
                {isRecalculating ? (
                  <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Icons.Clock className="mr-2 h-4 w-4" />
                )}
                Rebuild History
              </Button>
            }
          />
          <Button
            size="sm"
            className="hidden sm:inline-flex"
            disabled={isUpdating}
            onClick={() => updatePortfolio()}
          >
            {isUpdating ? (
              <Icons.Spinner className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Icons.Refresh className="mr-2 h-4 w-4" />
            )}
            Update
          </Button>
        </div>
      </SettingsHeader>
      <Separator />

      <Tabs defaultValue="builtin" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="builtin">
            Built-in Providers
            {builtinProviders.filter((p) => p.enabled).length > 0 && (
              <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 text-[10px] font-normal">
                {builtinProviders.filter((p) => p.enabled).length}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="custom">
            Custom Providers
            {customProviders.filter((p) => p.enabled).length > 0 && (
              <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 text-[10px] font-normal">
                {customProviders.filter((p) => p.enabled).length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="builtin" className="mt-4">
          {builtinProviders.length === 0 ? (
            <p className="text-muted-foreground text-sm">No built-in providers configured.</p>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              {builtinProviders.map((provider, index, arr) => (
                <ProviderSettings
                  key={provider.id}
                  provider={provider}
                  priorityValue={priorityInputs[provider.id]}
                  onUpdate={(settings) => handleUpdateSetting(provider.id, settings)}
                  onPriorityChange={(value) => handlePriorityInputChange(provider.id, value)}
                  onPrioritySave={() => handlePrioritySave(provider.id)}
                  isLast={index === arr.length - 1}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="custom" className="mt-4">
          <div className="mb-3 flex items-center justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditingProvider(undefined);
                setCustomFormOpen(true);
              }}
            >
              <Icons.Plus className="mr-1 h-3 w-3" />
              Add Provider
            </Button>
          </div>
          {customScraperErrors && customScraperErrors.errorCount > 0 && (
            <div className="border-destructive/20 bg-destructive/5 mb-3 rounded-lg border p-3">
              <div className="flex items-start gap-2">
                <Icons.XCircle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <p className="text-destructive text-sm font-medium">
                    {customScraperErrors.errorCount} asset
                    {customScraperErrors.errorCount > 1 ? "s" : ""} failed to sync
                  </p>
                  {customScraperErrors.uniqueErrors?.map((err, i) => {
                    // Strip boilerplate prefix, keep just the actionable message
                    // Error format: "...CUSTOM_SCRAPER: [provider-id] actual message"
                    const lastIdx = err.lastIndexOf("CUSTOM_SCRAPER: ");
                    let msg = lastIdx >= 0 ? err.slice(lastIdx + "CUSTOM_SCRAPER: ".length) : err;
                    // Extract [provider-id] prefix and resolve to provider name
                    let providerLabel = "";
                    const bracketMatch = /^\[([^\]]+)\]\s*/.exec(msg);
                    if (bracketMatch) {
                      const code = bracketMatch[1];
                      const cp = customProviders.find((p) => p.id === code);
                      providerLabel = cp?.name ?? code;
                      msg = msg.slice(bracketMatch[0].length);
                    }
                    return (
                      <p key={i} className="text-destructive/80 mt-1 break-all text-xs">
                        {providerLabel && (
                          <span className="text-destructive font-medium">{providerLabel}: </span>
                        )}
                        {msg}
                      </p>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          {customProviders.length === 0 ? (
            <div className="rounded-lg border border-dashed p-6 text-center">
              <Icons.Globe className="text-muted-foreground/50 mx-auto h-8 w-8" />
              <p className="text-muted-foreground mt-2 text-sm">No custom providers configured</p>
              <p className="text-muted-foreground text-xs">
                Add a custom data source to scrape prices from any website or API.
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              {customProviders.map((cp, index) => (
                <CustomProviderCard
                  key={cp.id}
                  provider={cp}
                  onEdit={() => {
                    setEditingProvider(cp);
                    setCustomFormOpen(true);
                  }}
                  onDelete={() => {
                    setDeletingId(cp.id);
                    deleteCustomProvider(cp.id, {
                      onSettled: () => setDeletingId(null),
                    });
                  }}
                  onToggleEnabled={(enabled) => {
                    setTogglingId(cp.id);
                    updateCustomProvider(
                      { providerId: cp.id, payload: { enabled } },
                      { onSettled: () => setTogglingId(null) },
                    );
                  }}
                  isDeleting={deletingId === cp.id}
                  isToggling={togglingId === cp.id}
                  isLast={index === customProviders.length - 1}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      <CustomProviderForm
        open={customFormOpen}
        onOpenChange={setCustomFormOpen}
        provider={editingProvider}
      />
    </div>
  );
}
