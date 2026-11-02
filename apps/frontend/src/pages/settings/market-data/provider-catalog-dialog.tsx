import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { MarketDataProviderSetting } from "@/adapters";
import { useNameComparator } from "@/hooks/use-name-comparator";
import {
  getProviderCoverage,
  getProviderDescription,
  getProviderInstruments,
  getProviderName,
} from "@/lib/provider-labels";
import { Badge } from "@wealthfolio/ui/components/ui/badge";
import { Button } from "@wealthfolio/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@wealthfolio/ui/components/ui/dialog";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { Input } from "@wealthfolio/ui/components/ui/input";

import { ProviderLogo } from "./provider-logo";

interface ProviderCatalogDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Built-in providers that are turned off. */
  providers: MarketDataProviderSetting[];
  onAdd: (provider: MarketDataProviderSetting) => void;
}

/** The built-in providers that are off, ready to turn on. */
export function ProviderCatalogDialog({
  open,
  onOpenChange,
  providers,
  onAdd,
}: ProviderCatalogDialogProps) {
  const { t } = useTranslation();
  const compareNames = useNameComparator();
  const [query, setQuery] = useState("");

  const entries = useMemo(
    () =>
      providers
        .map((provider) => ({
          provider,
          name: getProviderName(t, provider.id, provider.name),
          description: provider.description
            ? getProviderDescription(t, provider.id, provider.description)
            : "",
          instruments: provider.capabilities
            ? getProviderInstruments(t, provider.capabilities.instruments)
            : "",
          coverage: provider.capabilities
            ? getProviderCoverage(t, provider.capabilities.coverage)
            : "",
        }))
        .sort((a, b) => compareNames(a.name, b.name)),
    [providers, t, compareNames],
  );

  const search = query.trim().toLocaleLowerCase();
  const matches = search
    ? entries.filter((entry) =>
        [entry.name, entry.description, entry.instruments, entry.coverage].some((text) =>
          text.toLocaleLowerCase().includes(search),
        ),
      )
    : entries;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("settings:market_data_page.catalog_title")}</DialogTitle>
          <DialogDescription>
            {t("settings:market_data_page.catalog_description")}
          </DialogDescription>
        </DialogHeader>

        {entries.length > 0 && (
          <div className="relative">
            <Icons.Search className="text-muted-foreground absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2" />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("settings:market_data_page.catalog_search")}
              aria-label={t("settings:market_data_page.catalog_search")}
              className="ps-9"
            />
          </div>
        )}

        {entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t("settings:market_data_page.catalog_empty")}
          </p>
        ) : (
          matches.length === 0 && (
            <p className="text-muted-foreground text-sm">
              {t("settings:market_data_page.catalog_no_results")}
            </p>
          )
        )}

        {matches.length > 0 && (
          <ul
            className="grid gap-3 sm:grid-cols-2"
            aria-label={t("settings:market_data_page.catalog_title")}
          >
            {matches.map(({ provider, name, description, instruments, coverage }) => (
              <li key={provider.id} className="flex flex-col gap-3 rounded-lg border p-3">
                <div className="flex items-start gap-3">
                  <ProviderLogo logoFilename={provider.logoFilename} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium break-words">
                      <bdi>{name}</bdi>
                    </p>
                    {instruments && <p className="text-muted-foreground text-xs">{instruments}</p>}
                  </div>
                </div>
                {description && (
                  <p className="text-muted-foreground line-clamp-2 text-xs">{description}</p>
                )}
                <div className="mt-auto flex flex-wrap items-center gap-2">
                  {coverage && <Badge variant="secondary">{coverage}</Badge>}
                  <Badge variant="secondary">
                    {provider.requiresApiKey
                      ? provider.hasApiKey
                        ? t("settings:market_data_page.api_key_saved")
                        : t("settings:market_data_page.api_key_required")
                      : t("settings:market_data_page.feature_no_api_key")}
                  </Badge>
                  {provider.assetCount > 0 && (
                    <Badge variant="secondary">
                      {t("settings:market_data_page.assets_count", { count: provider.assetCount })}
                    </Badge>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="ms-auto"
                    onClick={() => {
                      // The parent closes the dialog itself, so clear the search here.
                      setQuery("");
                      onAdd(provider);
                    }}
                    aria-label={t("settings:market_data_page.catalog_add_named", { name })}
                  >
                    {t("settings:market_data_page.catalog_add")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
