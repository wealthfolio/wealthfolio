// Alternative Assets Commands
import type {
  AlternativeAssetHolding,
  CreateAlternativeAssetRequest,
  CreateAlternativeAssetResponse,
  UpdateValuationRequest,
  UpdateValuationResponse,
  LinkLiabilityRequest,
  NetWorthResponse,
  NetWorthHistoryPoint,
} from "@/lib/types";

import { invoke } from "./platform";

/**
 * Create a new alternative asset (property, vehicle, collectible, precious metal, liability, or other)
 * This creates an asset record and initial valuation quote.
 * NOTE: No account or activity is created - alternative assets are standalone.
 */
export const createAlternativeAsset = async (
  request: CreateAlternativeAssetRequest,
): Promise<CreateAlternativeAssetResponse> => {
  return invoke<CreateAlternativeAssetResponse>("create_alternative_asset", { request });
};

/**
 * Update the valuation of an alternative asset
 * Creates a new quote record with the provided value and date.
 */
export const updateAlternativeAssetValuation = async (
  assetId: string,
  request: UpdateValuationRequest,
): Promise<UpdateValuationResponse> => {
  return invoke<UpdateValuationResponse>("update_alternative_asset_valuation", {
    assetId,
    request,
  });
};

/**
 * Delete an alternative asset
 * This deletes the asset record and all associated valuation quotes.
 * Any linked liabilities will be unlinked but not deleted.
 */
export const deleteAlternativeAsset = async (assetId: string): Promise<void> => {
  return invoke<void>("delete_alternative_asset", { assetId });
};

/**
 * Link a liability to an asset (UI-only aggregation)
 * This stores the link in the liability's metadata for display purposes only.
 */
export const linkLiability = async (
  liabilityId: string,
  request: LinkLiabilityRequest,
): Promise<void> => {
  return invoke<void>("link_liability", { liabilityId, request });
};

/**
 * Unlink a liability from its linked asset
 * Removes the linked_asset_id from the liability's metadata.
 */
export const unlinkLiability = async (liabilityId: string): Promise<void> => {
  return invoke<void>("unlink_liability", { liabilityId });
};

/**
 * Get the net worth calculation
 * @param date Optional date for as-of calculation (ISO format: YYYY-MM-DD). Defaults to today.
 */
export const getNetWorth = async (date?: string): Promise<NetWorthResponse> => {
  return invoke<NetWorthResponse>("get_net_worth", { date });
};

/**
 * Update an alternative asset's details (name, notes, and/or metadata)
 * @param assetId The ID of the asset to update
 * @param metadata The metadata key-value pairs to save
 * @param name Optional new name for the asset
 * @param notes Optional notes for the asset (stored in asset.notes, not metadata)
 */
export const updateAlternativeAssetMetadata = async (
  assetId: string,
  metadata: Record<string, string>,
  name?: string,
  notes?: string | null,
): Promise<void> => {
  return invoke<void>("update_alternative_asset_metadata", {
    assetId,
    name,
    metadata,
    notes,
  });
};

/**
 * Get all alternative holdings (assets with their latest valuations).
 * This retrieves all alternative assets (Property, Vehicle, Collectible,
 * PhysicalPrecious, Liability, Other) formatted for display in the Holdings page.
 */
export const getAlternativeHoldings = async (): Promise<AlternativeAssetHolding[]> => {
  return invoke<AlternativeAssetHolding[]>("get_alternative_holdings", {});
};

/**
 * Get net worth history over a date range
 * @param startDate Start date (ISO format: YYYY-MM-DD)
 * @param endDate End date (ISO format: YYYY-MM-DD)
 */
export const getNetWorthHistory = async (
  startDate: string,
  endDate: string,
): Promise<NetWorthHistoryPoint[]> => {
  return invoke<NetWorthHistoryPoint[]>("get_net_worth_history", {
    startDate,
    endDate,
  });
};

export interface LoanCalculationRow {
  date: string;
  openingBalance: number;
  scheduledPayment: boolean;
  balance: number;
  payment: number;
  extraPayment: number;
  principal: number;
  interest: number;
  confirmed: boolean;
  balanceAdjustment: number;
}
export interface LoanCalculation {
  currentBalance: number;
  annualRate: number;
  paymentAmount: number;
  frequency: "monthly" | "biweekly" | "accelerated_biweekly";
  interestMethod: "nominal_periodic" | "monthly" | "semiannual";
  calculationStartDate: string;
  rows: LoanCalculationRow[];
  remainingPayments: number;
  interestToDate: number;
  projectedInterest: number;
  residualBalance: number;
  residualInterest: number;
  payoffDate: string | null;
}
export const calculateLoan = (request: {
  metadata: Record<string, unknown>;
  balances: { date: string; balance: number; notes?: string | null }[];
  asOf: string;
}): Promise<LoanCalculation | null> => invoke("calculate_loan", { request });

export interface LoanRecalculation {
  paymentAmount: number;
  remainingPayments: number;
  currentBalance: number;
}
export const recalculateLoan = (
  request: Parameters<typeof calculateLoan>[0] & { annualRate: number },
): Promise<LoanRecalculation | null> => invoke("recalculate_loan", { request });
