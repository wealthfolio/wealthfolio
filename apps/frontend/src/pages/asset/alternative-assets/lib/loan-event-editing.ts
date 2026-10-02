import {
  isLoanEvent,
  readLoanEvents,
  readLoanProjectionMetadata,
  getLoanFrequencyAtDate,
  LOAN_EVENTS_METADATA_KEY,
  LOAN_RENEWAL_MATURITY_METADATA_KEY,
  type LoanEvent,
  type LoanMetadata,
} from "./loan-events";

/** Replace exactly one recorded event, preserving same-day siblings and unrecognized entries. */
export function changeLoanEvent(
  metadata: LoanMetadata,
  index: number,
  original: LoanEvent,
  replacement: LoanEvent | null,
): LoanMetadata {
  if (replacement && !isLoanEvent(replacement)) throw new Error("Invalid loan event");
  const raw = metadata[LOAN_EVENTS_METADATA_KEY];
  const parsed: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!Array.isArray(parsed)) throw new Error("Loan event no longer exists");
  const entries = (parsed as unknown[])
    .map((event, rawIndex) => ({ event, rawIndex }))
    .filter((entry): entry is { event: LoanEvent; rawIndex: number } => isLoanEvent(entry.event))
    .sort((a, b) => a.event.effectiveDate.localeCompare(b.event.effectiveDate));
  const target = entries[index];
  if (!target || JSON.stringify(target.event) !== JSON.stringify(original))
    throw new Error("Loan event changed");
  const next = [...(parsed as unknown[])];
  if (replacement) next[target.rawIndex] = replacement;
  else next.splice(target.rawIndex, 1);
  const result: LoanMetadata = { ...metadata, [LOAN_EVENTS_METADATA_KEY]: next };
  if (
    original.type === "renewal" &&
    ((original.termEndDate &&
      metadata[LOAN_RENEWAL_MATURITY_METADATA_KEY] === original.termEndDate) ||
      (!original.termEndDate &&
        !metadata[LOAN_RENEWAL_MATURITY_METADATA_KEY] &&
        entries.filter(({ event }) => event.type === "renewal").at(-1) === target))
  ) {
    const renewals = next
      .filter(isLoanEvent)
      .filter((event) => event.type === "renewal" && event.termEndDate)
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
    const latest = renewals.at(-1);
    result[LOAN_RENEWAL_MATURITY_METADATA_KEY] =
      latest?.type === "renewal" ? (latest.termEndDate ?? "") : "";
  }
  return result;
}

/** Resolve inherited settings before the edited event, including same-day ordering. */
export function inheritedLoanSettings(metadata: LoanMetadata, index: number, date: string) {
  let raw = metadata[LOAN_EVENTS_METADATA_KEY];
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = [];
    }
  }
  const recorded = Array.isArray(raw) ? raw.filter(isLoanEvent) : [];
  const ordered = readLoanEvents({ [LOAN_EVENTS_METADATA_KEY]: recorded });
  const targetPosition = index < 0 ? recorded.length : recorded.indexOf(ordered[index]);
  const preceding = readLoanEvents({
    [LOAN_EVENTS_METADATA_KEY]: recorded.filter(
      (event, position) =>
        position !== targetPosition &&
        (event.effectiveDate < date || (event.effectiveDate === date && position < targetPosition)),
    ),
  });
  const priorMetadata = { ...metadata, [LOAN_EVENTS_METADATA_KEY]: preceding };
  let interestMethod = readLoanProjectionMetadata(metadata)?.interestMethod ?? "nominal_periodic";
  for (const event of preceding) {
    if (event.type === "renewal" && event.interestMethod) interestMethod = event.interestMethod;
  }
  return { frequency: getLoanFrequencyAtDate(priorMetadata, date), interestMethod };
}
