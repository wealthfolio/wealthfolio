import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getAccountImportMapping, listImportTemplates, parseCsv } from "@/adapters";
import { ImportType } from "@/lib/types";
import type { Account, ImportMappingData, ImportTemplateData, ParseConfig } from "@/lib/types";
import { ImportProvider } from "../context";
import { createDefaultActivityTemplate } from "../utils/default-activity-template";
import { UploadStep } from "./upload-step";

const { accounts } = vi.hoisted(() => {
  const accounts: Account[] = [
    {
      id: "account-1",
      name: "Broker",
      accountType: "SECURITIES",
      balance: 0,
      currency: "USD",
      isDefault: false,
      isActive: true,
      isArchived: false,
      trackingMode: "TRANSACTIONS",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  ];
  return { accounts };
});

vi.mock("@/adapters", () => ({
  parseCsv: vi.fn(),
  listImportTemplates: vi.fn(),
  getAccountImportMapping: vi.fn(),
  linkAccountTemplate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ accounts }) }));
vi.mock("@/hooks/use-platform", () => ({ usePlatform: () => ({ isMobile: false }) }));
vi.mock("@/components/account-selector", () => ({ AccountSelector: () => null }));
vi.mock("@/components/account-selector-mobile", () => ({ AccountSelectorMobile: () => null }));
vi.mock("../components/template-picker", () => ({
  TemplatePicker: ({ selectedTemplateId }: { selectedTemplateId: string | null }) => (
    <span>{selectedTemplateId}</span>
  ),
}));
vi.mock("../components/csv-file-viewer", () => ({ CSVFileViewer: () => null }));

// Models the unquoted comma, semicolon and tab fixtures: Rust detects "auto", normalizes
// escaped tabs, and reports the delimiter used in `detectedConfig`.
async function fakeParseCsv(file: File, config: ParseConfig) {
  const lines = (await file.text()).trim().split("\n");
  const requested = config.delimiter ?? "auto";
  const delimiter =
    requested === "auto"
      ? ([";", "\t"].find((value) => lines[0].includes(value)) ?? ",")
      : requested === "\\t"
        ? "\t"
        : requested;
  const [headers, ...rows] = lines.map((line) => line.split(delimiter));
  return {
    headers,
    rows,
    detectedConfig: { ...config, delimiter },
    errors: [],
    rowCount: rows.length,
  };
}

const semicolonFile = () =>
  new File(["Date;Symbol;Quantity\n2026-01-02;AAA;1\n"], "semicolon.csv", { type: "text/csv" });
const commaFile = () =>
  new File(["Date,Symbol,Quantity\n2026-01-03,BBB,2\n2026-01-04,CCC,3\n"], "comma.csv", {
    type: "text/csv",
  });
const tabFile = () =>
  new File(["Date\tSymbol\tQuantity\n2026-01-03\tBBB\t2\n2026-01-04\tCCC\t3\n"], "tab.csv", {
    type: "text/csv",
  });

function renderUploadStep() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <ImportProvider initialAccountId="account-1">
        <UploadStep />
      </ImportProvider>
    </QueryClientProvider>,
  );
  const dropzone = container.querySelector('input[type="file"]')?.parentElement;
  if (!dropzone) throw new Error("file dropzone not found");
  return (file: File) => fireEvent.drop(dropzone, { dataTransfer: { files: [file] } });
}

const previewHeaders = () =>
  screen
    .queryAllByRole("columnheader")
    .map((th) => th.textContent)
    .filter((text) => text !== "#");

const savedMapping = (templateId?: string): ImportMappingData => ({
  accountId: "account-1",
  importType: ImportType.ACTIVITY,
  templateId,
  name: "",
  fieldMappings: {},
  activityMappings: {},
  symbolMappings: {},
  accountMappings: {},
});

const delimiterParsedWith = (file: File) =>
  vi.mocked(parseCsv).mock.calls.find(([parsed]) => parsed === file)?.[1].delimiter;

describe("UploadStep delimiter for a second file", () => {
  beforeEach(() => {
    vi.mocked(parseCsv).mockReset();
    vi.mocked(parseCsv).mockImplementation(fakeParseCsv);
    vi.mocked(listImportTemplates).mockResolvedValue([]);
    vi.mocked(getAccountImportMapping).mockResolvedValue(savedMapping());
  });

  it.each([
    { flow: "after removing the first file", removeFirst: true },
    { flow: "when dropped over the first file", removeFirst: false },
  ])("auto-detects the delimiter of a second file $flow", async ({ removeFirst }) => {
    const drop = renderUploadStep();

    drop(semicolonFile());
    await screen.findByText("1 row");
    expect(previewHeaders()).toEqual(["Date", "Symbol", "Quantity"]);

    if (removeFirst) {
      fireEvent.click(screen.getByRole("button", { name: "Remove File" }));
      await waitFor(() => expect(screen.queryByText("1 row")).toBeNull());
    }

    const second = commaFile();
    drop(second);
    await screen.findByText("2 rows");

    expect(delimiterParsedWith(second)).toBe("auto");
    expect(previewHeaders()).toEqual(["Date", "Symbol", "Quantity"]);
  });

  it.each([
    {
      name: "semicolon",
      delimiter: ";",
      label: "Semicolon",
      file: commaFile,
      headers: ["Date,Symbol,Quantity"],
    },
    {
      name: "escaped tab",
      delimiter: "\\t",
      label: "Tab",
      file: tabFile,
      headers: ["Date", "Symbol", "Quantity"],
    },
    {
      name: "legacy real tab",
      delimiter: "\t",
      label: "Tab",
      file: tabFile,
      headers: ["Date", "Symbol", "Quantity"],
    },
  ])("keeps a template's $name delimiter for the next file", async (testCase) => {
    const { delimiter, label, file, headers } = testCase;
    const template: ImportTemplateData = {
      ...createDefaultActivityTemplate(),
      id: "explicit-delimiter-template",
      name: "Explicit delimiter broker",
      scope: "USER",
      parseConfig: { delimiter },
    };
    vi.mocked(listImportTemplates).mockResolvedValue([template]);
    vi.mocked(getAccountImportMapping).mockResolvedValue(savedMapping(template.id));
    const drop = renderUploadStep();
    await screen.findByText(template.id);

    const second = file();
    drop(second);
    await screen.findByText("2 rows");

    expect(delimiterParsedWith(second)).toBe(delimiter);
    expect(screen.getAllByText(`Delimiter: ${label}`).length).toBeGreaterThan(0);
    expect(previewHeaders()).toEqual(headers);
  });
});
