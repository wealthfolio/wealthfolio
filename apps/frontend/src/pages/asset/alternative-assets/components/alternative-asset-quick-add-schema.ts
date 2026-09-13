import { AlternativeAssetKind } from "@/lib/types";
import * as z from "zod";

// Metal types for precious metals
export const METAL_TYPES = [
  { value: "gold", label: "Gold" },
  { value: "silver", label: "Silver" },
  { value: "platinum", label: "Platinum" },
  { value: "palladium", label: "Palladium" },
] as const;

// Weight units for precious metals
export const WEIGHT_UNITS = [
  { value: "oz", label: "Troy Ounce (oz)" },
  { value: "g", label: "Gram (g)" },
  { value: "kg", label: "Kilogram (kg)" },
] as const;

// Liability types
export const LIABILITY_TYPES = [
  { value: "mortgage", label: "Mortgage" },
  { value: "auto_loan", label: "Auto Loan" },
  { value: "student_loan", label: "Student Loan" },
  { value: "credit_card", label: "Credit Card" },
  { value: "personal_loan", label: "Personal Loan" },
  { value: "heloc", label: "HELOC" },
  { value: "other", label: "Other" },
] as const;

// Asset type options for the type selector
export const ASSET_KIND_OPTIONS = [
  { value: AlternativeAssetKind.PROPERTY, label: "Property" },
  { value: AlternativeAssetKind.VEHICLE, label: "Vehicle" },
  { value: AlternativeAssetKind.COLLECTIBLE, label: "Collectible" },
  { value: AlternativeAssetKind.PRECIOUS_METAL, label: "Precious Metal" },
  { value: AlternativeAssetKind.LIABILITY, label: "Liability" },
  { value: AlternativeAssetKind.OTHER, label: "Other" },
] as const;

export const liabilityQuickAddSchema = z
  .object({
    originalAmount: z.coerce.number().finite().positive(),
    currentBalance: z.coerce.number().finite().min(0).optional(),
    originationDate: z.date(),
    balanceDate: z.date(),
    loanTerm: z.coerce.number().finite().int().positive().max(100).optional(),
    interestRate: z.coerce.number().finite().min(0).max(100).optional(),
  })
  .superRefine((values, context) => {
    if (values.balanceDate < values.originationDate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["balanceDate"],
        message: "asset:quickAdd.validation.balance_date_before_origination",
      });
    }
  });

// Zod schema for the quick add form
export const alternativeAssetQuickAddSchema = z
  .object({
    // Asset type
    kind: z.enum([
      AlternativeAssetKind.PROPERTY,
      AlternativeAssetKind.VEHICLE,
      AlternativeAssetKind.COLLECTIBLE,
      AlternativeAssetKind.PRECIOUS_METAL,
      AlternativeAssetKind.LIABILITY,
      AlternativeAssetKind.OTHER,
    ]),

    // Common fields
    name: z.string().min(1, "Name is required").max(100, "Name must be less than 100 characters"),
    currency: z.string().min(1, "Currency is required"),
    quantity: z.coerce
      .number({
        required_error: "Please enter a valid quantity.",
        invalid_type_error: "Quantity must be a number.",
      })
      .positive("Quantity must be greater than 0"),
    currentValue: z.coerce
      .number({
        required_error: "Please enter a valid value.",
        invalid_type_error: "Value must be a number.",
      })
      .min(0, "Value cannot be negative"),
    valueDate: z.date({
      required_error: "Value date is required",
    }),

    // Property-specific: has mortgage checkbox
    hasMortgage: z.boolean().optional(),

    // Precious metal-specific fields
    metalType: z.enum(["gold", "silver", "platinum", "palladium"]).optional(),
    weightUnit: z.enum(["oz", "g", "kg"]).optional(),

    // Liability-specific fields
    liabilityType: z
      .enum([
        "mortgage",
        "auto_loan",
        "student_loan",
        "credit_card",
        "personal_loan",
        "heloc",
        "other",
      ])
      .optional(),
    linkedAssetId: z.string().optional(),
    endDate: z.date().optional(),
  })
  .refine(
    (data) => {
      // Precious metals require metal type and weight unit
      if (data.kind === AlternativeAssetKind.PRECIOUS_METAL) {
        return !!data.metalType && !!data.weightUnit;
      }
      return true;
    },
    {
      message: "Metal type and unit are required for precious metals",
      path: ["metalType"],
    },
  );

export type AlternativeAssetQuickAddFormValues = z.infer<typeof alternativeAssetQuickAddSchema>;

// Default form values
export const getDefaultFormValues = (): AlternativeAssetQuickAddFormValues => ({
  kind: AlternativeAssetKind.PROPERTY,
  name: "",
  currency: "USD",
  quantity: 1,
  currentValue: 0,
  valueDate: new Date(),
  hasMortgage: false,
  metalType: undefined,
  weightUnit: "oz",
  liabilityType: undefined,
  linkedAssetId: undefined,
  endDate: undefined,
});
