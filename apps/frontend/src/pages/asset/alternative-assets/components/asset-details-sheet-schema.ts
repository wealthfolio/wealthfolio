import * as z from "zod";
import { AlternativeAssetKind } from "@/lib/types";
import { parseLocalDate } from "@/lib/utils";

// Property types
export const PROPERTY_TYPES = [
  { value: "residence", label: "Residence" },
  { value: "rental", label: "Rental Property" },
  { value: "land", label: "Land" },
  { value: "commercial", label: "Commercial" },
] as const;

// Collectible types
export const COLLECTIBLE_TYPES = [
  { value: "art", label: "Art" },
  { value: "wine", label: "Wine" },
  { value: "watch", label: "Watch" },
  { value: "jewelry", label: "Jewelry" },
  { value: "memorabilia", label: "Memorabilia" },
] as const;

// Metal types (re-exported for convenience)
export const METAL_TYPES = [
  { value: "gold", label: "Gold" },
  { value: "silver", label: "Silver" },
  { value: "platinum", label: "Platinum" },
  { value: "palladium", label: "Palladium" },
] as const;

// Weight units (re-exported for convenience)
export const WEIGHT_UNITS = [
  { value: "oz", label: "Troy Ounce (oz)" },
  { value: "g", label: "Gram (g)" },
  { value: "kg", label: "Kilogram (kg)" },
] as const;

// Liability types (re-exported for convenience)
export const LIABILITY_TYPES = [
  { value: "mortgage", label: "Mortgage" },
  { value: "auto_loan", label: "Auto Loan" },
  { value: "student_loan", label: "Student Loan" },
  { value: "credit_card", label: "Credit Card" },
  { value: "personal_loan", label: "Personal Loan" },
  { value: "heloc", label: "HELOC" },
] as const;

// Vehicle types (optional, for future use)
export const VEHICLE_TYPES = [
  { value: "car", label: "Car" },
  { value: "motorcycle", label: "Motorcycle" },
  { value: "boat", label: "Boat" },
  { value: "rv", label: "RV" },
] as const;

// Base schema for common fields across all asset types
const baseSchema = z.object({
  // Name field (required, editable)
  name: z.string().min(1, "Name is required").max(100, "Name must be less than 100 characters"),
  // Common fields for all types
  purchasePrice: z.coerce
    .number()
    .positive("Purchase price must be greater than 0")
    .optional()
    .nullable(),
  purchaseDate: z.date().optional().nullable(),
  // Percentage of this asset you own (e.g. 50 for a house split with a spouse).
  // Only affects net worth totals, not the displayed market value.
  ownershipPct: z.coerce
    .number()
    .min(1, "Ownership must be greater than 0%")
    .max(100, "Ownership cannot exceed 100%")
    .optional()
    .nullable(),
  notes: z.string().max(1000, "Notes must be less than 1000 characters").optional().nullable(),
});

// Property-specific schema
export const propertyDetailsSchema = baseSchema.extend({
  kind: z.literal(AlternativeAssetKind.PROPERTY),
  address: z.string().max(200, "Address must be less than 200 characters").optional().nullable(),
  propertyType: z.enum(["residence", "rental", "land", "commercial"]).optional().nullable(),
});

// Vehicle-specific schema
export const vehicleDetailsSchema = baseSchema.extend({
  kind: z.literal(AlternativeAssetKind.VEHICLE),
  vehicleType: z.enum(["car", "motorcycle", "boat", "rv"]).optional().nullable(),
  description: z
    .string()
    .max(200, "Description must be less than 200 characters")
    .optional()
    .nullable(),
});

// Collectible-specific schema
export const collectibleDetailsSchema = baseSchema.extend({
  kind: z.literal(AlternativeAssetKind.COLLECTIBLE),
  collectibleType: z.enum(["art", "wine", "watch", "jewelry", "memorabilia"]).optional().nullable(),
  description: z
    .string()
    .max(200, "Description must be less than 200 characters")
    .optional()
    .nullable(),
});

// Precious metal-specific schema
export const preciousMetalDetailsSchema = baseSchema.extend({
  kind: z.literal(AlternativeAssetKind.PRECIOUS_METAL),
  metalType: z.enum(["gold", "silver", "platinum", "palladium"]).optional().nullable(),
  quantity: z.coerce.number().positive("Quantity must be greater than 0").optional().nullable(),
  unit: z.enum(["oz", "g", "kg"]).optional().nullable(),
  description: z
    .string()
    .max(200, "Description must be less than 200 characters")
    .optional()
    .nullable(),
});

// Liability-specific schema
export const liabilityDetailsSchema = baseSchema.extend({
  kind: z.literal(AlternativeAssetKind.LIABILITY),
  liabilityType: z
    .enum(["mortgage", "auto_loan", "student_loan", "credit_card", "personal_loan", "heloc"])
    .optional()
    .nullable(),
  originalAmount: z.coerce
    .number()
    .positive("Original amount must be greater than 0")
    .optional()
    .nullable(),
  originationDate: z.date().optional().nullable(),
  interestRate: z.coerce
    .number()
    .min(0, "Interest rate must be 0 or greater")
    .max(100, "Interest rate must be 100 or less")
    .optional()
    .nullable(),
  linkedAssetId: z.string().optional().nullable(),
});

// Other asset schema (generic)
export const otherDetailsSchema = baseSchema.extend({
  kind: z.literal(AlternativeAssetKind.OTHER),
  description: z
    .string()
    .max(200, "Description must be less than 200 characters")
    .optional()
    .nullable(),
});

// Discriminated union of all asset type schemas
export const assetDetailsSchema = z.discriminatedUnion("kind", [
  propertyDetailsSchema,
  vehicleDetailsSchema,
  collectibleDetailsSchema,
  preciousMetalDetailsSchema,
  liabilityDetailsSchema,
  otherDetailsSchema,
]);

// Type for the combined form values
export type AssetDetailsFormValues = z.infer<typeof assetDetailsSchema>;

// Type-specific form value types for convenience
export type PropertyDetailsFormValues = z.infer<typeof propertyDetailsSchema>;
export type VehicleDetailsFormValues = z.infer<typeof vehicleDetailsSchema>;
export type CollectibleDetailsFormValues = z.infer<typeof collectibleDetailsSchema>;
export type PreciousMetalDetailsFormValues = z.infer<typeof preciousMetalDetailsSchema>;
export type LiabilityDetailsFormValues = z.infer<typeof liabilityDetailsSchema>;
export type OtherDetailsFormValues = z.infer<typeof otherDetailsSchema>;

// Helper function to get default form values based on asset kind and existing metadata
export function getDefaultDetailsFormValues(
  kind: AlternativeAssetKind,
  name: string,
  metadata?: Record<string, unknown>,
  notes?: string | null,
): AssetDetailsFormValues {
  const base = {
    name,
    purchasePrice: metadata?.purchase_price ? parseFloat(metadata.purchase_price as string) : null,
    purchaseDate: metadata?.purchase_date ? parseLocalDate(metadata.purchase_date as string) : null,
    ownershipPct: metadata?.ownership_pct ? parseFloat(metadata.ownership_pct as string) : null,
    notes: notes ?? null,
  };

  // Read sub_type from metadata (unified field for all asset types)
  const subType = (metadata?.sub_type as string) ?? null;

  switch (kind) {
    case AlternativeAssetKind.PROPERTY:
      return {
        ...base,
        kind: AlternativeAssetKind.PROPERTY,
        address: (metadata?.address as string) ?? null,
        propertyType: subType as PropertyDetailsFormValues["propertyType"],
      };

    case AlternativeAssetKind.VEHICLE:
      return {
        ...base,
        kind: AlternativeAssetKind.VEHICLE,
        vehicleType: subType as VehicleDetailsFormValues["vehicleType"],
        description: (metadata?.description as string) ?? null,
      };

    case AlternativeAssetKind.COLLECTIBLE:
      return {
        ...base,
        kind: AlternativeAssetKind.COLLECTIBLE,
        collectibleType: subType as CollectibleDetailsFormValues["collectibleType"],
        description: (metadata?.description as string) ?? null,
      };

    case AlternativeAssetKind.PRECIOUS_METAL:
      return {
        ...base,
        purchasePrice: metadata?.purchase_price_per_unit
          ? parseFloat(metadata.purchase_price_per_unit as string)
          : null,
        kind: AlternativeAssetKind.PRECIOUS_METAL,
        metalType: subType as PreciousMetalDetailsFormValues["metalType"],
        quantity: metadata?.quantity ? parseFloat(metadata.quantity as string) : null,
        unit: (metadata?.unit as PreciousMetalDetailsFormValues["unit"]) ?? null,
        description: (metadata?.description as string) ?? null,
      };

    case AlternativeAssetKind.LIABILITY:
      // For original amount, check both new field (original_amount) and legacy field (purchase_price)
      const origAmount = metadata?.original_amount ?? metadata?.purchase_price;
      // For origination date, check both new field (origination_date) and legacy field (purchase_date)
      const origDate = metadata?.origination_date ?? metadata?.purchase_date;
      return {
        ...base,
        kind: AlternativeAssetKind.LIABILITY,
        liabilityType: subType as LiabilityDetailsFormValues["liabilityType"],
        originalAmount: origAmount ? parseFloat(origAmount as string) : null,
        originationDate: origDate ? parseLocalDate(origDate as string) : null,
        interestRate: metadata?.interest_rate ? parseFloat(metadata.interest_rate as string) : null,
        linkedAssetId: (metadata?.linked_asset_id as string) ?? null,
      };

    case AlternativeAssetKind.OTHER:
    default:
      return {
        ...base,
        kind: AlternativeAssetKind.OTHER,
        description: (metadata?.description as string) ?? null,
      };
  }
}

// Helper function to convert form values to metadata for API
export function formValuesToMetadata(values: AssetDetailsFormValues): Record<string, string> {
  const metadata: Record<string, string> = {};

  // Common fields
  if (values.purchasePrice != null) {
    // For precious metals, use purchase_price_per_unit
    if (values.kind === AlternativeAssetKind.PRECIOUS_METAL) {
      metadata.purchase_price_per_unit = values.purchasePrice.toString();
    } else {
      metadata.purchase_price = values.purchasePrice.toString();
    }
  }

  if (values.purchaseDate) {
    metadata.purchase_date = formatDateToISO(values.purchaseDate);
  }

  if (values.ownershipPct != null) {
    metadata.ownership_pct = values.ownershipPct.toString();
  }

  // Notes are NOT stored in metadata - they go in asset.notes field

  // Type-specific fields (all use unified 'sub_type' for the type field)
  switch (values.kind) {
    case AlternativeAssetKind.PROPERTY:
      if (values.address) metadata.address = values.address;
      if (values.propertyType) metadata.sub_type = values.propertyType;
      break;

    case AlternativeAssetKind.VEHICLE:
      if (values.vehicleType) metadata.sub_type = values.vehicleType;
      if (values.description) metadata.description = values.description;
      break;

    case AlternativeAssetKind.COLLECTIBLE:
      if (values.collectibleType) metadata.sub_type = values.collectibleType;
      if (values.description) metadata.description = values.description;
      break;

    case AlternativeAssetKind.PRECIOUS_METAL:
      if (values.metalType) metadata.sub_type = values.metalType;
      if (values.quantity != null) metadata.quantity = values.quantity.toString();
      if (values.unit) metadata.unit = values.unit;
      if (values.description) metadata.description = values.description;
      break;

    case AlternativeAssetKind.LIABILITY:
      if (values.liabilityType) metadata.sub_type = values.liabilityType;
      if (values.originalAmount != null)
        metadata.original_amount = values.originalAmount.toString();
      if (values.originationDate)
        metadata.origination_date = formatDateToISO(values.originationDate);
      if (values.interestRate != null) metadata.interest_rate = values.interestRate.toString();
      if (values.linkedAssetId) metadata.linked_asset_id = values.linkedAssetId;
      break;

    case AlternativeAssetKind.OTHER:
      if (values.description) metadata.description = values.description;
      break;
  }

  return metadata;
}

// Helper to format date to ISO string (YYYY-MM-DD)
function formatDateToISO(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
