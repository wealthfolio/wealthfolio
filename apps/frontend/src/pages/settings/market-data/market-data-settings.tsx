import {
  getProviderDescription,
  getProviderCoverage,
  getProviderName,
  getProviderInstruments,
} from "@/lib/provider-labels";
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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@wealthfolio/ui/components/ui/card";
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
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";

import { ResetProviderHistoryDialog } from "@/pages/asset/reset-provider-history-dialog";

import { SettingsList, SettingsListMedia, SettingsListRow } from "@/components/settings-list";
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
import { cn } from "@/lib/utils";
import type { Asset } from "@/lib/types";
import type { CustomProviderWithSources } from "@/lib/types/custom-provider";
import { ActionConfirm, useDateFormatting, Spinner } from "@wealthfolio/ui";
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
import { ProviderCatalogDialog } from "./provider-catalog-dialog";
import { ProviderLogo } from "./provider-logo";
import { moveProvider } from "./provider-order";
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
import { Alert, AlertDescription, AlertTitle } from "@wealthfolio/ui/components/ui/alert";

interface ProviderSettingsProps {
  provider: MarketDataProviderSetting;
  /** Position in the fetch order, from 1; none while the provider is off. */
  rank?: number;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (step: -1 | 1) => void;
  onEnabledChange: (enabled: boolean) => void;
  /** Opens the details on mount, e.g. for a provider just added that still needs a key. */
  defaultOpen?: boolean;
}

function ProviderSettings({
  provider,
  rank,
  canMoveUp,
  canMoveDown,
  onMove,
  onEnabledChange,
  defaultOpen = false,
}: ProviderSettingsProps) {
  const formatting = useDateFormatting();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const name = getProviderName(t, provider.id, provider.name);
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
    if (normalized === "dividends")
      return { icon: null, label: t("settings:market_data_page.feature_dividends") };
    if (normalized === "no api key")
      return { icon: null, label: t("settings:market_data_page.feature_no_api_key") };
    return { icon: null, label: feature };
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div>
        <SettingsListRow
          media={
            <div className="flex items-center gap-2">
              <span
                aria-hidden
                className="text-muted-foreground w-4 text-center text-xs tabular-nums max-sm:hidden"
              >
                {rank}
              </span>
              <ProviderLogo logoFilename={provider.logoFilename} />
            </div>
          }
          title={name}
          inactive={!provider.enabled}
          badges={
            <>
              {provider.capabilities?.coverage && (
                <Badge variant="secondary">
                  {getProviderCoverage(t, provider.capabilities.coverage)}
                </Badge>
              )}
              {provider.enabled && provider.requiresApiKey && !provider.hasApiKey && (
                <Badge variant="warning-subtle" className="shrink-0">
                  <Icons.AlertTriangle className="me-1 h-3 w-3" />
                  {t("settings:market_data_page.api_key_required")}
                </Badge>
              )}
              {provider.assetCount > 0 && (
                <Badge variant="secondary">
                  {t("settings:market_data_page.assets_count", { count: provider.assetCount })}
                </Badge>
              )}
              {provider.errorCount > 0 && (
                <Popover>
                  <PopoverTrigger
                    nativeButton={false}
                    render={
                      <Badge
                        variant="destructive-subtle"
                        className="hover:bg-destructive-subtle/70 shrink-0 cursor-pointer"
                      />
                    }
                  >
                    <Icons.XCircle className="me-1 h-3 w-3" />
                    {t("settings:market_data_page.errors_count", { count: provider.errorCount })}
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
                              className="bg-destructive-subtle text-destructive-subtle-foreground rounded-md p-2 text-xs break-words"
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
            </>
          }
          meta={
            provider.capabilities?.instruments
              ? getProviderInstruments(t, provider.capabilities.instruments)
              : undefined
          }
          actions={
            <>
              {/* Phones stack the arrows so the name keeps room. */}
              <div className="flex items-center gap-2 max-sm:flex-col max-sm:gap-0">
                <Button
                  variant="ghost"
                  size="icon"
                  // A provider that's off keeps its place but has no rank to move.
                  className={cn(
                    "text-muted-foreground hover:text-foreground h-8 w-8 max-sm:h-6",
                    !provider.enabled && "invisible",
                  )}
                  disabled={!canMoveUp}
                  onClick={() => onMove(-1)}
                  aria-label={t("settings:market_data_page.move_up", { name })}
                >
                  <Icons.ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "text-muted-foreground hover:text-foreground h-8 w-8 max-sm:h-6",
                    !provider.enabled && "invisible",
                  )}
                  disabled={!canMoveDown}
                  onClick={() => onMove(1)}
                  aria-label={t("settings:market_data_page.move_down", { name })}
                >
                  <Icons.ArrowDown className="h-4 w-4" />
                </Button>
              </div>
              <CollapsibleTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-foreground h-8 w-8"
                    aria-label={t("common:settings_for", { name })}
                  />
                }
              >
                <Icons.Settings className="h-4 w-4" />
              </CollapsibleTrigger>
              <Switch
                id={`${provider.id}-enabled`}
                aria-label={name}
                checked={provider.enabled}
                onCheckedChange={onEnabledChange}
              />
            </>
          }
        />

        {/* Expandable settings */}
        <CollapsibleContent>
          <div className="mt-3 border-t pt-4">
            <div className="grid gap-6 md:grid-cols-2">
              {/* Left column - Capabilities */}
              <div className="space-y-4">
                <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {t("settings:market_data_page.capabilities")}
                </h4>
                {provider.description && (
                  <p className="text-muted-foreground text-xs">
                    {getProviderDescription(t, provider.id, provider.description)}
                  </p>
                )}
                <div className="space-y-3">
                  {provider.capabilities?.instruments && (
                    <div className="flex items-start gap-3">
                      <Icons.TrendingUp className="text-muted-foreground mt-0.5 h-4 w-4" />
                      <div>
                        <p className="text-xs font-medium">
                          {t("settings:market_data_page.instruments")}
                        </p>
                        <p className="text-muted-foreground text-xs">
                          {getProviderInstruments(t, provider.capabilities.instruments)}
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
                          {getProviderCoverage(t, provider.capabilities.coverage)}
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
                          {provider.capabilities.features.map((feature) => {
                            const { icon, label } = getFeatureDisplay(feature);
                            return (
                              <Badge
                                key={feature}
                                variant="secondary"
                                className="text-2xs h-5 gap-1 px-1.5 font-normal"
                              >
                                {icon}
                                {label}
                              </Badge>
                            );
                          })}
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
                <h4 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {t("common:settings")}
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
                            <Spinner className="h-3.5 w-3.5" />
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
                          {t("common:save")}
                        </Button>
                      </div>
                    </div>
                  )}

                  {/* Sync Status */}
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">
                      {t("settings:market_data_page.sync_status")}
                    </Label>
                    {provider.errorCount > 0 ? (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Icons.XCircle className="text-destructive h-4 w-4" />
                          <span className="text-destructive text-xs font-medium">
                            {t("settings:market_data_page.assets_with_errors", {
                              count: provider.errorCount,
                            })}
                          </span>
                        </div>
                        {provider.lastSyncError && (
                          <p className="bg-destructive-subtle text-destructive-subtle-foreground rounded-md p-2 text-xs break-words">
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
                        <Icons.CheckCircle className="text-success h-4 w-4" />
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
}: {
  provider: CustomProviderWithSources;
  usage: CustomProviderUsage;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  isDeleting?: boolean;
  isToggling?: boolean;
}) {
  const { t } = useTranslation();
  const latestSource = provider.sources.find((s) => s.kind === "latest");
  const historicalSource = provider.sources.find((s) => s.kind === "historical");
  const usedBy = usageCount(usage);

  return (
    <div>
      <SettingsListRow
        media={
          <SettingsListMedia>
            <Icons.Globe />
          </SettingsListMedia>
        }
        title={provider.name}
        badges={
          <>
            {!provider.enabled && (
              <Badge variant="secondary">{t("settings:market_data_page.disabled")}</Badge>
            )}
            {servesAsFallback(provider) && (
              <Badge
                variant="warning-subtle"
                title={t("settings:market_data_page.fallback_badge_hint")}
              >
                {t("settings:market_data_page.fallback_badge")}
              </Badge>
            )}
          </>
        }
        meta={provider.description}
        actions={
          <>
            <Switch
              id={`${provider.id}-enabled`}
              aria-label={provider.name}
              checked={provider.enabled}
              onCheckedChange={onToggleEnabled}
              disabled={isToggling}
            />
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground h-8 w-8"
              onClick={onEdit}
              aria-label={t("settings:market_data_page.edit_custom_provider")}
            >
              <Icons.Pencil className="h-4 w-4" />
            </Button>
            {deleteBlockerCount(usage) > 0 ? (
              // The backend refuses to delete a provider securities still use; say which.
              <Popover>
                <PopoverTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground hover:text-destructive h-8 w-8"
                      aria-label={t("common:delete")}
                    />
                  }
                >
                  <Icons.Trash className="h-4 w-4" />
                </PopoverTrigger>
                <PopoverContent className="w-80 space-y-3" align="end">
                  <h4 className="leading-none font-medium">
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
                confirmButtonText={t("common:delete")}
                cancelButtonText={t("common:cancel")}
                confirmButtonVariant="destructive"
                button={
                  <Button
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-destructive h-8 w-8"
                    aria-label={t("common:delete")}
                  >
                    <Icons.Trash className="h-4 w-4" />
                  </Button>
                }
              />
            )}
          </>
        }
      >
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {latestSource && (
            <span className="text-muted-foreground text-2xs inline-flex items-center gap-1">
              <Icons.Activity2 className="h-3 w-3" />
              {latestSource.format.toUpperCase()}
            </span>
          )}
          {historicalSource && (
            <span className="text-muted-foreground text-2xs inline-flex items-center gap-1">
              <Icons.Clock className="h-3 w-3" />
              {t("settings:market_data_page.historical")}
            </span>
          )}
          {usedBy > 0 && (
            <span className="text-muted-foreground text-2xs">
              {t("settings:market_data_page.custom_used_by", { count: usedBy })}
            </span>
          )}
        </div>
      </SettingsListRow>
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
  const queryClient = useQueryClient();
  const { data: providers, isLoading, error } = useMarketDataProviderSettings();
  const { mutate: updateSettings, mutateAsync: updateSettingsAsync } =
    useUpdateMarketDataProviderSettings();
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
  // Each card's busy state comes from its mutation, which knows when it ends
  // even if that happened while the screen was out of sight.
  const deleteProvider = useDeleteCustomProvider();
  const toggleProvider = useUpdateCustomProvider();

  const [resetHistoryOpen, setResetHistoryOpen] = useState(false);
  const [rebuildConfirmOpen, setRebuildConfirmOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  // A provider just added that still needs an API key opens its settings.
  const [expandProviderId, setExpandProviderId] = useState<string>();
  // Providers switched off on this visit stay listed, dimmed, so the switch can be flipped back.
  const [switchedOffIds, setSwitchedOffIds] = useState<string[]>([]);
  const [customFormOpen, setCustomFormOpen] = useState(false);
  const [editingProvider, setEditingProvider] = useState<CustomProviderWithSources | undefined>();
  const showHealthBanner = searchParams.get("healthContext") === "marketData";

  // Providers that are on are listed in fetch order; the rest wait in the catalog.
  // CUSTOM_SCRAPER only carries the custom providers' sync errors.
  const { listedProviders, activeProviders, availableProviders, customScraperErrors } =
    useMemo(() => {
      const listed: MarketDataProviderSetting[] = [];
      const available: MarketDataProviderSetting[] = [];
      let scraperInfo: MarketDataProviderSetting | undefined;
      for (const p of providers ?? []) {
        if (p.id === "CUSTOM_SCRAPER") {
          scraperInfo = p;
        } else if (p.enabled || switchedOffIds.includes(p.id)) {
          listed.push(p);
        } else {
          available.push(p);
        }
      }
      listed.sort((a, b) => a.priority - b.priority);
      return {
        listedProviders: listed,
        activeProviders: listed.filter((p) => p.enabled),
        availableProviders: available,
        customScraperErrors: scraperInfo,
      };
    }, [providers, switchedOffIds]);

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

  // One write at a time, since each one rebuilds the market data client. If a write
  // fails, the ones this move already saved are put back. A failed write, the undo
  // included, shows its error and reloads the saved settings (see the mutation hook).
  const handleMove = async (index: number, step: -1 | 1) => {
    const original = new Map(activeProviders.map((p) => [p.id, p.priority]));
    const saved: string[] = [];
    const write = (providerId: string, priority: number) => {
      // Send the provider's on/off state as it is now: it can be switched mid-move.
      const current = queryClient
        .getQueryData<MarketDataProviderSetting[]>([QueryKeys.MARKET_DATA_PROVIDER_SETTINGS])
        ?.find((p) => p.id === providerId);
      return updateSettingsAsync({ providerId, priority, enabled: current?.enabled ?? true });
    };
    for (const change of moveProvider(activeProviders, index, step)) {
      try {
        await write(change.id, change.priority);
        saved.push(change.id);
      } catch {
        // The failed write has already rolled back and shown its error.
        for (const id of saved.reverse()) {
          const priority = original.get(id);
          if (priority !== undefined) await write(id, priority).catch(() => undefined);
        }
        return;
      }
    }
  };

  const handleEnabledChange = (providerId: string, enabled: boolean) => {
    handleUpdateSetting(providerId, { enabled });
    setSwitchedOffIds((ids) =>
      enabled ? ids.filter((id) => id !== providerId) : [...ids, providerId],
    );
  };

  const handleAddProvider = (provider: MarketDataProviderSetting) => {
    handleUpdateSetting(provider.id, { enabled: true });
    setCatalogOpen(false);
    if (provider.requiresApiKey && !provider.hasApiKey) {
      setExpandProviderId(provider.id);
    }
  };

  if (isLoading) {
    return (
      <div className="text-foreground space-y-6">
        <SettingsHeader
          heading={t("settings:nav.items.market_data")}
          text={t("settings:market_data_page.subtitle")}
        />
        <Separator />
        <Card>
          <CardContent className="pt-6">
            <ul
              className="divide-y [&>li]:py-3 [&>li:first-child]:pt-0 [&>li:last-child]:pb-0"
              aria-hidden
            >
              {[1, 2, 3, 4].map((i) => (
                <li key={i} className="flex items-center gap-3">
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
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-foreground space-y-6">
        <SettingsHeader
          heading={t("settings:nav.items.market_data")}
          text={t("settings:market_data_page.subtitle")}
        />
        <Separator />
        <Alert variant="destructive" className="p-6">
          <Icons.XCircle className="size-5" />
          <AlertTitle role="heading" aria-level={3}>
            {t("settings:market_data_page.load_error_title")}
          </AlertTitle>
          <AlertDescription>
            {error.message}
            <div className="mt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.location.reload()}
                className="text-foreground"
              >
                <Icons.Refresh className="me-2 h-4 w-4" />
                {t("common:retry")}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="text-foreground space-y-6">
      <SettingsHeader
        heading={t("settings:nav.items.market_data")}
        text={t("settings:market_data_page.subtitle")}
        actionsInline
      >
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="outline"
                  size="sm"
                  className="h-10 w-10 px-0 sm:h-9 sm:w-auto sm:px-3"
                  aria-label={t("settings:market_data_page.history_menu")}
                />
              }
            >
              {isRecalculating ? (
                <Spinner className="h-4 w-4" />
              ) : (
                <Icons.History className="h-4 w-4" />
              )}
              <span className="hidden sm:inline">
                {t("settings:market_data_page.history_menu")}
              </span>
              <Icons.ChevronDown className="hidden h-4 w-4 sm:block" />
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
                onClick={() => setRebuildConfirmOpen(true)}
              />
              <HistoryMenuItem
                icon={<Icons.Import />}
                title={t("settings:market_data_page.import_prices_csv")}
                description={t("settings:market_data_page.import_prices_csv_description")}
                onClick={() => navigate("/settings/market-data/import")}
              />
              <DropdownMenuSeparator />
              <HistoryMenuItem
                variant="destructive"
                icon={<Icons.RotateCcw />}
                title={t("settings:market_data_page.reset_history_menu")}
                description={t("settings:market_data_page.reset_history_description")}
                onClick={() => setResetHistoryOpen(true)}
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
            {isUpdating ? <Spinner className="h-4 w-4" /> : <Icons.Refresh className="h-4 w-4" />}
          </Button>

          <Button
            size="sm"
            className="hidden sm:inline-flex"
            disabled={isUpdating}
            onClick={() => updatePortfolio()}
          >
            {isUpdating ? (
              <Spinner className="me-2 h-4 w-4" />
            ) : (
              <Icons.Refresh className="me-2 h-4 w-4" />
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
            <AlertDialogCancel>{t("common:cancel")}</AlertDialogCancel>
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
            {t("common:clear")}
          </Button>
        </div>
      )}

      <Card>
        <CardHeader className="max-sm:has-data-[slot=card-action]:grid-cols-1">
          <CardTitle role="heading" aria-level={2} className="text-lg">
            {t("settings:market_data_page.tab_builtin")}
          </CardTitle>
          <CardDescription>{t("settings:market_data_page.sources_description")}</CardDescription>
          <CardAction className="max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:justify-self-stretch max-sm:pt-1.5">
            <Button
              variant="outline"
              size="sm"
              className="max-sm:w-full"
              onClick={() => setCatalogOpen(true)}
            >
              <Icons.Plus className="h-4 w-4" />
              {t("settings:market_data_page.add_provider")}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {listedProviders.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("settings:market_data_page.sources_empty")}
            </p>
          ) : (
            <SettingsList label={t("settings:market_data_page.tab_builtin")}>
              {listedProviders.map((provider) => {
                const index = activeProviders.indexOf(provider);
                return (
                  <li key={provider.id}>
                    <ProviderSettings
                      provider={provider}
                      rank={provider.enabled ? index + 1 : undefined}
                      canMoveUp={provider.enabled && index > 0}
                      canMoveDown={provider.enabled && index < activeProviders.length - 1}
                      onMove={(step) => void handleMove(index, step)}
                      onEnabledChange={(enabled) => handleEnabledChange(provider.id, enabled)}
                      defaultOpen={provider.id === expandProviderId}
                    />
                  </li>
                );
              })}
            </SettingsList>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="max-sm:has-data-[slot=card-action]:grid-cols-1">
          <CardTitle role="heading" aria-level={2} className="text-lg">
            {t("settings:market_data_page.tab_custom")}
          </CardTitle>
          <CardAction className="max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:justify-self-stretch max-sm:pt-1.5">
            <Button
              variant="outline"
              size="sm"
              className="max-sm:w-full"
              onClick={() => {
                setEditingProvider(undefined);
                setCustomFormOpen(true);
              }}
            >
              <Icons.Plus className="h-4 w-4" />
              {t("settings:market_data_page.add_custom_provider")}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          {customScraperErrors && customScraperErrors.errorCount > 0 && (
            <Alert variant="destructive" className="mb-3 p-3">
              <Icons.XCircle />
              <AlertTitle>
                {t("settings:market_data_page.assets_failed_to_sync", {
                  count: customScraperErrors.errorCount,
                })}
              </AlertTitle>
              <AlertDescription className="min-w-0">
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
                    <p key={i} className="mt-1 text-xs break-all">
                      {providerLabel && <span className="font-medium">{providerLabel}: </span>}
                      {msg}
                    </p>
                  );
                })}
              </AlertDescription>
            </Alert>
          )}
          {customProviders.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t("settings:market_data_page.custom_empty_description")}
            </p>
          ) : (
            <SettingsList label={t("settings:market_data_page.tab_custom")}>
              {customProviders.map((cp) => (
                <li key={cp.id}>
                  <CustomProviderCard
                    provider={cp}
                    usage={usageByProvider.get(cp.id) ?? EMPTY_USAGE}
                    onEdit={() => {
                      setEditingProvider(cp);
                      setCustomFormOpen(true);
                    }}
                    onDelete={() => deleteProvider.mutate(cp.id)}
                    onToggleEnabled={(enabled) =>
                      toggleProvider.mutate({ providerId: cp.id, payload: { enabled } })
                    }
                    isDeleting={deleteProvider.isPending && deleteProvider.variables === cp.id}
                    isToggling={
                      toggleProvider.isPending && toggleProvider.variables?.providerId === cp.id
                    }
                  />
                </li>
              ))}
            </SettingsList>
          )}
        </CardContent>
      </Card>

      <ProviderCatalogDialog
        open={catalogOpen}
        onOpenChange={setCatalogOpen}
        providers={availableProviders}
        onAdd={handleAddProvider}
      />

      <CustomProviderForm
        open={customFormOpen}
        onOpenChange={setCustomFormOpen}
        provider={editingProvider}
        usage={editingProvider ? usageByProvider.get(editingProvider.id) : undefined}
      />
    </div>
  );
}
