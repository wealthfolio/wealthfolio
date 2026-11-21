import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";

import type { Account } from "@/lib/types";
import { AccountType, ActivityType, ImportFormat } from "@/lib/constants";
import { useStepValidation } from "./activity-import-page";
import { ImportProvider, setMapping, setParsedData, setStep, useImportContext } from "./context";
import { getActivityImportProfileForAccountType } from "./utils/activity-import-profile";
import { createDefaultActivityMapping } from "./utils/default-activity-template";

// The page module pulls in the adapters; nothing here calls them
vi.mock("@/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters")>()),
  getAccounts: vi.fn(),
  listImportTemplates: vi.fn(),
  parseCsv: vi.fn(),
}));

const profile = getActivityImportProfileForAccountType(AccountType.SECURITIES);
const accounts = [{ id: "account-1" }] as Account[];

interface Case {
  headers: string[];
  row: string[];
  fieldMappings: Partial<Record<ImportFormat, string>>;
}

function Harness({ headers, row, fieldMappings }: Case) {
  const { state, dispatch } = useImportContext();
  const canProceed = useStepValidation(false, profile, accounts);

  useEffect(() => {
    dispatch(
      setMapping({
        ...createDefaultActivityMapping("account-1"),
        fieldMappings: {
          [ImportFormat.DATE]: "date",
          [ImportFormat.ACTIVITY_TYPE]: "type",
          [ImportFormat.SYMBOL]: "symbol",
          [ImportFormat.QUANTITY]: "quantity",
          [ImportFormat.UNIT_PRICE]: "price",
          ...fieldMappings,
        },
        activityMappings: {
          [ActivityType.BUY]: ["buy"],
          [ActivityType.DEPOSIT]: ["deposit"],
          [ActivityType.INTEREST]: ["interest"],
        },
      }),
    );
    dispatch(setParsedData(headers, [row]));
    dispatch(setStep("mapping"));
  }, [headers, row, fieldMappings, dispatch]);

  return state.parsedRows.length > 0 ? (
    <output data-testid="can-proceed">{String(canProceed)}</output>
  ) : null;
}

async function canProceed(testCase: Case) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { unmount } = render(
    <QueryClientProvider client={queryClient}>
      <ImportProvider initialAccountId="account-1">
        <Harness {...testCase} />
      </ImportProvider>
    </QueryClientProvider>,
  );
  const text = (await screen.findByTestId("can-proceed")).textContent;
  unmount();
  return text === "true";
}

const base = ["date", "type", "symbol", "quantity", "price"];
const parag = "PARAG PARIKH FLEXI CAP FUND - DIRECT PLAN";

// Each case duplicates one mapped column; `first`/`last` fill the two copies.
// Draft creation reads the last copy, so only the last should decide.
const cases: {
  name: string;
  build: (first: string, last: string) => Case;
  bad: string;
  good: string;
}[] = [
  {
    name: "symbol",
    build: (first, last) => ({
      headers: [...base, "symbol"],
      row: ["2026-10-01", "buy", first, "1", "100", last],
      fieldMappings: {},
    }),
    bad: "NOT A TICKER",
    good: "AAPL",
  },
  {
    name: "account",
    build: (first, last) => ({
      headers: [...base, "account", "account"],
      row: ["2026-10-01", "buy", "AAPL", "1", "100", first, last],
      fieldMappings: { [ImportFormat.ACCOUNT]: "account" },
    }),
    bad: "unknown-account",
    good: "account-1",
  },
  {
    name: "activity type",
    build: (first, last) => ({
      headers: [...base, "type"],
      row: ["2026-10-01", first, "AAPL", "1", "100", last],
      fieldMappings: {},
    }),
    bad: "not-a-type",
    good: "buy",
  },
  {
    // Both types are mapped; only BUY makes the invalid symbol need resolving
    name: "activity type for the symbol check",
    build: (first, last) => ({
      headers: [...base, "type"],
      row: ["2026-10-01", first, "NOT A TICKER", "1", "100", last],
      fieldMappings: {},
    }),
    bad: "buy",
    good: "deposit",
  },
  {
    // Interest needs its symbol resolved only as a staking reward
    name: "subtype",
    build: (first, last) => ({
      headers: [...base, "subtype", "subtype"],
      row: ["2026-10-01", "interest", "NOT A TICKER", "1", "100", first, last],
      fieldMappings: { [ImportFormat.SUBTYPE]: "subtype" },
    }),
    bad: "STAKING_REWARD",
    good: "",
  },
  {
    name: "ISIN",
    build: (first, last) => ({
      headers: [...base, "isin", "isin"],
      row: ["2026-10-01", "buy", parag, "1", "100", first, last],
      fieldMappings: { [ImportFormat.ISIN]: "isin" },
    }),
    // Wrong check digit
    bad: "INF879O01028",
    good: "INF879O01027",
  },
];

describe("Mapping step check with two columns of the same name", () => {
  it.each(cases)("duplicated $name: reads the last column, as the import does", async (c) => {
    expect(await canProceed(c.build(c.bad, c.good))).toBe(true);
    expect(await canProceed(c.build(c.good, c.bad))).toBe(false);
  });
});
