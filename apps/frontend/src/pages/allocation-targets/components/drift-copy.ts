export function categoryNoun(
  taxonomyId: string,
  taxonomyName: string | undefined,
  count: number,
  language = "en",
) {
  const isChinese = language === "zh-CN";
  const normalized = `${taxonomyId} ${taxonomyName ?? ""}`.toLowerCase().replace(/[_-]+/g, " ");
  if (isChinese) {
    if (normalized.includes("asset classes")) return "资产类别";
    if (normalized.includes("regions")) return "地区";
    if (normalized.includes("industries")) return "行业";
    return "分类";
  }
  if (normalized.includes("asset classes")) return count === 1 ? "asset class" : "asset classes";
  if (normalized.includes("regions")) return count === 1 ? "region" : "regions";
  if (normalized.includes("industries")) return count === 1 ? "industry" : "industries";
  return count === 1 ? "category" : "categories";
}

export function taxonomyLabel(taxonomyId: string, taxonomyName: string | undefined, language = "en") {
  const isChinese = language === "zh-CN";
  const normalized = `${taxonomyId} ${taxonomyName ?? ""}`.toLowerCase().replace(/[_-]+/g, " ");
  if (normalized.includes("asset classes")) return isChinese ? "资产类别" : "Asset classes";
  if (normalized.includes("regions")) return isChinese ? "地区" : "Regions";
  if (normalized.includes("industries")) return isChinese ? "行业" : "Industries";
  return isChinese ? "分类" : "Categories";
}

export function targetLabel(targetName: string | undefined, language = "en") {
  const trimmed = targetName?.trim();
  const isChinese = language === "zh-CN";
  if (!trimmed) return isChinese ? "已保存目标" : "saved target";
  if (isChinese) return trimmed.endsWith("目标") ? trimmed : `${trimmed}目标`;
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
