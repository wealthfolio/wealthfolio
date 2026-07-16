import {
  Button,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import type { FC } from "react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import type { MergedModel } from "../types";
import { useChatModelContext } from "../hooks/use-chat-model-context";
import { ThinkingToggle } from "./thinking-toggle";

export const ModelPicker: FC = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { isLoading, currentProvider, currentModelId, selectModel } = useChatModelContext();

  // Get selected/favorite models from provider settings
  const selectedModels = useMemo(() => {
    if (!currentProvider) return [];

    const favoriteIds = currentProvider.favoriteModels ?? [];
    const allModels: MergedModel[] = currentProvider.models ?? [];

    // If no favorites set, fall back to all catalog models
    if (favoriteIds.length === 0) {
      return allModels;
    }

    // Map favorite IDs to full model info
    const models: MergedModel[] = [];
    for (const id of favoriteIds) {
      const model = allModels.find((m) => m.id === id);
      if (model) {
        models.push(model);
      } else {
        // Model was fetched in previous session, create placeholder
        const overrides = currentProvider.modelCapabilityOverrides[id];
        models.push({
          id,
          name: id,
          capabilities: {
            tools: overrides?.tools ?? false,
            thinking: overrides?.thinking ?? false,
            vision: overrides?.vision ?? false,
            streaming: overrides?.streaming ?? true,
          },
          isCatalog: false,
          isFavorite: true,
          hasCapabilityOverrides: !!overrides,
        });
      }
    }
    return models;
  }, [currentProvider]);

  if (isLoading || !currentProvider) {
    return null;
  }

  const provider = currentProvider;
  const currentModel = selectedModels.find((m) => m.id === currentModelId);

  // Get display name for model (strip :latest for Ollama)
  const getDisplayName = (modelId: string): string => {
    if (provider.id === "ollama") {
      return modelId.replace(":latest", "");
    }
    return modelId;
  };

  const handleModelSelect = (modelId: string) => {
    void selectModel(provider.id, modelId);
    setOpen(false);
  };

  const handleAddModels = () => {
    setOpen(false);
    navigate("/settings/ai-providers");
  };

  // If only one model, just show the name without dropdown
  if (selectedModels.length <= 1) {
    return (
      <div className="flex items-center">
        <div className="text-muted-foreground flex items-center gap-1.5 px-3 text-xs">
          <span>{currentModel ? getDisplayName(currentModel.id) : t("ai:model.noModel")}</span>
        </div>
        <ThinkingToggle />
      </div>
    );
  }

  return (
    <div className="flex items-center">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-8 gap-1.5 px-3 text-xs font-normal"
            aria-label={t("ai:model.selectModel")}
          >
            <span>
              {currentModel ? getDisplayName(currentModel.id) : t("ai:model.selectModel")}
            </span>
            <Icons.ChevronDown className="size-3 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-fit min-w-56 p-1.5" align="start" sideOffset={8}>
          <Command>
            <CommandEmpty>{t("ai:model.noModelsAvailable")}</CommandEmpty>
            <CommandGroup>
              {selectedModels.map((model) => {
                const isSelected = model.id === currentModelId;
                return (
                  <CommandItem
                    key={model.id}
                    value={model.id}
                    onSelect={() => handleModelSelect(model.id)}
                    className={`flex cursor-pointer items-center gap-2 px-2 py-1.5 ${
                      isSelected ? "bg-accent" : ""
                    }`}
                  >
                    {isSelected && <Icons.Check className="h-3.5 w-3.5 shrink-0" />}
                    {!isSelected && <div className="h-3.5 w-3.5 shrink-0" />}
                    <span className="whitespace-nowrap">{getDisplayName(model.id)}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                onSelect={handleAddModels}
                className="text-muted-foreground flex cursor-pointer items-center gap-2 px-2 py-1.5 text-xs"
              >
                <Icons.Plus className="h-3 w-3 shrink-0" />
                <span className="whitespace-nowrap">{t("ai:model.addModels")}</span>
              </CommandItem>
            </CommandGroup>
          </Command>
        </PopoverContent>
      </Popover>
      <ThinkingToggle />
    </div>
  );
};
