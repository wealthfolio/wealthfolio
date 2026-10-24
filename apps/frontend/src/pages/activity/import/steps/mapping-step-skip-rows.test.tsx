import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAccounts, listImportTemplates } from "@/adapters";
import { ActivityType, ImportFormat } from "@/lib/constants";
import {
  ImportProvider,
  prevStep,
  setMapping,
  setParsedData,
  setStep,
  useImportContext,
} from "../context";
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

const headers = ["Date", "Action", "Security", "Quantity", "Price"];
// Rows 2 and 3 share a fund name with no symbol mapping
const rows = [
  ["2026-10-01", "BUY", "FUND A DIRECT GROWTH", "10", "9.99"],
  ["2026-10-16", "BUY", "FUND B DIRECT PLAN", "5", "10"],
  ["2026-10-17", "BUY", "FUND B DIRECT PLAN", "7", "10"],
];

function Harness({ csvHeaders, csvRows }: { csvHeaders: string[]; csvRows: string[][] }) {
  const { state, dispatch } = useImportContext();

  useEffect(() => {
    dispatch(
      setMapping({
        ...createDefaultActivityMapping("account-1"),
        fieldMappings: {
          [ImportFormat.DATE]: "Date",
          [ImportFormat.ACTIVITY_TYPE]: "Action",
          [ImportFormat.SYMBOL]: "Security",
          [ImportFormat.QUANTITY]: "Quantity",
          [ImportFormat.UNIT_PRICE]: "Price",
        },
        activityMappings: { [ActivityType.BUY]: ["BUY"] },
        symbolMappings: { "FUND A DIRECT GROWTH": "0P0000TEST" },
      }),
    );
    dispatch(setParsedData(csvHeaders, csvRows));
    dispatch(setStep("mapping"));
  }, [csvHeaders, csvRows, dispatch]);

  return state.parsedRows.length > 0 ? (
    <>
      {state.step === "mapping" && <MappingStepUnified />}
      <output data-testid="skipped-rows">{state.skippedRowIndexes.join(",")}</output>
      <button onClick={() => dispatch(setStep("assets"))}>test: go to review assets</button>
      <button onClick={() => dispatch(prevStep())}>test: back</button>
      <button onClick={() => dispatch(setParsedData(csvHeaders, csvRows))}>
        test: parse again
      </button>
    </>
  ) : null;
}

function renderMapping(csvHeaders = headers, csvRows = rows) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ImportProvider initialAccountId="account-1">
        <Harness csvHeaders={csvHeaders} csvRows={csvRows} />
      </ImportProvider>
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

function symbolsCard() {
  return within(screen.getByText("Symbols").closest<HTMLElement>('[role="alert"]')!);
}

async function filterBy(user: ReturnType<typeof userEvent.setup>, filter: string, value: string) {
  await user.click(screen.getByRole("button", { name: filter }));
  await user.click(await screen.findByRole("option", { name: new RegExp(value) }));
  await user.keyboard("{Escape}");
}

// With a third of a CPU, as on shared CI runners, the filter tests take up to about 4.5s
describe("skipping rows in the mapping step", { timeout: 15_000 }, () => {
  beforeEach(() => {
    vi.mocked(getAccounts).mockResolvedValue([]);
    vi.mocked(listImportTemplates).mockResolvedValue([]);
    // The filter popovers' command lists need these, which jsdom lacks
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("unticks every row matching a filter, so the unmapped symbol no longer blocks", async () => {
    const user = renderMapping();
    expect(await symbolsCard().findByText("1 of 2 mapped")).toBeInTheDocument();

    await filterBy(user, "Symbol", "FUND B DIRECT PLAN");
    const includeMatching = screen.getByRole("checkbox", { name: "Include all matching rows" });
    expect(includeMatching).toBeChecked();
    await user.click(includeMatching);

    expect(screen.getByTestId("skipped-rows")).toHaveTextContent("1,2");
    expect(symbolsCard().getByText("1 of 1 mapped")).toBeInTheDocument();
    expect(screen.getByText("3 total rows · 2 skipped")).toBeInTheDocument();
    // The matches stay listed, unticked, so they can be ticked again
    expect(includeMatching).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Include row 3" })).not.toBeChecked();

    await user.click(screen.getByRole("checkbox", { name: "Include row 3" }));
    expect(screen.getByTestId("skipped-rows")).toHaveTextContent(/^1$/);
    expect(includeMatching).toHaveAttribute("aria-checked", "mixed");
  });

  it("unticks one row and keeps another with the same symbol", async () => {
    const user = renderMapping();
    expect(await symbolsCard().findByText("1 of 2 mapped")).toBeInTheDocument();
    // Without a filter, row 3 is represented by row 2
    expect(screen.queryByRole("checkbox", { name: "Include row 3" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Include row 2" }));

    expect(screen.getByTestId("skipped-rows")).toHaveTextContent(/^1$/);
    expect(symbolsCard().getByText("1 of 2 mapped")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Include row 3" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Include row 2" })).not.toBeChecked();

    await filterBy(user, "Status", "Skipped");
    expect(screen.queryByRole("checkbox", { name: "Include row 3" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Include row 2" }));

    expect(screen.getByTestId("skipped-rows")).toBeEmptyDOMElement();
  });

  it("keeps skips when Mapping is left and reopened, and clears them on a new parse", async () => {
    const user = renderMapping();
    await user.click(await screen.findByRole("checkbox", { name: "Include row 2" }));
    expect(screen.getByTestId("skipped-rows")).toHaveTextContent(/^1$/);

    await user.click(screen.getByRole("button", { name: "test: go to review assets" }));
    expect(screen.queryByRole("checkbox", { name: "Include row 2" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "test: back" }));
    expect(await screen.findByRole("checkbox", { name: "Include row 2" })).not.toBeChecked();
    expect(screen.getByTestId("skipped-rows")).toHaveTextContent(/^1$/);

    await user.click(screen.getByRole("button", { name: "test: parse again" }));
    expect(screen.getByTestId("skipped-rows")).toBeEmptyDOMElement();
    expect(screen.getByRole("checkbox", { name: "Include row 2" })).toBeChecked();
  });

  it("skips the unticked row when the CSV has its own lineNumber column", async () => {
    // The CSV's values replace the preview's row numbers: the first row shows 2, the second 1
    const user = renderMapping(
      [...headers, "lineNumber"],
      [
        [...rows[0], "2"],
        [...rows[1], "1"],
      ],
    );
    await user.click(await screen.findByRole("checkbox", { name: "Include row 2" }));

    expect(screen.getByTestId("skipped-rows")).toHaveTextContent(/^0$/);
  });

  it("lists only matching rows when the CSV repeats a lineNumber value", async () => {
    const user = renderMapping(
      [...headers, "lineNumber"],
      [
        [...rows[0], "99"],
        [...rows[1], "99"],
        ["2026-10-18", "BUY", "FUND C DIRECT PLAN", "2", "10", "100"],
      ],
    );
    const rowCheckboxes = () => screen.getAllByRole("checkbox", { name: /^Include row / });

    await filterBy(user, "Status", "Included");
    expect(rowCheckboxes()).toHaveLength(3);
    await filterBy(user, "Symbol", "FUND C DIRECT PLAN");
    expect(rowCheckboxes()).toHaveLength(1);

    await user.click(screen.getByRole("checkbox", { name: "Include all matching rows" }));
    expect(screen.getByTestId("skipped-rows")).toHaveTextContent(/^2$/);
  });

  it("counts rows without an activity type in the total", async () => {
    const user = renderMapping(headers, [
      ...rows,
      ["2026-10-18", "", "FUND A DIRECT GROWTH", "1", "10"],
    ]);
    expect(await screen.findByText("4 total rows")).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: "Include all rows" }));
    expect(screen.getByText("4 total rows · 4 skipped")).toBeInTheDocument();
  });

  it("unticks every row in the file without a filter and says there is nothing to import", async () => {
    const user = renderMapping();
    expect(await symbolsCard().findByText("1 of 2 mapped")).toBeInTheDocument();
    expect(screen.queryByText("Every row is skipped")).not.toBeInTheDocument();

    // Row 3 isn't shown, but the header checkbox covers it too
    await user.click(screen.getByRole("checkbox", { name: "Include all rows" }));

    expect(screen.getByTestId("skipped-rows")).toHaveTextContent("0,1,2");
    expect(screen.getByText("Every row is skipped")).toBeInTheDocument();
  });
});
