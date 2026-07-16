import { useState, useMemo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "@/components/external-link";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { Label } from "@wealthfolio/ui/components/ui/label";
import { Switch } from "@wealthfolio/ui/components/ui/switch";
import { Checkbox } from "@wealthfolio/ui/components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@wealthfolio/ui/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@wealthfolio/ui/components/ui/command";
import { cn } from "@/lib/utils";
import type {
  MergedProvider,
  MergedModel,
  FetchedModel,
  ModelCapabilityOverrides,
  ProviderTuning,
  ProviderTuningOverrides,
} from "../types";
import type { ConnectionField } from "@/lib/types";
import { ProviderIcon } from "./provider-icons";

interface ProviderSettingsCardProps {
  provider: MergedProvider;
  onToggleEnabled: (enabled: boolean) => void;
  onSetDefault: () => void;
  onSaveApiKey: (apiKey: string) => void;
  onDeleteApiKey: () => void;
  onRevealApiKey: () => Promise<string | null>;
  onCustomUrlChange?: (url: string) => void;
  /** @deprecated Use onSetFavoriteModels instead for multi-select */
  onSelectModel?: (modelId: string) => void;
  onSetFavoriteModels?: (modelIds: string[]) => void;
  onSetCapabilityOverride?: (modelId: string, overrides: ModelCapabilityOverrides | null) => void;
  onToolsAllowlistChange?: (tools: string[] | null) => void;
  /**
   * Persist tuning overrides. Pass `null` to clear (reset to catalog defaults),
   * or a partial object to set/update individual fields.
   */
  onTuningOverridesChange?: (overrides: ProviderTuningOverrides | null) => void;
  isLast?: boolean;
  // Model fetching props (controlled by parent via React Query)
  modelComboboxOpen?: boolean;
  onModelComboboxOpenChange?: (open: boolean) => void;
  fetchedModels?: FetchedModel[];
  isFetchingModels?: boolean;
  fetchModelsError?: string | null;
  onRefreshModels?: () => void;
}

// Novice-friendly tool mapping for data access settings.
// Each card can represent multiple backend tools that belong to the same user capability.
const DATA_ACCESS_OPTIONS = [
  {
    toolIds: ["get_accounts", "get_cash_balances", "get_portfolios"],
    labelKey: "ai:providerSettings.dataAccess.accountsLabel",
    descriptionKey: "ai:providerSettings.dataAccess.accountsDescription",
  },
  {
    toolIds: ["get_holdings", "get_net_worth"],
    labelKey: "ai:providerSettings.dataAccess.holdingsLabel",
    descriptionKey: "ai:providerSettings.dataAccess.holdingsDescription",
  },
  {
    toolIds: [
      "search_activities",
      "record_activity",
      "record_activities",
      "import_csv",
      "propose_transaction_categories",
      "list_categorization_context",
      "create_categorization_rule",
    ],
    labelKey: "ai:providerSettings.dataAccess.transactionsLabel",
    descriptionKey: "ai:providerSettings.dataAccess.transactionsDescription",
  },
  {
    toolIds: ["get_performance"],
    labelKey: "ai:providerSettings.dataAccess.performanceLabel",
    descriptionKey: "ai:providerSettings.dataAccess.performanceDescription",
  },
  {
    toolIds: ["get_income"],
    labelKey: "ai:providerSettings.dataAccess.incomeLabel",
    descriptionKey: "ai:providerSettings.dataAccess.incomeDescription",
  },
  {
    toolIds: ["get_goals", "get_contribution_limits"],
    labelKey: "ai:providerSettings.dataAccess.goalsLabel",
    descriptionKey: "ai:providerSettings.dataAccess.goalsDescription",
  },
  {
    toolIds: ["get_asset_allocation"],
    labelKey: "ai:providerSettings.dataAccess.allocationLabel",
    descriptionKey: "ai:providerSettings.dataAccess.allocationDescription",
  },
  {
    toolIds: [
      "list_asset_taxonomies",
      "get_asset_taxonomy_assignments",
      "prepare_asset_classification",
    ],
    labelKey: "ai:providerSettings.dataAccess.classificationsLabel",
    descriptionKey: "ai:providerSettings.dataAccess.classificationsDescription",
  },
  {
    toolIds: ["get_valuation_history"],
    labelKey: "ai:providerSettings.dataAccess.historyLabel",
    descriptionKey: "ai:providerSettings.dataAccess.historyDescription",
  },
];

const HIDDEN_DEFAULT_TOOL_IDS = ["get_health_status"];
const ALL_DATA_ACCESS_TOOL_IDS = [
  ...DATA_ACCESS_OPTIONS.flatMap((option) => option.toolIds),
  ...HIDDEN_DEFAULT_TOOL_IDS,
];

export function ProviderSettingsCard({
  provider,
  onToggleEnabled,
  onSetDefault: _onSetDefault,
  onSaveApiKey,
  onDeleteApiKey,
  onRevealApiKey,
  onCustomUrlChange,
  onSelectModel: _onSelectModel,
  onSetFavoriteModels,
  onSetCapabilityOverride,
  onToolsAllowlistChange,
  onTuningOverridesChange,
  isLast = false,
  // Model fetching props
  modelComboboxOpen: controlledComboboxOpen,
  onModelComboboxOpenChange,
  fetchedModels: externalFetchedModels,
  isFetchingModels: externalIsFetchingModels,
  fetchModelsError: externalFetchModelsError,
  onRefreshModels,
}: ProviderSettingsCardProps) {
  const { t } = useTranslation();
  // Suppress unused variable warnings for deprecated/unused props
  void _onSelectModel;
  void _onSetDefault;
  const [isOpen, setIsOpen] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeyValue, setApiKeyValue] = useState("");
  const [isLoadingKey, setIsLoadingKey] = useState(false);
  const [hasLoadedKey, setHasLoadedKey] = useState(false);
  const [customUrlValue, setCustomUrlValue] = useState(provider.customUrl ?? "");
  const [selectedModelForConfig, setSelectedModelForConfig] = useState<string | null>(null);
  const hasAutoSelectedRef = useRef(false);

  // Support both controlled and uncontrolled combobox state
  const [internalComboboxOpen, setInternalComboboxOpen] = useState(false);
  const modelComboboxOpen = controlledComboboxOpen ?? internalComboboxOpen;
  const setModelComboboxOpen = onModelComboboxOpenChange ?? setInternalComboboxOpen;

  // Use external fetched models if provided
  const fetchedModels = externalFetchedModels ?? [];
  const isFetchingModels = externalIsFetchingModels ?? false;
  const fetchError = externalFetchModelsError ?? null;

  // Check if provider supports custom base URL
  const supportsCustomUrl = provider.connectionFields?.some(
    (field) => field.key === "baseUrl" || field.key === "customUrl",
  );
  const customUrlField = provider.connectionFields?.find(
    (field) => field.key === "baseUrl" || field.key === "customUrl",
  );

  // Combine catalog models with fetched models and saved favorites
  const allModels = useMemo(() => {
    const seenIds = new Set<string>();
    const combined: (MergedModel | (FetchedModel & { isFetched: true }))[] = [];

    // First add catalog models
    for (const model of provider.models) {
      combined.push(model);
      seenIds.add(model.id);
    }

    // Add fetched models that aren't in catalog
    for (const fetched of fetchedModels) {
      if (!seenIds.has(fetched.id)) {
        combined.push({
          ...fetched,
          isFetched: true,
        } as FetchedModel & { isFetched: true });
        seenIds.add(fetched.id);
      }
    }

    // Add any saved favorite models that aren't already in the list
    // (these are models that were fetched in a previous session)
    for (const favoriteId of provider.favoriteModels || []) {
      if (!seenIds.has(favoriteId)) {
        combined.push({
          id: favoriteId,
          name: favoriteId, // Use ID as name since we don't have the full model info
          isFetched: true,
        } as FetchedModel & { isFetched: true });
        seenIds.add(favoriteId);
      }
    }

    return combined;
  }, [provider.models, fetchedModels, provider.favoriteModels]);

  // Get enabled models (favorites) with full model info
  const enabledModels = useMemo(() => {
    const favoriteIds = provider.favoriteModels || [];
    return allModels.filter((m) => favoriteIds.includes(m.id));
  }, [provider.favoriteModels, allModels]);

  const handleRevealApiKey = async () => {
    if (hasLoadedKey) {
      setShowApiKey(!showApiKey);
      return;
    }

    setIsLoadingKey(true);
    try {
      const key = await onRevealApiKey();
      if (key) {
        setApiKeyValue(key);
      }
    } finally {
      setIsLoadingKey(false);
      setHasLoadedKey(true);
      setShowApiKey(true);
    }
  };

  const handleSaveApiKey = () => {
    if (apiKeyValue && apiKeyValue.trim() !== "") {
      onSaveApiKey(apiKeyValue);
    } else {
      onDeleteApiKey();
    }
  };

  // Auto-select recommended models on initial mount if no models are selected
  // This only runs once when the card first expands, not on subsequent updates
  useEffect(() => {
    if (isOpen && !hasAutoSelectedRef.current && onSetFavoriteModels && provider.enabled) {
      hasAutoSelectedRef.current = true; // Mark as run immediately to prevent re-runs

      // Only auto-select if truly empty
      if (!provider.favoriteModels || provider.favoriteModels.length === 0) {
        const recommendedModelIds = provider.models.filter((m) => m.isCatalog).map((m) => m.id);
        if (recommendedModelIds.length > 0) {
          onSetFavoriteModels(recommendedModelIds);
        }
      }
    }
  }, [isOpen, provider.enabled, provider.favoriteModels, provider.models, onSetFavoriteModels]);

  const handleToggleFavorite = (modelId: string) => {
    if (!onSetFavoriteModels) return;

    const currentFavorites = provider.favoriteModels || [];
    const newFavorites = currentFavorites.includes(modelId)
      ? currentFavorites.filter((id) => id !== modelId)
      : [...currentFavorites, modelId];
    onSetFavoriteModels(newFavorites);
  };

  const handleCapabilityChange = (
    modelId: string,
    capability: "tools" | "thinking" | "vision",
    value: boolean,
  ) => {
    if (!onSetCapabilityOverride) return;

    const existingOverrides = provider.modelCapabilityOverrides[modelId] || {};
    const newOverrides: ModelCapabilityOverrides = {
      ...existingOverrides,
      [capability]: value,
    };
    onSetCapabilityOverride(modelId, newOverrides);
  };

  // Check if a tool group is enabled. Some legacy settings only contain one
  // tool from a group, so treat any matching tool as enabled and repair the
  // full group the next time settings are saved.
  const isToolGroupEnabled = (toolIds: string[]): boolean => {
    const allowlist = provider.toolsAllowlist;
    // null/undefined means all tools are enabled
    if (allowlist === null || allowlist === undefined) return true;
    return toolIds.some((toolId) => allowlist.includes(toolId));
  };

  // Handle grouped tool allowlist toggle
  const handleToolToggle = (toolIds: string[], enabled: boolean) => {
    if (!onToolsAllowlistChange) return;

    const enabledToolIds = new Set<string>();
    for (const option of DATA_ACCESS_OPTIONS) {
      const isTarget = option.toolIds.some((toolId) => toolIds.includes(toolId));
      const nextEnabled = isTarget ? enabled : isToolGroupEnabled(option.toolIds);
      if (nextEnabled) {
        for (const toolId of option.toolIds) {
          enabledToolIds.add(toolId);
        }
      }
    }

    const hasVisibleAccess = DATA_ACCESS_OPTIONS.some((option) =>
      option.toolIds.some((toolId) => enabledToolIds.has(toolId)),
    );
    if (hasVisibleAccess) {
      for (const toolId of HIDDEN_DEFAULT_TOOL_IDS) {
        enabledToolIds.add(toolId);
      }
    }

    const allEnabled = ALL_DATA_ACCESS_TOOL_IDS.every((toolId) => enabledToolIds.has(toolId));
    if (allEnabled) {
      onToolsAllowlistChange(null);
      return;
    }

    onToolsAllowlistChange(ALL_DATA_ACCESS_TOOL_IDS.filter((toolId) => enabledToolIds.has(toolId)));
  };

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className={cn("hover:bg-accent/30 transition-colors", !isLast && "border-b")}>
        {/* Main row */}
        <div className="flex items-center gap-4 px-4 py-3">
          {/* Icon */}
          <div className="bg-muted flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
            <ProviderIcon name={provider.icon} size={20} className="text-muted-foreground" />
          </div>

          {/* Name and description */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{provider.name}</span>
              {provider.isDefault && (
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                  {t("ai:providerSettings.default")}
                </Badge>
              )}
              {provider.enabled && !provider.hasApiKey && provider.type === "api" && (
                <Badge
                  variant="outline"
                  className="border-warning/20 bg-warning/10 text-warning shrink-0 text-xs"
                >
                  <Icons.AlertTriangle className="mr-1 h-3 w-3" />
                  {t("ai:providerSettings.apiKeyRequired")}
                </Badge>
              )}
            </div>
            <p className="text-muted-foreground mt-0.5 text-xs">{provider.description}</p>
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
              onCheckedChange={onToggleEnabled}
              className="data-[state=checked]:bg-success"
            />
          </div>
        </div>

        {/* Expandable settings */}
        <CollapsibleContent>
          <div className="border-t px-4 py-5">
            <div className="space-y-5">
              {/* API Key Section (only for API providers) */}
              {provider.type === "api" && (
                <div className="bg-muted/40 rounded-lg p-4">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label htmlFor={`apikey-${provider.id}`} className="text-sm font-medium">
                        {t("ai:providerSettings.apiKey")}
                      </Label>
                      {provider.documentationUrl && (
                        <ExternalLink
                          href={provider.documentationUrl}
                          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
                        >
                          {t("ai:providerSettings.getApiKey")}
                          <Icons.ExternalLink className="h-3 w-3" />
                        </ExternalLink>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="relative flex-1">
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
                            provider.hasApiKey ? "" : t("ai:providerSettings.enterApiKey")
                          }
                          className="bg-background pr-9 font-mono text-sm"
                          readOnly={!hasLoadedKey && provider.hasApiKey}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="absolute right-0 top-0 h-full w-9 hover:bg-transparent"
                          onClick={handleRevealApiKey}
                          disabled={isLoadingKey}
                          aria-label={
                            showApiKey
                              ? t("ai:providerSettings.hideApiKey")
                              : t("ai:providerSettings.showApiKey")
                          }
                        >
                          {isLoadingKey ? (
                            <Icons.Spinner className="h-4 w-4 animate-spin" />
                          ) : showApiKey ? (
                            <Icons.EyeOff className="h-4 w-4" />
                          ) : (
                            <Icons.Eye className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                      <Button
                        onClick={handleSaveApiKey}
                        size="default"
                        className="shrink-0"
                        disabled={!hasLoadedKey && provider.hasApiKey}
                      >
                        {t("ai:providerSettings.save")}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Model Selection Section */}
              {onSetFavoriteModels && (
                <div className="bg-muted/40 rounded-lg p-4">
                  <div className="space-y-3">
                    {/* Header with Add button */}
                    <div className="flex items-center justify-between">
                      <Label className="text-sm font-medium">
                        {t("ai:providerSettings.models")}
                      </Label>
                      <div className="flex items-center gap-2">
                        {provider.supportsModelListing && onRefreshModels && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hover:text-foreground h-7 px-2 text-xs"
                            onClick={onRefreshModels}
                            disabled={
                              isFetchingModels || (!provider.hasApiKey && provider.type === "api")
                            }
                          >
                            {isFetchingModels ? (
                              <Icons.Spinner className="h-3 w-3 animate-spin" />
                            ) : (
                              <Icons.RefreshCw className="h-3 w-3" />
                            )}
                          </Button>
                        )}
                        <Popover open={modelComboboxOpen} onOpenChange={setModelComboboxOpen}>
                          <PopoverTrigger asChild>
                            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs">
                              <Icons.Plus className="h-3 w-3" />
                              {t("ai:providerSettings.add")}
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent className="w-80 p-0" align="end">
                            <Command>
                              <CommandInput
                                placeholder={t("ai:providerSettings.searchModels")}
                                className="h-9"
                              />
                              <CommandList>
                                <CommandEmpty>
                                  {isFetchingModels ? (
                                    <div className="flex items-center justify-center gap-2 py-2">
                                      <Icons.Spinner className="h-4 w-4 animate-spin" />
                                      <span>{t("ai:providerSettings.loading")}</span>
                                    </div>
                                  ) : (
                                    t("ai:providerSettings.noModelsFound")
                                  )}
                                </CommandEmpty>
                                {/* Recommended models */}
                                <CommandGroup heading={t("ai:providerSettings.recommended")}>
                                  {allModels
                                    .filter((m) => "isCatalog" in m && m.isCatalog)
                                    .map((model) => {
                                      const isEnabled = provider.favoriteModels?.includes(model.id);
                                      const capabilities =
                                        "capabilities" in model ? model.capabilities : null;
                                      return (
                                        <CommandItem
                                          key={model.id}
                                          value={`${model.id} ${model.name ?? ""}`}
                                          onSelect={() => {
                                            handleToggleFavorite(model.id);
                                          }}
                                          className="flex items-center justify-between"
                                        >
                                          <span className="truncate">{model.name ?? model.id}</span>
                                          <div className="flex items-center gap-1">
                                            {capabilities?.tools && (
                                              <Badge
                                                variant="secondary"
                                                className="h-4 px-1 text-[9px]"
                                              >
                                                T
                                              </Badge>
                                            )}
                                            {capabilities?.vision && (
                                              <Badge
                                                variant="secondary"
                                                className="h-4 px-1 text-[9px]"
                                              >
                                                V
                                              </Badge>
                                            )}
                                            {isEnabled && <Icons.Check className="h-4 w-4" />}
                                          </div>
                                        </CommandItem>
                                      );
                                    })}
                                </CommandGroup>
                                {/* Other available models */}
                                {allModels.filter((m) => !("isCatalog" in m && m.isCatalog))
                                  .length > 0 && (
                                  <CommandGroup heading={t("ai:providerSettings.otherAvailable")}>
                                    {allModels
                                      .filter((m) => !("isCatalog" in m && m.isCatalog))
                                      .map((model) => {
                                        const isEnabled = provider.favoriteModels?.includes(
                                          model.id,
                                        );
                                        return (
                                          <CommandItem
                                            key={model.id}
                                            value={`${model.id} ${model.name ?? ""}`}
                                            onSelect={() => {
                                              handleToggleFavorite(model.id);
                                            }}
                                            className="flex items-center justify-between"
                                          >
                                            <span className="truncate">
                                              {model.name ?? model.id}
                                            </span>
                                            {isEnabled && <Icons.Check className="h-4 w-4" />}
                                          </CommandItem>
                                        );
                                      })}
                                  </CommandGroup>
                                )}
                              </CommandList>
                            </Command>
                          </PopoverContent>
                        </Popover>
                      </div>
                    </div>

                    {/* Model list */}
                    <div className="bg-background rounded-md border">
                      {enabledModels.length === 0 ? (
                        <div className="text-muted-foreground flex items-center justify-center py-6 text-sm">
                          {t("ai:providerSettings.noModelsSelected")}
                        </div>
                      ) : (
                        <div className="divide-y">
                          {enabledModels.map((model) => {
                            const capabilities =
                              "capabilities" in model
                                ? model.capabilities
                                : provider.modelCapabilityOverrides[model.id];
                            const isRecommended = "isCatalog" in model && model.isCatalog;
                            const needsConfig = !isRecommended && !capabilities;
                            const isSelected = selectedModelForConfig === model.id;

                            return (
                              <div
                                key={model.id}
                                className={cn(
                                  "flex cursor-pointer items-center justify-between px-3 py-2 transition-colors",
                                  isSelected ? "bg-accent" : "hover:bg-muted/50",
                                )}
                                onClick={() =>
                                  setSelectedModelForConfig(isSelected ? null : model.id)
                                }
                              >
                                <div className="flex min-w-0 items-center gap-2">
                                  <span className="truncate text-sm">{model.name ?? model.id}</span>
                                  {isRecommended && (
                                    <Icons.Star className="text-warning h-3.5 w-3.5 shrink-0 fill-current" />
                                  )}
                                </div>
                                <div className="flex shrink-0 items-center gap-2">
                                  {/* Capability badges */}
                                  {capabilities?.tools && (
                                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                                      {t("ai:providerSettings.tools")}
                                    </Badge>
                                  )}
                                  {capabilities?.vision && (
                                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                                      {t("ai:providerSettings.vision")}
                                    </Badge>
                                  )}
                                  {capabilities?.thinking && (
                                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                                      {t("ai:providerSettings.thinking")}
                                    </Badge>
                                  )}
                                  {needsConfig && (
                                    <Badge
                                      variant="outline"
                                      className="border-warning/50 text-warning h-5 px-1.5 text-[10px]"
                                    >
                                      <Icons.AlertTriangle className="mr-1 h-3 w-3" />
                                      {t("ai:providerSettings.config")}
                                    </Badge>
                                  )}
                                  {/* Remove button */}
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="text-muted-foreground hover:text-destructive h-6 w-6"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleToggleFavorite(model.id);
                                      if (isSelected) setSelectedModelForConfig(null);
                                    }}
                                  >
                                    <Icons.X className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Capability config for selected model */}
                    {selectedModelForConfig &&
                      onSetCapabilityOverride &&
                      (() => {
                        const model = enabledModels.find((m) => m.id === selectedModelForConfig);
                        if (!model) return null;
                        const isRecommended = "isCatalog" in model && model.isCatalog;
                        const capabilities =
                          isRecommended && "capabilities" in model
                            ? model.capabilities
                            : provider.modelCapabilityOverrides[model.id] || {};

                        return (
                          <div className="bg-background rounded-md border p-3">
                            <div className="mb-3 flex items-center justify-between">
                              <p className="text-sm font-medium">{model.name ?? model.id}</p>
                              {isRecommended && (
                                <Badge variant="secondary" className="text-xs">
                                  {t("ai:providerSettings.recommended")}
                                </Badge>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-4">
                              <label className="flex items-center gap-2 text-sm">
                                <Checkbox
                                  checked={capabilities.tools ?? false}
                                  onCheckedChange={(checked) =>
                                    handleCapabilityChange(model.id, "tools", checked === true)
                                  }
                                  disabled={isRecommended}
                                />
                                {t("ai:providerSettings.tools")}
                              </label>
                              <label className="flex items-center gap-2 text-sm">
                                <Checkbox
                                  checked={capabilities.vision ?? false}
                                  onCheckedChange={(checked) =>
                                    handleCapabilityChange(model.id, "vision", checked === true)
                                  }
                                  disabled={isRecommended}
                                />
                                {t("ai:providerSettings.vision")}
                              </label>
                              <label className="flex items-center gap-2 text-sm">
                                <Checkbox
                                  checked={capabilities.thinking ?? false}
                                  onCheckedChange={(checked) =>
                                    handleCapabilityChange(model.id, "thinking", checked === true)
                                  }
                                  disabled={isRecommended}
                                />
                                {t("ai:providerSettings.thinking")}
                              </label>
                            </div>
                            {isRecommended && (
                              <p className="text-muted-foreground mt-2 text-xs">
                                {t("ai:providerSettings.capabilitiesPreset")}
                              </p>
                            )}
                          </div>
                        );
                      })()}

                    {/* Fetch error */}
                    {fetchError && <p className="text-destructive text-xs">{fetchError}</p>}
                  </div>
                </div>
              )}

              {/* Data Access Section */}
              {onToolsAllowlistChange && (
                <div className="bg-muted/40 space-y-3 rounded-lg p-4">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">
                      {t("ai:providerSettings.dataAccessTitle")}
                    </Label>
                    <span className="text-muted-foreground text-xs">
                      {t("ai:providerSettings.dataAccessSubtitle")}
                    </span>
                  </div>
                  <div className="border-border/70 bg-background/60 flex gap-2 rounded-md border px-3 py-2.5">
                    <Icons.Info className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">
                        {t("ai:providerSettings.aiDataSharing")}
                      </p>
                      <p className="text-muted-foreground text-xs leading-relaxed">
                        {t("ai:providerSettings.aiDataSharingDescription")}
                      </p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {DATA_ACCESS_OPTIONS.map((option) => {
                      const isEnabled = isToolGroupEnabled(option.toolIds);
                      return (
                        <button
                          key={option.labelKey}
                          type="button"
                          onClick={() => handleToolToggle(option.toolIds, !isEnabled)}
                          className={cn(
                            "flex items-start gap-2.5 rounded-lg border p-3 text-left transition-all",
                            isEnabled
                              ? "border-primary/30 bg-primary/5"
                              : "bg-muted/40 hover:bg-muted/60 border-transparent",
                          )}
                        >
                          <div
                            className={cn(
                              "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border transition-colors",
                              isEnabled
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-muted-foreground/30",
                            )}
                          >
                            {isEnabled && <Icons.Check className="h-3 w-3" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <span className="text-sm font-medium">{t(option.labelKey)}</span>
                            <p className="text-muted-foreground mt-0.5 text-xs leading-tight">
                              {t(option.descriptionKey)}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Advanced Options — last because rarely touched (endpoint URL + tuning) */}
              {onTuningOverridesChange && (
                <AdvancedTuningSection
                  provider={provider}
                  onChange={onTuningOverridesChange}
                  customUrlField={customUrlField}
                  customUrlValue={customUrlValue}
                  onCustomUrlValueChange={setCustomUrlValue}
                  onCustomUrlSave={onCustomUrlChange}
                  supportsCustomUrl={supportsCustomUrl}
                />
              )}
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// ============================================================================
// Advanced Tuning Section
// ============================================================================

interface AdvancedTuningSectionProps {
  provider: MergedProvider;
  onChange: (overrides: ProviderTuningOverrides | null) => void;
  /** Catalog-defined connection field for the endpoint URL, if this provider supports one. */
  customUrlField?: ConnectionField;
  /** Current URL draft value (controlled by the parent card's local state). */
  customUrlValue: string;
  /** Update the URL draft value — called on each keystroke. */
  onCustomUrlValueChange: (value: string) => void;
  /** Persist the URL draft value to backend (called when user hits Save). */
  onCustomUrlSave?: (url: string) => void;
  /** Whether this provider supports a custom endpoint URL at all. */
  supportsCustomUrl: boolean;
}

type PrimitiveExtraValue = number | boolean | string;
type TuningFieldSource = "primary" | "extra";
type TuningFieldGroup = "sampling" | "limits" | "repetition" | "other";

interface PrimaryFieldMeta {
  labelKey: string;
  descriptionKey: string;
  group: TuningFieldGroup;
  bounds: { min: number; max: number; step: number };
  format: (v: number) => string;
}

/**
 * The three cross-provider scalar fields that sit on `tuning` directly
 * (not inside `extraOptions`). Rendered with friendly labels.
 */
const PRIMARY_FIELDS: Record<"temperature" | "maxTokens" | "maxTokensThinking", PrimaryFieldMeta> =
  {
    temperature: {
      labelKey: "ai:providerSettings.field.temperature",
      descriptionKey: "ai:providerSettings.field.temperatureDescription",
      group: "sampling",
      bounds: { min: 0, max: 2, step: 0.05 },
      format: (v) => v.toFixed(2),
    },
    maxTokens: {
      labelKey: "ai:providerSettings.field.maxTokens",
      descriptionKey: "ai:providerSettings.field.maxTokensDescription",
      group: "limits",
      bounds: { min: 256, max: 131_072, step: 256 },
      format: (v) => v.toLocaleString(),
    },
    maxTokensThinking: {
      labelKey: "ai:providerSettings.field.maxTokensThinking",
      descriptionKey: "ai:providerSettings.field.maxTokensThinkingDescription",
      group: "limits",
      bounds: { min: 256, max: 131_072, step: 256 },
      format: (v) => v.toLocaleString(),
    },
  };

/**
 * Grouping + description keys for known provider-specific scalar keys under
 * `extraOptions`. Unknown keys fall into "other".
 */
const EXTRA_FIELD_META: Record<string, { group: TuningFieldGroup; descriptionKey: string }> = {
  num_ctx: { group: "limits", descriptionKey: "ai:providerSettings.extra.num_ctx" },
  num_predict: { group: "limits", descriptionKey: "ai:providerSettings.extra.num_predict" },
  top_k: { group: "sampling", descriptionKey: "ai:providerSettings.extra.top_k" },
  top_p: { group: "sampling", descriptionKey: "ai:providerSettings.extra.top_p" },
  min_p: { group: "sampling", descriptionKey: "ai:providerSettings.extra.min_p" },
  mirostat: { group: "sampling", descriptionKey: "ai:providerSettings.extra.mirostat" },
  mirostat_eta: { group: "sampling", descriptionKey: "ai:providerSettings.extra.mirostat_eta" },
  mirostat_tau: { group: "sampling", descriptionKey: "ai:providerSettings.extra.mirostat_tau" },
  repeat_penalty: {
    group: "repetition",
    descriptionKey: "ai:providerSettings.extra.repeat_penalty",
  },
  repeat_last_n: { group: "repetition", descriptionKey: "ai:providerSettings.extra.repeat_last_n" },
  frequency_penalty: {
    group: "repetition",
    descriptionKey: "ai:providerSettings.extra.frequency_penalty",
  },
  presence_penalty: {
    group: "sampling",
    descriptionKey: "ai:providerSettings.extra.presence_penalty",
  },
  seed: { group: "other", descriptionKey: "ai:providerSettings.extra.seed" },
};

const GROUP_META: Record<TuningFieldGroup, { titleKey: string; blurbKey: string }> = {
  sampling: {
    titleKey: "ai:providerSettings.group.samplingTitle",
    blurbKey: "ai:providerSettings.group.samplingBlurb",
  },
  limits: {
    titleKey: "ai:providerSettings.group.limitsTitle",
    blurbKey: "ai:providerSettings.group.limitsBlurb",
  },
  repetition: {
    titleKey: "ai:providerSettings.group.repetitionTitle",
    blurbKey: "ai:providerSettings.group.repetitionBlurb",
  },
  other: {
    titleKey: "ai:providerSettings.group.otherTitle",
    blurbKey: "ai:providerSettings.group.otherBlurb",
  },
};

const GROUP_ORDER: TuningFieldGroup[] = ["sampling", "limits", "repetition", "other"];

/**
 * Soft numeric bounds for well-known Ollama/LLM scalar keys in `extraOptions`.
 */
const KNOWN_NUMERIC_BOUNDS: Record<string, { min: number; max: number; step: number }> = {
  num_ctx: { min: 512, max: 131_072, step: 512 },
  repeat_penalty: { min: 0, max: 2, step: 0.05 },
  repeat_last_n: { min: 0, max: 8192, step: 1 },
  top_k: { min: 0, max: 200, step: 1 },
  top_p: { min: 0, max: 1, step: 0.01 },
  min_p: { min: 0, max: 1, step: 0.01 },
  mirostat: { min: 0, max: 2, step: 1 },
  mirostat_eta: { min: 0, max: 1, step: 0.01 },
  mirostat_tau: { min: 0, max: 10, step: 0.1 },
  seed: { min: 0, max: 2_147_483_647, step: 1 },
  num_predict: { min: 1, max: 131_072, step: 1 },
  frequency_penalty: { min: -2, max: 2, step: 0.1 },
  presence_penalty: { min: -2, max: 2, step: 0.1 },
};

function isPrimitive(value: unknown): value is PrimitiveExtraValue {
  return typeof value === "number" || typeof value === "boolean" || typeof value === "string";
}

/** Unified descriptor for one editable tuning field (primary or extra). */
interface TuningFieldDescriptor {
  id: string; // key for React and htmlFor
  source: TuningFieldSource;
  label: string;
  monoLabel: boolean; // raw catalog keys render monospace
  description: string;
  group: TuningFieldGroup;
  type: "number" | "boolean" | "string";
  catalogValue: PrimitiveExtraValue | undefined;
  overrideValue: PrimitiveExtraValue | null | undefined;
  effectiveValue: PrimitiveExtraValue | undefined;
  bounds?: { min: number; max: number; step: number };
  formatValue: (v: PrimitiveExtraValue) => string;
}

function defaultFormat(v: PrimitiveExtraValue): string {
  if (typeof v === "number") {
    return Number.isInteger(v) ? v.toLocaleString() : String(v);
  }
  return String(v);
}

function AdvancedTuningSection({
  provider,
  onChange,
  customUrlField,
  customUrlValue,
  onCustomUrlValueChange,
  onCustomUrlSave,
  supportsCustomUrl,
}: AdvancedTuningSectionProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  const catalog: ProviderTuning = provider.catalogTuning ?? {};
  const overrides: ProviderTuningOverrides = provider.tuningOverrides ?? {};
  const resolved: ProviderTuning = provider.resolvedTuning ?? catalog;
  const extraOverrides = overrides.extraOptionOverrides ?? {};

  const supportsThinking = provider.models.some((m) => m.capabilities.thinking);

  const hasOverrides =
    overrides.temperature !== undefined ||
    overrides.maxTokens !== undefined ||
    overrides.maxTokensThinking !== undefined ||
    Object.keys(extraOverrides).length > 0;

  // Build the unified list of editable fields from primary + extraOptions.
  const fields = useMemo<TuningFieldDescriptor[]>(() => {
    const list: TuningFieldDescriptor[] = [];

    // Primary fields — always render when the provider has tuning at all.
    // Max tokens (thinking) is hidden if no model in the provider supports thinking.
    const primaryKeys: ("temperature" | "maxTokens" | "maxTokensThinking")[] = [
      "temperature",
      "maxTokens",
      ...(supportsThinking ? (["maxTokensThinking"] as const) : []),
    ];
    for (const key of primaryKeys) {
      const meta = PRIMARY_FIELDS[key];
      const catalogValue = catalog[key];
      const overrideValue = overrides[key];
      if (catalogValue === undefined && overrideValue === undefined) continue;
      list.push({
        id: key,
        source: "primary",
        label: t(meta.labelKey),
        monoLabel: false,
        description: t(meta.descriptionKey),
        group: meta.group,
        type: "number",
        catalogValue,
        overrideValue,
        effectiveValue: resolved[key],
        bounds: meta.bounds,
        formatValue: (v) => (typeof v === "number" ? meta.format(v) : String(v)),
      });
    }

    // Extra options — iterate the catalog, keep primitives, drop complex shapes.
    const catalogExtras = catalog.extraOptions ?? {};
    if (catalogExtras && typeof catalogExtras === "object" && !Array.isArray(catalogExtras)) {
      for (const [key, value] of Object.entries(catalogExtras)) {
        if (!isPrimitive(value)) continue;
        const meta = EXTRA_FIELD_META[key];
        list.push({
          id: `extra-${key}`,
          source: "extra",
          label: key,
          monoLabel: true,
          description: meta?.descriptionKey ? t(meta.descriptionKey) : "",
          group: meta?.group ?? "other",
          type: typeof value as "number" | "boolean" | "string",
          catalogValue: value,
          overrideValue: extraOverrides[key] ?? undefined,
          effectiveValue:
            extraOverrides[key] !== undefined && extraOverrides[key] !== null
              ? extraOverrides[key]
              : value,
          bounds: typeof value === "number" ? KNOWN_NUMERIC_BOUNDS[key] : undefined,
          formatValue: defaultFormat,
        });
      }
    }

    return list;
  }, [catalog, overrides, resolved, extraOverrides, supportsThinking, t]);

  // Bucket by group and preserve insertion order inside each.
  const grouped = useMemo(() => {
    const buckets: Record<TuningFieldGroup, TuningFieldDescriptor[]> = {
      sampling: [],
      limits: [],
      repetition: [],
      other: [],
    };
    for (const f of fields) buckets[f.group].push(f);
    return buckets;
  }, [fields]);

  // Complex (array/object) catalog extras — read-only display.
  const complexEntries = useMemo(() => {
    const extras = catalog.extraOptions;
    if (!extras || typeof extras !== "object" || Array.isArray(extras)) return [];
    return Object.entries(extras).filter(([, v]) => !isPrimitive(v));
  }, [catalog.extraOptions]);

  // Orphaned: user override exists for a key no longer in the catalog.
  const orphanedEntries = useMemo(() => {
    const catalogKeys = new Set<string>();
    const extras = catalog.extraOptions;
    if (extras && typeof extras === "object" && !Array.isArray(extras)) {
      for (const k of Object.keys(extras)) catalogKeys.add(k);
    }
    return Object.entries(extraOverrides).filter(([k]) => !catalogKeys.has(k));
  }, [catalog.extraOptions, extraOverrides]);

  /**
   * Commit a single field's new value. Handles routing to either the top-level
   * override field (primary) or the per-key `extraOptionOverrides` map (extra).
   * `value === null` clears the override for that field.
   */
  const commitField = (field: TuningFieldDescriptor, value: PrimitiveExtraValue | null) => {
    const next: ProviderTuningOverrides = {
      temperature: overrides.temperature,
      maxTokens: overrides.maxTokens,
      maxTokensThinking: overrides.maxTokensThinking,
      extraOptionOverrides: { ...extraOverrides },
    };

    if (field.source === "primary") {
      const key = field.id as "temperature" | "maxTokens" | "maxTokensThinking";
      if (value === null) {
        next[key] = undefined;
      } else if (typeof value === "number") {
        next[key] = value;
      }
    } else {
      // strip the "extra-" prefix we use for React keys
      const rawKey = field.label;
      const extras = next.extraOptionOverrides ?? {};
      if (value === null) {
        delete extras[rawKey];
      } else {
        extras[rawKey] = value;
      }
      next.extraOptionOverrides = extras;
    }

    // Normalize: if extraOptionOverrides is empty, drop it.
    if (next.extraOptionOverrides && Object.keys(next.extraOptionOverrides).length === 0) {
      next.extraOptionOverrides = undefined;
    }

    const isEmpty =
      next.temperature === undefined &&
      next.maxTokens === undefined &&
      next.maxTokensThinking === undefined &&
      !next.extraOptionOverrides;
    onChange(isEmpty ? null : next);
  };

  const clearOrphaned = (key: string) => {
    const extras = { ...extraOverrides };
    delete extras[key];
    const next: ProviderTuningOverrides = {
      ...overrides,
      extraOptionOverrides: Object.keys(extras).length === 0 ? undefined : extras,
    };
    const isEmpty =
      next.temperature === undefined &&
      next.maxTokens === undefined &&
      next.maxTokensThinking === undefined &&
      !next.extraOptionOverrides;
    onChange(isEmpty ? null : next);
  };

  const resetAll = () => onChange(null);

  const endpointAvailable = supportsCustomUrl && !!customUrlField;

  // Nothing to show at all (e.g. a provider with no tuning, no extras, no URL).
  const hasAnything =
    fields.length > 0 ||
    complexEntries.length > 0 ||
    orphanedEntries.length > 0 ||
    endpointAvailable;
  if (!hasAnything) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="bg-muted/40 space-y-3 rounded-lg p-4">
        <div className="flex items-center justify-between">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="text-foreground inline-flex items-center gap-1.5 text-sm font-medium"
            >
              <Icons.ChevronRight
                className={cn(
                  "text-muted-foreground h-3.5 w-3.5 transition-transform",
                  open && "rotate-90",
                )}
              />
              {t("ai:providerSettings.advancedOptions")}
              {hasOverrides && (
                <Badge variant="secondary" className="ml-1 text-[10px] uppercase">
                  {t("ai:providerSettings.customized")}
                </Badge>
              )}
            </button>
          </CollapsibleTrigger>
          {hasOverrides && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground h-7 px-2 text-xs"
              onClick={resetAll}
            >
              {t("ai:providerSettings.resetToDefaults")}
            </Button>
          )}
        </div>

        <CollapsibleContent>
          <div className="space-y-3">
            {endpointAvailable && customUrlField && (
              <EndpointGroupCard
                providerId={provider.id}
                field={customUrlField}
                value={customUrlValue}
                onValueChange={onCustomUrlValueChange}
                onSave={onCustomUrlSave}
              />
            )}
            {GROUP_ORDER.map((groupKey) => {
              const groupFields = grouped[groupKey];
              if (groupFields.length === 0) return null;
              return (
                <TuningGroupCard
                  key={groupKey}
                  title={t(GROUP_META[groupKey].titleKey)}
                  blurb={t(GROUP_META[groupKey].blurbKey)}
                  fields={groupFields}
                  providerId={provider.id}
                  onCommit={commitField}
                />
              );
            })}

            {complexEntries.length > 0 && (
              <div className="bg-muted/40 space-y-1.5 rounded-md p-3">
                <div className="flex items-center gap-1.5">
                  <Icons.Settings className="text-muted-foreground h-3 w-3" />
                  <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
                    {t("ai:providerSettings.structuredOptions")}
                  </span>
                </div>
                <p className="text-muted-foreground text-[11px] leading-tight">
                  {t("ai:providerSettings.structuredOptionsDescription")}
                </p>
                <dl className="font-mono text-[11px]">
                  {complexEntries.map(([key, value]) => (
                    <div key={key} className="flex items-baseline gap-2">
                      <dt className="text-muted-foreground/80 shrink-0">{key}</dt>
                      <dd className="text-foreground/70 truncate">{JSON.stringify(value)}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}

            {orphanedEntries.length > 0 && (
              <div className="border-warning/30 bg-warning/5 space-y-2 rounded-md border p-3">
                <p className="text-warning text-[11px] font-medium">
                  {t("ai:providerSettings.orphanedOverrides")}
                </p>
                <ul className="space-y-1">
                  {orphanedEntries.map(([key, value]) => (
                    <li
                      key={key}
                      className="flex items-center justify-between gap-2 font-mono text-[11px]"
                    >
                      <span>
                        {key} = {JSON.stringify(value)}
                      </span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground h-6 px-2 text-[11px]"
                        onClick={() => clearOrphaned(key)}
                      >
                        {t("ai:providerSettings.remove")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// ============================================================================
// Tuning group card (Sampling / Output limits / Repetition / Other)
// ============================================================================

interface TuningGroupCardProps {
  title: string;
  blurb: string;
  fields: TuningFieldDescriptor[];
  providerId: string;
  onCommit: (field: TuningFieldDescriptor, value: PrimitiveExtraValue | null) => void;
}

function TuningGroupCard({ title, blurb, fields, providerId, onCommit }: TuningGroupCardProps) {
  return (
    <div className="bg-muted/40 space-y-3 rounded-md p-3">
      <div className="space-y-0.5">
        <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
          {title}
        </span>
        <p className="text-muted-foreground/80 text-[11px] leading-tight">{blurb}</p>
      </div>
      <div className="space-y-3">
        {fields.map((field) => (
          <TuningFieldRow
            key={field.id}
            field={field}
            providerId={providerId}
            onCommit={(value) => onCommit(field, value)}
          />
        ))}
      </div>
    </div>
  );
}

// ============================================================================
// Tuning field row — unified editor used for both primary + extra fields
// ============================================================================

interface TuningFieldRowProps {
  field: TuningFieldDescriptor;
  providerId: string;
  onCommit: (value: PrimitiveExtraValue | null) => void;
}

function TuningFieldRow({ field, providerId, onCommit }: TuningFieldRowProps) {
  const { t } = useTranslation();
  const {
    id,
    label,
    monoLabel,
    description,
    type,
    catalogValue,
    overrideValue,
    effectiveValue,
    bounds,
    formatValue,
  } = field;

  const inputId = `tuning-${providerId}-${id}`;
  const hasOverride = overrideValue !== undefined && overrideValue !== null;

  const catalogDisplay =
    catalogValue !== undefined ? formatValue(catalogValue) : t("ai:providerSettings.modelDefault");
  const effectiveDisplay = effectiveValue !== undefined ? formatValue(effectiveValue) : "—";

  // Local draft so blur-to-commit works without re-rendering on every keypress.
  const [draft, setDraft] = useState<string>(() =>
    overrideValue !== undefined && overrideValue !== null ? String(overrideValue) : "",
  );
  useEffect(() => {
    setDraft(overrideValue !== undefined && overrideValue !== null ? String(overrideValue) : "");
  }, [overrideValue]);

  // --- Boolean: switch layout (still label left + description, switch right) ---
  if (type === "boolean") {
    const catalogBool = typeof catalogValue === "boolean" ? catalogValue : false;
    const checked = typeof effectiveValue === "boolean" ? effectiveValue : catalogBool;
    return (
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label htmlFor={inputId} className={cn("text-xs font-medium", monoLabel && "font-mono")}>
            {label}
          </Label>
          {description && (
            <p className="text-muted-foreground text-[10px] leading-tight">{description}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <Switch
            id={inputId}
            checked={checked}
            onCheckedChange={(next) => {
              onCommit(next === catalogBool ? null : next);
            }}
          />
          <span className="text-muted-foreground text-[10px] tabular-nums">
            {hasOverride
              ? t("ai:providerSettings.overridden")
              : t("ai:providerSettings.defaultValue", { value: catalogDisplay })}
          </span>
        </div>
      </div>
    );
  }

  // --- Number / string: blur-to-commit input ---
  const commit = () => {
    if (draft.trim() === "") {
      onCommit(null);
      return;
    }
    if (type === "number") {
      const parsed = Number(draft);
      if (!Number.isFinite(parsed)) {
        setDraft(
          overrideValue !== undefined && overrideValue !== null ? String(overrideValue) : "",
        );
        return;
      }
      const clamped = bounds ? Math.min(Math.max(parsed, bounds.min), bounds.max) : parsed;
      const rounded =
        typeof catalogValue === "number" && Number.isInteger(catalogValue)
          ? Math.round(clamped)
          : clamped;
      if (rounded === catalogValue) {
        onCommit(null);
        setDraft("");
      } else {
        onCommit(rounded);
        setDraft(String(rounded));
      }
      return;
    }
    // string
    if (draft === catalogValue) {
      onCommit(null);
      setDraft("");
    } else {
      onCommit(draft);
    }
  };

  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label htmlFor={inputId} className={cn("text-xs font-medium", monoLabel && "font-mono")}>
          {label}
        </Label>
        {description && (
          <p className="text-muted-foreground text-[10px] leading-tight">{description}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <Input
          id={inputId}
          type={type === "number" ? "number" : "text"}
          inputMode={type === "number" ? "decimal" : "text"}
          step={bounds?.step}
          min={bounds?.min}
          max={bounds?.max}
          value={draft}
          placeholder={catalogDisplay}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          className="bg-background !h-8 w-28 !px-2 !py-1 font-mono !text-sm tabular-nums [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span className="text-muted-foreground text-[10px] tabular-nums">
          {t("ai:providerSettings.effective", { value: effectiveDisplay })}
        </span>
      </div>
    </div>
  );
}

// ============================================================================
// Endpoint group — custom provider URL editor
// ============================================================================

interface EndpointGroupCardProps {
  providerId: string;
  field: ConnectionField;
  value: string;
  onValueChange: (value: string) => void;
  onSave?: (url: string) => void;
}

/**
 * Endpoint URL editor. Full-width input since URLs don't fit the narrow
 * right-column scalar layout. Uses an explicit Save button (URL fields are
 * typed deliberately — blur-to-save risks premature commits on focus shift).
 */
function EndpointGroupCard({
  providerId,
  field,
  value,
  onValueChange,
  onSave,
}: EndpointGroupCardProps) {
  const { t } = useTranslation();
  return (
    <div className="bg-muted/40 space-y-3 rounded-md p-3">
      <div className="space-y-0.5">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide">
            {t("ai:providerSettings.endpoint")}
          </span>
          {field.helpUrl && (
            <ExternalLink
              href={field.helpUrl}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px] transition-colors"
            >
              {t("ai:providerSettings.learnMore")}
              <Icons.ExternalLink className="h-3 w-3" />
            </ExternalLink>
          )}
        </div>
        <p className="text-muted-foreground/80 text-[11px] leading-tight">
          {t("ai:providerSettings.endpointDescription")}
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`baseurl-${providerId}`} className="text-xs font-medium">
          {field.label}
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id={`baseurl-${providerId}`}
            type="url"
            value={value}
            onChange={(e) => onValueChange(e.target.value)}
            placeholder={field.placeholder}
            className="bg-background flex-1 font-mono !text-sm"
          />
          <Button
            type="button"
            onClick={() => onSave?.(value)}
            size="sm"
            variant="outline"
            className="shrink-0"
          >
            {t("ai:providerSettings.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}
