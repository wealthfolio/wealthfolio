import { useQuery, useQueryClient } from "@tanstack/react-query";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@wealthfolio/ui/components/ui/dropdown-menu";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@wealthfolio/ui/components/ui/tabs";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";

import { ResetProviderHistoryDialog } from "@/pages/asset/reset-provider-history-dialog";

import { SettingsHeader } from "../settings-header";

import { getAssets, getSecret, type MarketDataProviderSetting } from "@/adapters";
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
import type { Asset } from "@/lib/types";
import type { CustomProviderWithSources } from "@/lib/types/custom-provider";
import { cn } from "@/lib/utils";
import { ActionConfirm, useDateFormatting } from "@wealthfolio/ui";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@wealthfolio/ui/components/ui/collapsible";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import { CustomProviderForm } from "./custom-provider-form";
import { CustomProviderUsageChips } from "./custom-provider-usage-chips";
import {
  EMPTY_USAGE,
  getCustomProviderUsage,
  servesAsFallback,
  deleteBlockerCount,
  usageCount,
  type CustomProviderUsage,
} from "./custom-provider-usage";
import {
  useDeleteApiKey,
  useMarketDataProviderSettings,
  useSetApiKey,
  useUpdateMarketDataProviderSettings,
} from "./use-market-data-settings";

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
  const formatting = useDateFormatting();
  const { t } = useTranslation();
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
      return {
        icon: <Icons.Activity2 className="h-3 w-3" />,
        label: t("settings:market_data_page.feature_quote"),
      };
    }
    if (normalized.includes("historical")) {
      return {
        icon: <Icons.Clock className="h-3 w-3" />,
        label: t("settings:market_data_page.feature_historical"),
      };
    }
    if (normalized.includes("search")) {
      return {
        icon: <Icons.Search className="h-3 w-3" />,
        label: t("settings:market_data_page.feature_search"),
      };
    }
    if (normalized.includes("profile")) {
      return {
        icon: <Icons.FileText className="h-3 w-3" />,
        label: t("settings:market_data_page.feature_profiles"),
      };
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
                  {t("settings:market_data_page.api_key_required")}
                </Badge>
              )}
              {provider.assetCount > 0 && (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                  {t("settings:market_data_page.assets_count", { count: provider.assetCount })}
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
                      {t("settings:market_data_page.errors_count", { count: provider.errorCount })}
                    </Badge>
                  </PopoverTrigger>
                  <PopoverContent className="w-80 p-0" align="start">
                    <div className="border-b px-3 py-2">
                      <h4 className="text-sm font-medium">
                        {t("settings:market_data_page.sync_errors")}
                      </h4>
                      <p className="text-muted-foreground text-xs">
                        {t("settings:market_data_page.assets_failed_to_sync", {
                          count: provider.errorCount,
                        })}
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
                          {t("settings:market_data_page.no_error_details")}
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
                  {t("settings:market_data_page.capabilities")}
                </h4>
                <div className="space-y-3">
                  {provider.capabilities?.instruments && (
                    <div className="flex items-start gap-3">
                      <Icons.TrendingUp className="text-muted-foreground mt-0.5 h-4 w-4" />
                      <div>
                        <p className="text-xs font-medium">
                          {t("settings:market_data_page.instruments")}
                        </p>
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
                        <p className="text-xs font-medium">
                          {t("settings:market_data_page.coverage")}
                        </p>
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
                        <p className="text-xs font-medium">
                          {t("settings:market_data_page.features")}
                        </p>
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
                        <p className="text-xs font-medium">
                          {t("settings:market_data_page.website")}
                        </p>
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
                  {t("settings:market_data_page.settings")}
                </h4>
                <div className="space-y-4">
                  {provider.requiresApiKey && (
                    <div className="space-y-2">
                      <Label htmlFor={`apikey-${provider.id}`} className="text-xs font-medium">
                        {t("settings:market_data_page.api_key")}
                      </Label>
                      <div className="flex items-center gap-2">
                        <Input
                          id={`apikey-${provider.id}`}
                          type={showApiKey ? "text" : "password"}
                          value={
                            hasLoadedKey || apiKeyValue
                              ? apiKeyValue
                              : provider.hasApiKey
                                ? "••••••••••••••••••••••••"
                                : ""
                          }
                          onChange={(e) => setApiKeyValue(e.target.value)}
                          placeholder={
                            provider.hasApiKey
                              ? ""
                              : t("settings:market_data_page.api_key_placeholder")
                          }
                          className="grow font-mono text-xs"
                          readOnly={!hasLoadedKey && provider.hasApiKey}
                        />
                        <Button
                          variant="outline"
                          size="icon"
                          className="h-8 w-8"
                          onClick={handleRevealApiKey}
                          disabled={isLoadingKey}
                          aria-label={
                            showApiKey
                              ? t("settings:market_data_page.hide_api_key")
                              : t("settings:market_data_page.show_api_key")
                          }
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
                          {t("settings:common_save")}
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-3">
                    <Label className="text-xs font-medium">
                      {t("settings:market_data_page.priority")}
                    </Label>
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
                      {t("settings:market_data_page.priority_hint")}
                    </span>
                  </div>

                  {/* Sync Status */}
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">
                      {t("settings:market_data_page.sync_status")}
                    </Label>
                    {provider.errorCount > 0 ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Icons.XCircle className="h-4 w-4 text-red-500" />
                          <span className="text-xs font-medium text-red-500">
                            {t("settings:market_data_page.assets_with_errors", {
                              count: provider.errorCount,
                            })}
                          </span>
                        </div>
                        {provider.lastSyncError && (
                          <p className="bg-destructive/10 text-destructive rounded-md p-2 text-xs">
                            {provider.lastSyncError}
                          </p>
                        )}
                        {provider.lastSyncedAt && (
                          <p className="text-muted-foreground text-xs">
                            {t("settings:market_data_page.last_sync", {
                              date: formatting.formatDateTime(provider.lastSyncedAt),
                            })}
                          </p>
                        )}
                      </div>
                    ) : provider.assetCount === 0 ? (
                      <div className="flex items-center gap-2">
                        <Icons.MinusCircle className="text-muted-foreground h-4 w-4" />
                        <span className="text-muted-foreground text-xs">
                          {t("settings:market_data_page.no_assets_using_provider")}
                        </span>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <Icons.CheckCircle className="h-4 w-4 text-green-500" />
                        <span className="text-muted-foreground text-xs">
                          {provider.lastSyncedAt
                            ? t("settings:market_data_page.last_sync", {
                                date: formatting.formatDateTime(provider.lastSyncedAt),
                              })
                            : t("settings:market_data_page.pending_sync")}
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
  usage,
  onEdit,
  onDelete,
  onToggleEnabled,
  isDeleting = false,
  isToggling = false,
  isLast = false,
}: {
  provider: CustomProviderWithSources;
  usage: CustomProviderUsage;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  isDeleting?: boolean;
  isToggling?: boolean;
  isLast?: boolean;
}) {
  const { t } = useTranslation();
  const latestSource = provider.sources.find((s) => s.kind === "latest");
  const historicalSource = provider.sources.find((s) => s.kind === "historical");
  const usedBy = usageCount(usage);

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
                {t("settings:market_data_page.disabled")}
              </Badge>
            )}
            {servesAsFallback(provider) && (
              <Badge
                variant="outline"
                className="border-warning/40 text-warning h-5 px-1.5 text-[10px] font-normal"
                title={t("settings:market_data_page.fallback_badge_hint")}
              >
                {t("settings:market_data_page.fallback_badge")}
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
                {t("settings:market_data_page.historical")}
              </span>
            )}
            {usedBy > 0 && (
              <span className="text-muted-foreground text-[11px]">
                {t("settings:market_data_page.custom_used_by", { count: usedBy })}
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
          {deleteBlockerCount(usage) > 0 ? (
            // The backend refuses to delete a provider securities still use; say which.
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive h-8 w-8"
                  aria-label={t("settings:common_delete")}
                >
                  <Icons.Trash className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80 space-y-3" align="end">
                <h4 className="font-medium leading-none">
                  {t("settings:market_data_page.delete_provider_in_use_title", {
                    name: provider.name,
                  })}
                </h4>
                {/* Changing a security's provider keeps its symbol mappings, so each group
                    needs its own instruction. */}
                {usage.assigned.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-muted-foreground text-sm">
                      {t("settings:market_data_page.delete_provider_in_use_assigned", {
                        count: usage.assigned.length,
                      })}
                    </p>
                    <CustomProviderUsageChips assets={usage.assigned} linkable />
                  </div>
                )}
                {usage.mappedOnly.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-muted-foreground text-sm">
                      {t("settings:market_data_page.delete_provider_in_use_mapped", {
                        count: usage.mappedOnly.length,
                      })}
                    </p>
                    <CustomProviderUsageChips assets={usage.mappedOnly} linkable />
                  </div>
                )}
                {usage.leftover.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-muted-foreground text-sm">
                      {t("settings:market_data_page.delete_provider_in_use_leftover", {
                        count: usage.leftover.length,
                      })}
                    </p>
                    <CustomProviderUsageChips assets={usage.leftover} linkable />
                  </div>
                )}
              </PopoverContent>
            </Popover>
          ) : (
            <ActionConfirm
              handleConfirm={onDelete}
              isPending={isDeleting}
              confirmTitle={t("settings:market_data_page.delete_provider_title")}
              confirmMessage={t("settings:market_data_page.delete_provider_message", {
                name: provider.name,
              })}
              confirmButtonText={t("settings:common_delete")}
              cancelButtonText={t("settings:common_cancel")}
              confirmButtonVariant="destructive"
              button={
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive h-8 w-8"
                  aria-label={t("settings:common_delete")}
                >
                  <Icons.Trash className="h-4 w-4" />
                </Button>
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

function HistoryMenuItem({
  icon,
  title,
  description,
  ...props
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
} & React.ComponentProps<typeof DropdownMenuItem>) {
  return (
    <DropdownMenuItem className="items-start gap-3 py-2" {...props}>
      <span className="mt-0.5">{icon}</span>
      <span className="min-w-0">
        <span className="block font-medium">{title}</span>
        <span className="text-muted-foreground block text-xs">{description}</span>
      </span>
    </DropdownMenuItem>
  );
}

export default function MarketDataSettingsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { data: providers, isLoading, error } = useMarketDataProviderSettings();
  const { mutate: updateSettings } = useUpdateMarketDataProviderSettings();
  const { mutate: updatePortfolio, isPending: isUpdating } = useUpdatePortfolioMutation();
  const { mutate: recalculatePortfolio, isPending: isRecalculating } =
    useRecalculatePortfolioMutation();
  const { data: customProviders = [] } = useCustomProviders();
  // Unfiltered: exchange rates can use custom providers too.
  const { data: assets = [] } = useQuery<Asset[], Error>({
    queryKey: [QueryKeys.ASSETS],
    queryFn: getAssets,
  });
  const usageByProvider = useMemo(
    () => new Map(customProviders.map((cp) => [cp.id, getCustomProviderUsage(assets, cp.id)])),
    [customProviders, assets],
  );
  const { mutate: deleteCustomProvider } = useDeleteCustomProvider();
  const { mutate: updateCustomProvider } = useUpdateCustomProvider();

  const [priorityInputs, setPriorityInputs] = useState<Record<string, number>>({});
  const [resetHistoryOpen, setResetHistoryOpen] = useState(false);
  const [rebuildConfirmOpen, setRebuildConfirmOpen] = useState(false);
  const [providersTab, setProvidersTab] = useState("builtin");
  const [customFormOpen, setCustomFormOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<CustomProviderWithSources | undefined>();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const showHealthBanner = searchParams.get("healthContext") === "marketData";

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
        <SettingsHeader
          heading={t("settings:market_data_page.heading")}
          text={t("settings:market_data_page.subtitle")}
        />
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
        <SettingsHeader
          heading={t("settings:market_data_page.heading")}
          text={t("settings:market_data_page.subtitle")}
        />
        <Separator />
        <div className="border-destructive/20 bg-destructive/5 rounded-lg border p-6">
          <div className="flex items-start gap-3">
            <Icons.XCircle className="text-destructive mt-0.5 h-5 w-5 shrink-0" />
            <div className="space-y-2">
              <h3 className="text-destructive font-medium">
                {t("settings:market_data_page.load_error_title")}
              </h3>
              <p className="text-muted-foreground text-sm">{error.message}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.location.reload()}
                className="mt-2"
              >
                <Icons.Refresh className="mr-2 h-4 w-4" />
                {t("settings:market_data_page.retry")}
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
        heading={t("settings:market_data_page.heading")}
        text={t("settings:market_data_page.subtitle")}
        actionsInline
      >
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-10 w-10 px-0 sm:h-9 sm:w-auto sm:px-3"
                aria-label={t("settings:market_data_page.history_menu")}
              >
                {isRecalculating ? (
                  <Icons.Spinner className="h-4 w-4 animate-spin" />
                ) : (
                  <Icons.History className="h-4 w-4" />
                )}
                <span className="hidden sm:inline">
                  {t("settings:market_data_page.history_menu")}
                </span>
                <Icons.ChevronDown className="hidden h-4 w-4 sm:block" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              <HistoryMenuItem
                icon={<Icons.Clock />}
                title={t(
                  isRecalculating
                    ? "settings:market_data_page.rebuild_pending"
                    : "settings:market_data_page.rebuild_history",
                )}
                description={t("settings:market_data_page.rebuild_history_description")}
                disabled={isRecalculating}
                onSelect={() => setRebuildConfirmOpen(true)}
              />
              <HistoryMenuItem
                icon={<Icons.Import />}
                title={t("settings:market_data_page.import_prices_csv")}
                description={t("settings:market_data_page.import_prices_csv_description")}
                onSelect={() => navigate("/settings/market-data/import")}
              />
              <DropdownMenuSeparator />
              <HistoryMenuItem
                variant="destructive"
                icon={<Icons.RotateCcw />}
                title={t("settings:market_data_page.reset_history_menu")}
                description={t("settings:market_data_page.reset_history_description")}
                onSelect={() => setResetHistoryOpen(true)}
              />
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="icon"
            className="sm:hidden"
            disabled={isUpdating}
            onClick={() => updatePortfolio()}
            aria-label={t("settings:market_data_page.update_aria")}
          >
            {isUpdating ? (
              <Icons.Spinner className="h-4 w-4 animate-spin" />
            ) : (
              <Icons.Refresh className="h-4 w-4" />
            )}
          </Button>

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
            {t("settings:market_data_page.update")}
          </Button>
        </div>
      </SettingsHeader>
      <ResetProviderHistoryDialog
        allAssets
        open={resetHistoryOpen}
        onOpenChange={setResetHistoryOpen}
      />
      <AlertDialog open={rebuildConfirmOpen} onOpenChange={setRebuildConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings:market_data_page.rebuild_confirm_title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:market_data_page.rebuild_confirm_message")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("settings:common_cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => recalculatePortfolio()}>
              {t("settings:market_data_page.rebuild_confirm_button")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Separator />
      {showHealthBanner && (
        <div className="border-border bg-muted/30 flex items-center justify-between gap-3 rounded-md border px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <Icons.Info className="text-muted-foreground h-4 w-4 shrink-0" />
            <p className="text-sm">{t("settings:health_banner_market_data")}</p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              setSearchParams(
                (prev) => {
                  const next = new URLSearchParams(prev);
                  next.delete("healthContext");
                  return next;
                },
                { replace: true },
              )
            }
          >
            {t("settings:health_banner_clear")}
          </Button>
        </div>
      )}

      <Tabs value={providersTab} onValueChange={setProvidersTab} className="w-full">
        {/* Narrow screens wrap the button below the tabs so their labels keep full width. */}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <TabsList className="grid w-full grid-cols-2 sm:w-auto sm:flex-1">
            <TabsTrigger value="builtin">
              {t("settings:market_data_page.tab_builtin")}
              {builtinProviders.filter((p) => p.enabled).length > 0 && (
                <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 text-[10px] font-normal">
                  {builtinProviders.filter((p) => p.enabled).length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="custom">
              {t("settings:market_data_page.tab_custom")}
              {customProviders.filter((p) => p.enabled).length > 0 && (
                <Badge variant="secondary" className="ml-1.5 h-5 px-1.5 text-[10px] font-normal">
                  {customProviders.filter((p) => p.enabled).length}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              // Show the custom list, where the new provider will appear.
              setProvidersTab("custom");
              setEditingProvider(undefined);
              setCustomFormOpen(true);
            }}
          >
            <Icons.Plus className="h-4 w-4" />
            {t("settings:market_data_page.add_provider")}
          </Button>
        </div>

        <TabsContent value="builtin" className="mt-4">
          {builtinProviders.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("settings:market_data_page.no_builtin")}
            </p>
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
          {customScraperErrors && customScraperErrors.errorCount > 0 && (
            <div className="border-destructive/20 bg-destructive/5 mb-3 rounded-lg border p-3">
              <div className="flex items-start gap-2">
                <Icons.XCircle className="text-destructive mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0">
                  <p className="text-destructive text-sm font-medium">
                    {t("settings:market_data_page.assets_failed_to_sync", {
                      count: customScraperErrors.errorCount,
                    })}
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
              <p className="text-muted-foreground mt-2 text-sm">
                {t("settings:market_data_page.custom_empty_title")}
              </p>
              <p className="text-muted-foreground text-xs">
                {t("settings:market_data_page.custom_empty_description")}
              </p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              {customProviders.map((cp, index) => (
                <CustomProviderCard
                  key={cp.id}
                  provider={cp}
                  usage={usageByProvider.get(cp.id) ?? EMPTY_USAGE}
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
        usage={editingProvider ? usageByProvider.get(editingProvider.id) : undefined}
      />
    </div>
  );
}
