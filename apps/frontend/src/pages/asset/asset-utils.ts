import { Asset, LatestQuoteSnapshot } from "@/lib/types";
import { parseOccSymbol } from "@/lib/occ-symbol";
import { resolveDisplayTimezone } from "@/lib/utils";

export interface WeightedBreakdown {
  name: string;
  weight: number;
}

export interface ParsedAsset extends Asset {
  sectorsList: WeightedBreakdown[];
  countriesList: WeightedBreakdown[];
}

const getDateStringInTimezone = (timezone?: string | null): string => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveDisplayTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return `${year}-${month}-${day}`;
};

export const isExpiredOptionAsset = (asset: Asset, timezone?: string | null): boolean => {
  if (asset.instrumentType !== "OPTION") {
    return false;
  }

  const today = getDateStringInTimezone(timezone);
  const option = asset.metadata?.option as { expiration?: unknown } | undefined;
  const metadataExpiration =
    typeof option?.expiration === "string" && /^\d{4}-\d{2}-\d{2}$/.test(option.expiration)
      ? option.expiration
      : null;
  const parsedExpiration =
    parseOccSymbol(asset.instrumentSymbol ?? "")?.expiration ??
    parseOccSymbol(asset.displayCode ?? "")?.expiration;
  const expiration = metadataExpiration ?? parsedExpiration;

  return !!expiration && expiration < today;
};

export const isStaleQuote = (snapshot?: LatestQuoteSnapshot, asset?: ParsedAsset): boolean => {
  if (!snapshot || asset?.isActive === false) {
    return true;
  }

  return snapshot.isStale;
};

export const getNoQuoteReasonText = (
  snapshot?: LatestQuoteSnapshot,
  asset?: ParsedAsset,
  translate: ((key: string) => string) | undefined = undefined,
): string => {
  if (snapshot?.noQuoteReason?.message) {
    return snapshot.noQuoteReason.message;
  }

  if (asset?.quoteMode === "MANUAL") {
    return "Quote mode is Manual";
  }

  if (asset?.quoteMode === "DISCONTINUED") {
    return translate?.("asset:table.discontinued") ?? "Asset is discontinued";
  }

  if (asset?.isActive === false) {
    return "Asset is inactive";
  }

  return "No data available from provider yet";
};

const normalizeWeight = (weight: unknown): number => {
  if (weight === null || weight === undefined) {
    return 0;
  }
  if (typeof weight === "number") {
    return Number.isNaN(weight) ? 0 : weight;
  }
  if (typeof weight !== "string") {
    return 0;
  }
  const parsed = parseFloat(weight.replace("%", ""));
  if (Number.isNaN(parsed)) {
    return 0;
  }
  return parsed;
};

const parseJsonBreakdown = (value?: string | null): WeightedBreakdown[] => {
  // Handle null, undefined, empty string, or non-string values
  if (!value || typeof value !== "string" || value.trim() === "" || value === "null") {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    // Ensure parsed is an array
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((item) => ({ name: item.name?.trim() ?? "", weight: normalizeWeight(item.weight) }))
      .filter((item) => item.name);
  } catch {
    // Silently return empty array for invalid JSON
    return [];
  }
};

export const formatBreakdownTags = (items: WeightedBreakdown[]): string[] =>
  items.map(
    (item) => `${item.name}:${item.weight <= 1 ? (item.weight * 100).toFixed(0) : item.weight}%`,
  );

export const tagsToBreakdown = (values: string[]): WeightedBreakdown[] =>
  values
    .map((value) => {
      const [rawName, rawWeight] = value.split(":");
      const name = rawName?.trim();
      if (!name) return null;
      const cleanedWeight = rawWeight?.replace("%", "").trim();
      const weight = cleanedWeight ? parseFloat(cleanedWeight) : 0;
      return {
        name,
        weight: Number.isFinite(weight) ? weight : 0,
      };
    })
    .filter(Boolean) as WeightedBreakdown[];

export const toParsedAsset = (asset: Asset): ParsedAsset => {
  // Legacy data is in metadata.legacy (for migration purposes)
  // New data should come from taxonomies
  const legacy = asset.metadata?.legacy as
    | {
        sectors?: string | null;
        countries?: string | null;
      }
    | undefined;

  return {
    ...asset,
    sectorsList: parseJsonBreakdown(legacy?.sectors ?? null),
    countriesList: parseJsonBreakdown(legacy?.countries ?? null),
  };
};
