import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getAccounts, listImportTemplates } from "@/adapters";
import { AccountType, ActivityType, ImportFormat } from "@/lib/constants";
import { useStepValidation } from "../activity-import-page";
import { ImportProvider, setMapping, setParsedData, setStep, useImportContext } from "../context";
import { getActivityImportProfileForAccountType } from "../utils/activity-import-profile";
import { createDefaultActivityMapping } from "../utils/default-activity-template";
import { MappingStepUnified } from "./mapping-step-unified";

// The page module pulls in the rest of the adapters, so keep them and stub what Mapping calls
vi.mock("@/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters")>()),
  getAccounts: vi.fn(),
  listImportTemplates: vi.fn(),
  saveImportTemplate: vi.fn(),
  saveAccountImportMapping: vi.fn(),
  deleteImportTemplate: vi.fn(),
  parseCsv: vi.fn(),
}));
vi.mock("@/components/account-selector", () => ({
  AccountSelector: () => <div data-testid="account-selector" />,
}));
vi.mock("@/components/ticker-search", () => ({
  default: () => <input placeholder="Map symbol" />,
}));
vi.mock("../components/csv-file-viewer", () => ({ CSVFileViewer: () => null }));
vi.mock("../components/template-picker", () => ({ TemplatePicker: () => null }));

// A Zerodha Coin-style tradebook: the fund's name in `symbol`, its ISIN beside it
const headers = ["symbol", "isin", "trade_date", "trade_type", "quantity", "price"];
const parag = "PARAG PARIKH FLEXI CAP FUND - DIRECT PLAN";
const hdfc = "HDFC NIFTY100 LOW VOLATILITY 30 INDEX FUND - DIRECT PLAN";
const profile = getActivityImportProfileForAccountType(AccountType.SECURITIES);

function Harness({ rows }: { rows: string[][] }) {
  const { state, dispatch } = useImportContext();
  const canProceed = useStepValidation(false, profile, []);

  useEffect(() => {
    dispatch(
      setMapping({
        ...createDefaultActivityMapping("account-1"),
        fieldMappings: {
          [ImportFormat.SYMBOL]: "symbol",
          [ImportFormat.ISIN]: "isin",
          [ImportFormat.DATE]: "trade_date",
          [ImportFormat.ACTIVITY_TYPE]: "trade_type",
          [ImportFormat.QUANTITY]: "quantity",
          [ImportFormat.UNIT_PRICE]: "price",
        },
        activityMappings: { [ActivityType.BUY]: ["buy"] },
      }),
    );
    dispatch(setParsedData(headers, rows));
    dispatch(setStep("mapping"));
  }, [rows, dispatch]);

  return state.parsedRows.length > 0 ? (
    <>
      <MappingStepUnified />
      <output data-testid="can-proceed">{String(canProceed)}</output>
    </>
  ) : null;
}

function renderMapping(rows: string[][]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ImportProvider initialAccountId="account-1">
        <Harness rows={rows} />
      </ImportProvider>
    </QueryClientProvider>,
  );
}

function symbolsCard() {
  return within(screen.getByText("Symbols").closest<HTMLElement>('[role="alert"]')!);
}

describe("mapping a fund name in Symbol with a valid ISIN beside it", () => {
  beforeEach(() => {
    vi.mocked(getAccounts).mockResolvedValue([]);
    vi.mocked(listImportTemplates).mockResolvedValue([]);
  });

  it("counts the rows as mapped and lets Mapping proceed", async () => {
    renderMapping([
      [parag, "INF879O01027", "2026-10-01", "buy", "10", "90"],
      [hdfc, "INF179KC1IM3", "2026-10-02", "buy", "20", "10"],
    ]);

    expect(await symbolsCard().findByText("2 of 2 mapped")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Map symbol")).not.toBeInTheDocument();
    expect(screen.getByTestId("can-proceed")).toHaveTextContent("true");
  });

  it("still asks for a mapping when any row of a name lacks a valid ISIN", async () => {
    renderMapping([
      [parag, "INF879O01027", "2026-10-01", "buy", "10", "90"],
      [hdfc, "INF179KC1IM3", "2026-10-02", "buy", "20", "10"],
      // Wrong check digit
      [hdfc, "INF179KC1IM4", "2026-10-03", "buy", "5", "10"],
    ]);

    expect(await symbolsCard().findByText("1 of 2 mapped")).toBeInTheDocument();
    expect(screen.getAllByPlaceholderText("Map symbol")).toHaveLength(1);
    expect(screen.getByTestId("can-proceed")).toHaveTextContent("false");
  });
});
