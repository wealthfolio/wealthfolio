import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Separator } from "@wealthfolio/ui/components/ui/separator";
import { Skeleton } from "@wealthfolio/ui/components/ui/skeleton";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Button } from "@wealthfolio/ui/components/ui/button";

import { Card, CardContent } from "@wealthfolio/ui/components/ui/card";
import { SettingsList } from "@/components/settings-list";
import { SettingsHeader } from "../settings-header";
import {
  ProviderSettingsCard,
  useAiProviders,
  useUpdateAiProviderSettings,
  useSetDefaultAiProvider,
  useAiProviderApiKey,
  useListAiModels,
} from "@/features/ai-assistant";
import type {
  ModelCapabilityOverrides,
  ModelCapabilityOverrideUpdate,
  ProviderTuningOverrides,
} from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@wealthfolio/ui/components/ui/alert";

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

  const handleSetFavoriteModels = (
    providerId: string,
    modelIds: string[],
    modelCapabilityOverride?: ModelCapabilityOverrideUpdate,
  ) => {
    updateSettings({ providerId, favoriteModels: modelIds, modelCapabilityOverride });
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
        <Card>
          <CardContent className="pt-6">
            <ul
              className="divide-y [&>li]:py-3 [&>li:first-child]:pt-0 [&>li:last-child]:pb-0"
              aria-hidden
            >
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <li key={i} className="flex items-center gap-3">
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
          heading={t("settings:nav.items.ai_providers")}
          text={t("settings:ai_providers_description")}
        />
        <Separator />
        <Alert variant="destructive" className="p-6">
          <Icons.XCircle className="size-5" />
          <AlertTitle role="heading" aria-level={3}>
            {t("settings:ai_providers_load_error")}
          </AlertTitle>
          <AlertDescription>
            {error.message}
            <div className="mt-4">
              <Button
                variant="outline"
                size="sm"
                onClick={() => refetch()}
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
          <Card>
            <CardContent className="pt-6">
              <SettingsList label={t("settings:nav.items.ai_providers")}>
                {sortedProviders.map((provider) => (
                  <li key={provider.id}>
                    <ProviderSettingsCardWrapper
                      provider={provider}
                      onToggleEnabled={(enabled) =>
                        updateSettings({ providerId: provider.id, enabled })
                      }
                      onSetDefault={() => setDefault({ providerId: provider.id })}
                      onCustomUrlChange={(url) => handleCustomUrlChange(provider.id, url)}
                      onSelectModel={(modelId) => handleSelectModel(provider.id, modelId)}
                      onSetFavoriteModels={(modelIds, capabilityOverride) =>
                        handleSetFavoriteModels(provider.id, modelIds, capabilityOverride)
                      }
                      onSetCapabilityOverride={(modelId, overrides) =>
                        handleSetCapabilityOverride(provider.id, modelId, overrides)
                      }
                      onToolsAllowlistChange={(tools) =>
                        handleToolsAllowlistChange(provider.id, tools)
                      }
                      onTuningOverridesChange={(overrides) =>
                        handleTuningOverridesChange(provider.id, overrides)
                      }
                    />
                  </li>
                ))}
              </SettingsList>
            </CardContent>
          </Card>
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
  onToggleEnabled: (enabled: boolean) => void;
  onSetDefault: () => void;
  onCustomUrlChange: (url: string) => void;
  onSelectModel: (modelId: string) => void;
  onSetFavoriteModels: (
    modelIds: string[],
    capabilityOverride?: ModelCapabilityOverrideUpdate,
  ) => void;
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
