import { isValid, parseISO } from "date-fns";

export const LOAN_RENEWAL_MATURITY_METADATA_KEY = "renewal_maturity_date";
export const LOAN_EVENTS_METADATA_KEY = "loan_events";
export const LOAN_PROJECTION_METADATA_KEY = "loan_projection";

export type LoanPaymentFrequency = "monthly" | "biweekly" | "accelerated_biweekly";
export type LoanInterestMethod = "nominal_periodic" | "monthly" | "semiannual";

export function isLoanInterestMethod(value: unknown): value is LoanInterestMethod {
  return value === "nominal_periodic" || value === "monthly" || value === "semiannual";
}

export interface LoanExtraRepaymentEvent {
  type: "extra_repayment";
  effectiveDate: string;
  amount: number;
  note?: string;
}

export interface LoanRateChangeEvent {
  type: "rate_change";
  effectiveDate: string;
  annualRate: number;
  note?: string;
}

export interface LoanPaymentChangeEvent {
  type: "payment_change";
  effectiveDate: string;
  paymentAmount: number;
  note?: string;
}

export interface LoanFrequencyChangeEvent {
  type: "payment_frequency_change";
  effectiveDate: string;
  frequency: LoanPaymentFrequency;
  note?: string;
}

export interface LoanRenewalEvent {
  type: "renewal";
  effectiveDate: string;
  annualRate: number;
  paymentAmount?: number;
  frequency?: LoanPaymentFrequency;
  interestMethod?: LoanInterestMethod;
  termEndDate?: string;
  note?: string;
}

export type LoanEvent =
  | LoanExtraRepaymentEvent
  | LoanRateChangeEvent
  | LoanPaymentChangeEvent
  | LoanFrequencyChangeEvent
  | LoanRenewalEvent;

export type LoanMetadata = Record<string, unknown>;

export interface LoanProjectionMetadata {
  version: 1;
  annualRate: number;
  paymentAmount: number;
  frequency: LoanPaymentFrequency;
  interestMethod?: LoanInterestMethod;
  firstPaymentDate: string;
  paymentCount?: number;
  amortizationEndDate?: string;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e15;
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && isValid(parseISO(value));
}

function isFrequency(value: unknown): value is LoanPaymentFrequency {
  return value === "monthly" || value === "biweekly" || value === "accelerated_biweekly";
}

/** Validate persisted loan events before they are used by the calculation engine. */
export function isLoanEvent(value: unknown): value is LoanEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  if (!isIsoDate(event.effectiveDate)) return false;

  switch (event.type) {
    case "extra_repayment":
      return isFiniteNonNegative(event.amount) && Math.round(event.amount * 100) > 0;
    case "rate_change":
      return isFiniteNonNegative(event.annualRate) && event.annualRate <= 100;
    case "payment_change":
      return isFiniteNonNegative(event.paymentAmount) && Math.round(event.paymentAmount * 100) > 0;
    case "payment_frequency_change":
      return isFrequency(event.frequency);
    case "renewal":
      return (
        isFiniteNonNegative(event.annualRate) &&
        event.annualRate <= 100 &&
        (event.paymentAmount === undefined ||
          (isFiniteNonNegative(event.paymentAmount) &&
            Math.round(event.paymentAmount * 100) > 0)) &&
        (event.frequency === undefined || isFrequency(event.frequency)) &&
        (event.interestMethod === undefined || isLoanInterestMethod(event.interestMethod)) &&
        (event.termEndDate === undefined || isIsoDate(event.termEndDate))
      );
    default:
      return false;
  }
}

/** Read only valid events, keeping malformed metadata out of calculations. */
export function readLoanEvents(metadata: LoanMetadata | null | undefined): LoanEvent[] {
  const raw = metadata?.[LOAN_EVENTS_METADATA_KEY];
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];

  return value
    .filter(isLoanEvent)
    .sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate));
}

/** Resolve the payment frequency active on a given calendar date. */
export function getLoanFrequencyAtDate(
  metadata: LoanMetadata | null | undefined,
  date: string,
): LoanPaymentFrequency {
  let frequency: LoanPaymentFrequency =
    readLoanProjectionMetadata(metadata)?.frequency ?? "monthly";
  for (const event of readLoanEvents(metadata)) {
    if (event.effectiveDate > date) break;
    if (event.type === "payment_frequency_change") frequency = event.frequency;
    if (event.type === "renewal" && event.frequency) frequency = event.frequency;
  }
  return frequency;
}

/** Return metadata with a validated event appended without mutating the input. */
export function appendLoanEvent(metadata: LoanMetadata, event: LoanEvent): LoanMetadata {
  if (!isLoanEvent(event)) {
    throw new Error("asset:loanEvents.invalid");
  }

  return {
    ...metadata,
    [LOAN_EVENTS_METADATA_KEY]: [...readLoanEvents(metadata), event].sort((left, right) =>
      left.effectiveDate.localeCompare(right.effectiveDate),
    ),
  };
}

/**
 * Projection parameters are persisted as data, not as a collection of future
 * quotes.  JSON is used because the asset metadata API accepts string values
 * during asset creation as well as structured values when updated later.
 */
export function serializeLoanProjectionMetadata(projection: LoanProjectionMetadata): string {
  return JSON.stringify(projection);
}

/**
 * Terms that drive calculation. A loan switched back to manual keeps its stored
 * terms for later, but nothing should calculate or act on them.
 */
export function readActiveLoanProjection(
  metadata: LoanMetadata | null | undefined,
): LoanProjectionMetadata | null {
  return metadata?.tracking_mode === "manual" ? null : readLoanProjectionMetadata(metadata);
}

/** Renewal applies to calculated mortgages and to loans that already have a renewal date. */
export function canRenewLoan(metadata: LoanMetadata): boolean {
  return (
    !!readActiveLoanProjection(metadata) &&
    ((metadata.sub_type ?? metadata.liability_type) === "mortgage" ||
      typeof metadata[LOAN_RENEWAL_MATURITY_METADATA_KEY] === "string")
  );
}

export function readLoanProjectionMetadata(
  metadata: LoanMetadata | null | undefined,
): LoanProjectionMetadata | null {
  const raw = metadata?.[LOAN_PROJECTION_METADATA_KEY];
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object") return null;
  const projection = value as Record<string, unknown>;
  if (
    projection.version !== 1 ||
    !isFiniteNonNegative(projection.annualRate) ||
    !isFiniteNonNegative(projection.paymentAmount) ||
    !isFrequency(projection.frequency) ||
    (projection.interestMethod !== undefined && !isLoanInterestMethod(projection.interestMethod)) ||
    !isIsoDate(projection.firstPaymentDate)
  ) {
    return null;
  }
  if (
    projection.paymentCount !== undefined &&
    (!isFiniteNonNegative(projection.paymentCount) || !Number.isInteger(projection.paymentCount))
  ) {
    return null;
  }
  if (projection.amortizationEndDate !== undefined && !isIsoDate(projection.amortizationEndDate))
    return null;
  return projection as unknown as LoanProjectionMetadata;
}
