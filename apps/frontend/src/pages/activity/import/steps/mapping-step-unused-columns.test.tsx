import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getAccounts, listImportTemplates } from "@/adapters";
import { ActivityType, ImportFormat } from "@/lib/constants";
import { ImportProvider, setMapping, setParsedData, setStep, useImportContext } from "../context";
import { createDefaultActivityMapping } from "../utils/default-activity-template";
import { MappingStepUnified } from "./mapping-step-unified";

vi.mock("@/adapters", () => ({
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

// A Zerodha tradebook's columns, as in the report
const headers = [
  "symbol",
  "isin",
  "trade_date",
  "exchange",
  "segment",
  "series",
  "trade_type",
  "auction",
  "quantity",
  "price",
  "trade_id",
  "order_id",
  "order_execution_time",
];
const rows = [
  [
    "INFY",
    "INE009A01021",
    "2026-10-01",
    "NSE",
    "EQ",
    "EQ",
    "buy",
    "false",
    "10",
    "1500",
    "1001",
    "2001",
    "2026-10-01T09:15:00",
  ],
];

const zerodhaMappings = {
  [ImportFormat.SYMBOL]: "symbol",
  [ImportFormat.ISIN]: "isin",
  [ImportFormat.DATE]: "trade_date",
  [ImportFormat.ACTIVITY_TYPE]: "trade_type",
  [ImportFormat.QUANTITY]: "quantity",
  [ImportFormat.UNIT_PRICE]: "price",
};

interface HarnessProps {
  csvHeaders: string[];
  csvRows: string[][];
  fieldMappings: Record<string, string | string[]>;
}

function Harness({ csvHeaders, csvRows, fieldMappings }: HarnessProps) {
  const { state, dispatch } = useImportContext();

  useEffect(() => {
    dispatch(
      setMapping({
        ...createDefaultActivityMapping("account-1"),
        fieldMappings,
        activityMappings: { [ActivityType.BUY]: ["BUY"] },
      }),
    );
    dispatch(setParsedData(csvHeaders, csvRows));
    dispatch(setStep("mapping"));
  }, [csvHeaders, csvRows, fieldMappings, dispatch]);

  return state.parsedRows.length > 0 ? <MappingStepUnified /> : null;
}

function renderMapping(fieldMappings: HarnessProps["fieldMappings"] = zerodhaMappings) {
  return renderCsv(headers, rows, fieldMappings);
}

function renderCsv(
  csvHeaders: string[],
  csvRows: string[][],
  fieldMappings: HarnessProps["fieldMappings"],
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ImportProvider initialAccountId="account-1">
        <Harness csvHeaders={csvHeaders} csvRows={csvRows} fieldMappings={fieldMappings} />
      </ImportProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

// The notice's list of column names, each name isolated in its own <bdi>
async function findNotice(title: string) {
  const notice = (await screen.findByText(title)).closest<HTMLElement>('[role="alert"]')!;
  const list = notice.querySelector<HTMLElement>('[data-slot="alert-description"]')!;
  return { list, names: within(list).queryAllByText(/./, { selector: "bdi" }) };
}

describe("CSV columns the mapping step leaves out", () => {
  beforeEach(() => {
    vi.mocked(getAccounts).mockResolvedValue([]);
    vi.mocked(listImportTemplates).mockResolvedValue([]);
  });

  it("names the columns no field reads, and drops one once a field reads it", async () => {
    const user = renderMapping();

    const before = await findNotice("7 of 13 columns not imported");
    expect(before.list).toHaveTextContent(
      /^exchange, segment, series, auction, trade_id, order_id, and order_execution_time$/,
    );
    expect(before.names).toHaveLength(7);

    await user.click(screen.getByRole("combobox", { name: ImportFormat.COMMENT }));
    await user.click(await screen.findByRole("option", { name: "trade_id" }));

    const after = await findNotice("6 of 13 columns not imported");
    expect(after.list).toHaveTextContent(
      /^exchange, segment, series, auction, order_id, and order_execution_time$/,
    );
  });

  it("counts a field's fallback columns as read", async () => {
    renderMapping({ ...zerodhaMappings, [ImportFormat.COMMENT]: ["trade_id", "order_id"] });

    const { list } = await findNotice("5 of 13 columns not imported");
    expect(list).toHaveTextContent(
      /^exchange, segment, series, auction, and order_execution_time$/,
    );
  });

  it("counts all but the last of same-named columns as left out, as the import reads only it", async () => {
    renderCsv(
      ["date", "activityType", "symbol", "quantity", "unitPrice", "symbol"],
      [["2026-10-01", "BUY", "AAA", "1", "100", "BBB"]],
      {
        [ImportFormat.DATE]: "date",
        [ImportFormat.ACTIVITY_TYPE]: "activityType",
        [ImportFormat.SYMBOL]: "symbol",
        [ImportFormat.QUANTITY]: "quantity",
        [ImportFormat.UNIT_PRICE]: "unitPrice",
      },
    );

    const { list } = await findNotice("1 of 6 columns not imported");
    expect(list).toHaveTextContent(/^symbol$/);
  });
});
