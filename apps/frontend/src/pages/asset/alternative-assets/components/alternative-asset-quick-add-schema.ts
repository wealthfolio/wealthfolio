import type { LoanSetup } from "@/adapters/shared/alternative-assets";
import { AlternativeAssetKind } from "@/lib/types";
import { formatDateISO } from "@/lib/utils";
import * as z from "zod";
import type { LoanInterestMethod, LoanPaymentFrequency } from "../lib/loan-events";

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

// Liability types. Credit cards are accounts, so new liabilities can't use that type.
export const LIABILITY_TYPES = [
  { value: "mortgage", label: "Mortgage" },
  { value: "auto_loan", label: "Auto Loan" },
  { value: "student_loan", label: "Student Loan" },
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
    originalAmount: z.coerce.number().finite().positive().optional(),
    currentBalance: z.coerce.number().finite().min(0).optional(),
    originationDate: z.date().optional(),
    balanceDate: z.date(),
    loanTermMonths: z.coerce.number().finite().int().positive().max(1200).optional(),
    interestRate: z.coerce.number().finite().min(0).max(100).optional(),
  })
  .superRefine((values, context) => {
    if (!values.originalAmount && values.currentBalance === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentBalance"],
        message: "asset:quickAdd.validation.invalid",
      });
    }
    if (values.originationDate && values.balanceDate < values.originationDate) {
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
      .enum(["mortgage", "auto_loan", "student_loan", "personal_loan", "heloc", "other"])
      .optional(),
    linkedAssetId: z.string().optional(),
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
});

/** What the quick-add form holds for a new loan. */
export interface QuickAddLoanInput {
  purchasePrice?: string;
  purchaseDate?: Date;
  interestRate?: string;
  automaticSchedule?: boolean;
  paymentFrequency?: LoanPaymentFrequency;
  interestMethod?: LoanInterestMethod;
  loanTerm?: string;
  loanTermMonths?: string;
  firstPaymentDate?: Date;
}

const entered = (value?: string) => {
  const number = value?.trim() ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
};

/**
 * A new loan as entered. The backend checks it, derives the schedule and solves
 * the payment; a manual loan keeps only its amounts, as before.
 */
export function quickAddLoanSetup(input: QuickAddLoanInput): LoanSetup {
  const amounts = {
    originalAmount: entered(input.purchasePrice),
    interestRate: entered(input.interestRate),
  };
  if (input.automaticSchedule === false) return amounts;
  const months = (entered(input.loanTerm) ?? 0) * 12 + (entered(input.loanTermMonths) ?? 0);
  return {
    ...amounts,
    originationDate: input.purchaseDate ? formatDateISO(input.purchaseDate) : undefined,
    schedule: {
      frequency: input.paymentFrequency ?? "monthly",
      interestMethod: input.interestMethod ?? "nominal_periodic",
      amortizationMonths: months > 0 ? months : undefined,
      firstPaymentDate: input.firstPaymentDate ? formatDateISO(input.firstPaymentDate) : undefined,
    },
  };
}
