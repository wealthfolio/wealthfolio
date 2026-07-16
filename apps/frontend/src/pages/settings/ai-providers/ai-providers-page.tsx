import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Button } from "@wealthfolio/ui/components/ui/button";

import { SettingsHeader } from "../settings-header";
import {
  ProviderSettingsCard,
  useAiProviders,
  useUpdateAiProviderSettings,
  useSetDefaultAiProvider,
  useAiProviderApiKey,
  useListAiModels,
} from "@/features/ai-assistant";
import type { ModelCapabilityOverrides, ProviderTuningOverrides } from "@/lib/types";

/**
 * AI Providers settings page - configure AI provider API keys and preferences.
 */
export default function AiProvidersPage() {
  const { t } = useTranslation();
  const { data, isLoading, error, refetch } = useAiProviders();
  const { mutate: updateSettings } = useUpdateAiProviderSettings();
  const { mutate: setDefault } = useSetDefaultAiProvider();

  const providers = useMemo(() => data?.providers ?? [], [data?.providers]);

  const handleCustomUrlChange = (providerId: string, customUrl: string) => {
    updateSettings({ providerId, customUrl });
  };

  const handleSelectModel = (providerId: string, modelId: string) => {
    updateSettings({ providerId, selectedModel: modelId });
  };

  const handleSetFavoriteModels = (providerId: string, modelIds: string[]) => {
    updateSettings({ providerId, favoriteModels: modelIds });
  };

  const handleSetCapabilityOverride = (
    providerId: string,
    modelId: string,
    overrides: ModelCapabilityOverrides | null,
  ) => {
    updateSettings({
      providerId,
      modelCapabilityOverride: {
        modelId,
        overrides: overrides ?? undefined,
      },
    });
  };

  const handleToolsAllowlistChange = (providerId: string, tools: string[] | null) => {
    updateSettings({ providerId, toolsAllowlist: tools });
  };

  const handleTuningOverridesChange = (
    providerId: string,
    overrides: ProviderTuningOverrides | null,
  ) => {
    updateSettings({ providerId, tuningOverrides: overrides });
  };

  if (isLoading) {
    return (
      <div className="text-foreground space-y-6">
        <SettingsHeader
          heading={t("settings:nav.items.ai_providers")}
          text={t("settings:ai_providers_description")}
        />
        <Separator />
        <div className="overflow-hidden rounded-lg border">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="flex items-center gap-4 border-b px-4 py-3 last:border-b-0">
              <Skeleton className="h-9 w-9 rounded-lg" />
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-5 w-16 rounded-full" />
                </div>
                <Skeleton className="h-3 w-64" />
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
          heading={t("settings:nav.items.ai_providers")}
          text={t("settings:ai_providers_description")}
        />
        <Separator />
        <div className="border-destructive/20 bg-destructive/5 rounded-lg border p-6">
          <div className="flex items-start gap-3">
            <Icons.XCircle className="text-destructive mt-0.5 h-5 w-5 shrink-0" />
            <div className="space-y-2">
              <h3 className="text-destructive font-medium">
                {t("settings:ai_providers_load_error")}
              </h3>
              <p className="text-muted-foreground text-sm">{error.message}</p>
              <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-2">
                <Icons.Refresh className="mr-2 h-4 w-4" />
                {t("common:retry")}
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const sortedProviders = [...providers].sort((a, b) => a.priority - b.priority);

  return (
    <div className="text-foreground space-y-6">
      <SettingsHeader
        heading={t("settings:nav.items.ai_providers")}
        text={t("settings:ai_providers_description")}
      />
      <Separator />
      <div>
        {sortedProviders.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Icons.Sparkles className="text-muted-foreground mb-4 h-12 w-12" />
            <h3 className="text-lg font-semibold">{t("settings:ai_providers_empty_title")}</h3>
            <p className="text-muted-foreground mt-2 max-w-md text-sm">
              {t("settings:ai_providers_empty_description")}
            </p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border">
            {sortedProviders.map((provider, index, arr) => (
              <ProviderSettingsCardWrapper
                key={provider.id}
                provider={provider}
                isLast={index === arr.length - 1}
                onToggleEnabled={(enabled) => updateSettings({ providerId: provider.id, enabled })}
                onSetDefault={() => setDefault({ providerId: provider.id })}
                onCustomUrlChange={(url) => handleCustomUrlChange(provider.id, url)}
                onSelectModel={(modelId) => handleSelectModel(provider.id, modelId)}
                onSetFavoriteModels={(modelIds) => handleSetFavoriteModels(provider.id, modelIds)}
                onSetCapabilityOverride={(modelId, overrides) =>
                  handleSetCapabilityOverride(provider.id, modelId, overrides)
                }
                onToolsAllowlistChange={(tools) => handleToolsAllowlistChange(provider.id, tools)}
                onTuningOverridesChange={(overrides) =>
                  handleTuningOverridesChange(provider.id, overrides)
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Wrapper component to provide API key hooks and model fetching to each provider card.
 */
function ProviderSettingsCardWrapper({
  provider,
  isLast,
  onToggleEnabled,
  onSetDefault,
  onCustomUrlChange,
  onSelectModel,
  onSetFavoriteModels,
  onSetCapabilityOverride,
  onToolsAllowlistChange,
  onTuningOverridesChange,
}: {
  provider: Parameters<typeof ProviderSettingsCard>[0]["provider"];
  isLast: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onSetDefault: () => void;
  onCustomUrlChange: (url: string) => void;
  onSelectModel: (modelId: string) => void;
  onSetFavoriteModels: (modelIds: string[]) => void;
  onSetCapabilityOverride: (modelId: string, overrides: ModelCapabilityOverrides | null) => void;
  onToolsAllowlistChange: (tools: string[] | null) => void;
  onTuningOverridesChange: (overrides: ProviderTuningOverrides | null) => void;
}) {
  const { setApiKey, deleteApiKey, revealApiKey } = useAiProviderApiKey(provider.id);
  const [modelComboboxOpen, setModelComboboxOpen] = useState(false);

  // Enable query when combobox opens (if provider supports it and has API key)
  const canFetchModels =
    provider.supportsModelListing && (provider.hasApiKey || provider.type !== "api");

  const {
    data: modelsResponse,
    isLoading: isFetchingModels,
    error: fetchModelsError,
    refetch: refetchModels,
  } = useListAiModels(provider.id, {
    enabled: modelComboboxOpen && canFetchModels,
  });

  const fetchedModels = modelsResponse?.models ?? [];

  return (
    <ProviderSettingsCard
      provider={provider}
      isLast={isLast}
      onToggleEnabled={onToggleEnabled}
      onSetDefault={onSetDefault}
      onSaveApiKey={(apiKey) => setApiKey.mutate(apiKey)}
      onDeleteApiKey={() => deleteApiKey.mutate()}
      onRevealApiKey={revealApiKey}
      onCustomUrlChange={onCustomUrlChange}
      onSelectModel={onSelectModel}
      onSetFavoriteModels={onSetFavoriteModels}
      onSetCapabilityOverride={onSetCapabilityOverride}
      onToolsAllowlistChange={onToolsAllowlistChange}
      onTuningOverridesChange={onTuningOverridesChange}
      modelComboboxOpen={modelComboboxOpen}
      onModelComboboxOpenChange={setModelComboboxOpen}
      fetchedModels={fetchedModels}
      isFetchingModels={isFetchingModels}
      fetchModelsError={fetchModelsError?.message ?? null}
      onRefreshModels={() => refetchModels()}
    />
  );
}
