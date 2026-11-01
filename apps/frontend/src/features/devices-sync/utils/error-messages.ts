import i18n from "i18next";
import { logger } from "@/adapters";

export function rawSyncErrorMessage(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  if (typeof error === "symbol") return error.description ?? "Unknown error";

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

function portfolioRepairMessage(message: string): string | null {
  const lower = message.toLowerCase();
  if (!lower.includes("deleted account link") || !lower.includes("settings > portfolios")) {
    return null;
  }

  const portfolioName = /Portfolio "([^"]+)"/.exec(message)?.[1];
  if (portfolioName) {
    return i18n.t("sync:errors.namedPortfolioRepair", { name: portfolioName });
  }

  return i18n.t("sync:errors.portfolioRepair");
}

function isTechnicalSyncError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("database operation") ||
    lower.includes("internal database") ||
    lower.includes("foreign key") ||
    lower.includes("constraint") ||
    lower.includes("sqlite") ||
    lower.includes("rowid=") ||
    lower.includes("table=") ||
    lower.includes("entity=") ||
    lower.includes(" pk=") ||
    lower.includes("cannot upload snapshot") ||
    lower.includes("snapshot bootstrap failed") ||
    lower.includes("snapshot restore failed")
  );
}

export function userFacingSyncErrorMessage(
  error: unknown,
  fallback = i18n.t("sync:errors.fallback"),
): string {
  const message = rawSyncErrorMessage(error).trim();
  if (!message) return fallback;

  const lower = message.toLowerCase();
  const repairMessage = portfolioRepairMessage(message);
  if (repairMessage) return repairMessage;

  if (lower.includes("sync_source_restore_required")) {
    return i18n.t("sync:errors.restoreRequired");
  }
  if (lower.includes("invalid") && lower.includes("code")) {
    return i18n.t("sync:errors.invalidCode");
  }
  if (lower.includes("expired")) return i18n.t("sync:errors.expired");
  if (lower.includes("cancel")) return i18n.t("sync:errors.cancelled");
  if (lower.includes("network") || lower.includes("fetch")) {
    return i18n.t("sync:errors.network");
  }
  if (lower.includes("timeout")) return i18n.t("sync:errors.timeout");
  if (lower.includes("not found")) return i18n.t("sync:errors.notFound");
  if (lower.includes("decrypt") || lower.includes("authentication")) {
    return i18n.t("sync:errors.security");
  }

  if (isTechnicalSyncError(message)) {
    return i18n.t("sync:errors.technical");
  }

  return fallback;
}

export function logSyncError(context: string, error: unknown): void {
  const message = rawSyncErrorMessage(error);
  logger.error(`[DeviceSync] ${context}: ${message || "Unknown error"}`);
}
