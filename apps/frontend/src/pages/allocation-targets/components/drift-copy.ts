export function categoryNoun(taxonomyId: string, taxonomyName: string | undefined, count: number) {
  const normalized = `${taxonomyId} ${taxonomyName ?? ""}`.toLowerCase().replace(/[_-]+/g, " ");
  if (normalized.includes("asset classes")) return count === 1 ? "asset class" : "asset classes";
  if (normalized.includes("regions")) return count === 1 ? "region" : "regions";
  if (normalized.includes("industries")) return count === 1 ? "industry" : "industries";
  return count === 1 ? "category" : "categories";
}

export function taxonomyLabel(taxonomyId: string, taxonomyName: string | undefined) {
  const normalized = `${taxonomyId} ${taxonomyName ?? ""}`.toLowerCase().replace(/[_-]+/g, " ");
  if (normalized.includes("asset classes")) return "Asset classes";
  if (normalized.includes("regions")) return "Regions";
  if (normalized.includes("industries")) return "Industries";
  return "Categories";
}

export function targetLabel(targetName: string | undefined) {
  const trimmed = targetName?.trim();
  if (!trimmed) return "saved target";
  return /\btarget$/i.test(trimmed) ? trimmed : `${trimmed} target`;
}

export function formatPp(bps: number, decimals = 1) {
  const pp = bps / 100;
  return `${pp > 0 ? "+" : ""}${pp.toFixed(decimals)}%`;
}

export function formatTolerance(bps: number) {
  const pp = bps / 100;
  const value = Number.isInteger(pp) ? pp.toFixed(0) : pp.toFixed(1);
  return `±${value}%`;
}

export function formatRoundedCurrency(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return Math.round(amount).toLocaleString("en-US");
  }
}
