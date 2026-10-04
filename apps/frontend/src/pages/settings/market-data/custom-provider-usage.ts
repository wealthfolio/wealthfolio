import type { Asset } from "@/lib/types";
import type {
  CustomProviderWithSources,
  NewCustomProviderSource,
} from "@/lib/types/custom-provider";

type IdentitySource = Pick<NewCustomProviderSource, "url" | "method" | "body">;

/** Mirrors `CustomScraperProvider::source_has_identity_placeholder` in core. */
export function hasIdentityPlaceholder(source: IdentitySource): boolean {
  const hasIdentity = (template?: string) =>
    !!template && (template.includes("{SYMBOL}") || template.includes("{ISIN}"));
  return hasIdentity(source.url) || (source.method === "POST" && hasIdentity(source.body));
}

/** Whether the provider is actually tried for securities not assigned to it. */
export function servesAsFallback(provider: CustomProviderWithSources): boolean {
  return provider.useAsFallback && provider.sources.some(hasIdentityPlaceholder);
}

export interface CustomProviderUsage {
  /** Securities whose market data provider is this custom provider. */
  assigned: Asset[];
  /** Securities that only map a symbol for it; they reach it through fallback alone. */
  mappedOnly: Asset[];
  /**
   * Securities that still carry its code under another chosen provider. It never serves
   * them, but the backend's delete check still counts them.
   */
  leftover: Asset[];
}

export const EMPTY_USAGE: CustomProviderUsage = { assigned: [], mappedOnly: [], leftover: [] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assetUsageLabel(asset: Asset): string {
  if (asset.kind === "FX" && asset.instrumentSymbol && asset.quoteCcy) {
    return `${asset.instrumentSymbol}/${asset.quoteCcy}`;
  }
  return asset.displayCode || asset.instrumentSymbol || asset.name || asset.id;
}

/**
 * Classify assets the way the backend reads them. `assigned` mirrors
 * `QuoteContext::assigned_custom_provider`; together the three groups match the
 * delete check (`get_asset_count_for_provider`).
 */
export function getCustomProviderUsage(assets: Asset[], code: string): CustomProviderUsage {
  const assigned: Asset[] = [];
  const mappedOnly: Asset[] = [];
  const leftover: Asset[] = [];
  for (const asset of assets) {
    const config = asset.providerConfig;
    if (!config) continue;
    const hasCode = config.custom_provider_code === code;
    if (hasCode && config.preferred_provider === "CUSTOM_SCRAPER") {
      assigned.push(asset);
    } else if (isRecord(config.overrides) && `CUSTOM:${code}` in config.overrides) {
      // Saving after removing the mapping also clears a leftover code.
      mappedOnly.push(asset);
    } else if (hasCode) {
      leftover.push(asset);
    }
  }
  const byLabel = (a: Asset, b: Asset) => assetUsageLabel(a).localeCompare(assetUsageLabel(b));
  return {
    assigned: assigned.sort(byLabel),
    mappedOnly: mappedOnly.sort(byLabel),
    leftover: leftover.sort(byLabel),
  };
}

/** Securities the provider serves or maps a symbol for. */
export function usageCount(usage: CustomProviderUsage): number {
  return usage.assigned.length + usage.mappedOnly.length;
}

/** Every reference that blocks deleting the provider. */
export function deleteBlockerCount(usage: CustomProviderUsage): number {
  return usageCount(usage) + usage.leftover.length;
}
