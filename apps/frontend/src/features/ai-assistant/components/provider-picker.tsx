import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import type { FC } from "react";
import { useTranslation } from "react-i18next";

import { ProviderIcon } from "./provider-icons";
import { useProviderPicker } from "../hooks/use-provider-picker";

export const ProviderPicker: FC = () => {
  const { t } = useTranslation();
  const { isLoading, activeProviders, currentProviderId, currentProvider, selectProvider } =
    useProviderPicker();

  if (isLoading) {
    return (
      <div className="flex h-9 items-center gap-2 px-2">
        <Skeleton className="h-4 w-4 rounded" />
        <Skeleton className="h-4 w-24" />
      </div>
    );
  }

  if (activeProviders.length === 0) {
    return (
      <div className="text-muted-foreground hover:bg-muted flex h-9 items-center gap-2 rounded-md px-2 text-sm transition-colors">
        <Icons.Settings className="h-4 w-4" />
        <span>{t("ai:provider.noProvidersConfigured")}</span>
      </div>
    );
  }

  return (
    <Select value={currentProviderId} onValueChange={selectProvider}>
      <SelectTrigger className="hover:bg-muted h-9 w-auto gap-2 border-none bg-transparent px-2 shadow-none focus:ring-0">
        <SelectValue>
          {currentProvider && (
            <span className="flex items-center gap-2">
              <ProviderIcon name={currentProvider.icon} size={16} />
              <span>{currentProvider.name}</span>
            </span>
          )}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {activeProviders.map((provider) => (
          <SelectItem key={provider.id} value={provider.id}>
            <span className="flex items-center gap-2">
              <ProviderIcon name={provider.icon} size={16} />
              <span>{provider.name}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};
