import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getAccountImportMapping, listImportTemplates, parseCsv } from "@/adapters";
import type { Account, ImportTemplateData, ParseConfig } from "@/lib/types";
import { ImportProvider, useImportContext } from "../context";
import {
  createDefaultActivityMapping,
  createDefaultActivityTemplate,
} from "../utils/default-activity-template";
import { UploadStep } from "./upload-step";

const { accounts, accountQuery } = vi.hoisted(() => {
  const accounts: Account[] = [
    {
      id: "account-1",
      name: "Broker",
      accountType: "SECURITIES",
      currency: "USD",
      isDefault: false,
      isActive: true,
      isArchived: false,
      trackingMode: "TRANSACTIONS",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  ];
  accounts.push({ ...accounts[0], id: "account-2", name: "Euro account", currency: "EUR" });
  return { accounts, accountQuery: { accounts } };
});

vi.mock("@/adapters", () => ({
  parseCsv: vi.fn(),
  listImportTemplates: vi.fn(),
  getAccountImportMapping: vi.fn(),
  linkAccountTemplate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => accountQuery }));
vi.mock("@/hooks/use-platform", () => ({ usePlatform: () => ({ isMobile: false }) }));
vi.mock("@/components/account-selector", () => ({
  AccountSelector: ({ setSelectedAccount }: { setSelectedAccount: (account: Account) => void }) => (
    <button onClick={() => setSelectedAccount(accounts[1])}>Euro account</button>
  ),
}));
vi.mock("@/components/account-selector-mobile", () => ({ AccountSelectorMobile: () => null }));
vi.mock("../components/template-picker", () => ({
  TemplatePicker: ({
    templates,
    onSelect,
  }: {
    templates: ImportTemplateData[];
    onSelect: (id: string) => void;
  }) => (
    <>
      {templates.map((template) => (
        <button key={template.id} onClick={() => onSelect(template.id)}>
          {template.name}
        </button>
      ))}
    </>
  ),
}));
vi.mock("../components/csv-file-viewer", () => ({ CSVFileViewer: () => null }));

// Each parse waits until the test releases it, so the test picks the order the results arrive in.
let pending: {
  name: string;
  config: ParseConfig;
  release: () => void;
  reject: (error: Error) => void;
}[] = [];
async function deferredParseCsv(file: File, config: ParseConfig) {
  const lines = (await file.text()).trim().split("\n").slice(config.skipTopRows);
  await new Promise<void>((release, reject) =>
    pending.push({ name: file.name, config, release, reject }),
  );
  const [headers, ...rows] = lines.map((line) => line.split(","));
  return {
    headers,
    rows,
    detectedConfig: { ...config, delimiter: "," },
    errors: [],
    rowCount: rows.length,
  };
}

// Waits for the next parse of `name` to start and returns its release.
async function nextParse(name: string, after: number) {
  await waitFor(() => expect(pending.slice(after).some((parse) => parse.name === name)).toBe(true));
  const index = pending.findIndex((parse, i) => i >= after && parse.name === name);
  return pending[index].release;
}

const wrongFile = () =>
  new File(["Wrong,Columns\n1,2\n3,4\n5,6\n"], "wrong-export.csv", { type: "text/csv" });
const rightFile = () =>
  new File(["Date,Symbol,Quantity\n2026-01-03,BBB,2\n"], "right-export.csv", { type: "text/csv" });
// The right file again, with a line the changed Skip top rows setting skips.
const rightFileWithPreamble = () =>
  new File(["Exported by Broker\nDate,Symbol,Quantity\n2026-01-03,BBB,2\n"], "right-export.csv", {
    type: "text/csv",
  });

function SelectedFile() {
  const { state } = useImportContext();
  return (
    <>
      <output data-testid="selected-file">{state.file?.name}</output>
      <output data-testid="field-mappings">{JSON.stringify(state.mapping?.fieldMappings)}</output>
      <output data-testid="parse-config">{JSON.stringify(state.parseConfig)}</output>
      <output data-testid="selected-template">{state.selectedTemplateId}</output>
      <output data-testid="parsed-data">
        {JSON.stringify({ headers: state.headers, rows: state.parsedRows })}
      </output>
    </>
  );
}

function renderUploadStep(initialAccountId = "account-1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <ImportProvider initialAccountId={initialAccountId}>
        <UploadStep />
        <SelectedFile />
      </ImportProvider>
    </QueryClientProvider>,
    { reactStrictMode: true },
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

describe("UploadStep with an earlier parse that finishes last", () => {
  beforeEach(() => {
    pending = [];
    accountQuery.accounts = accounts;
    vi.mocked(parseCsv).mockReset();
    vi.mocked(parseCsv).mockImplementation(deferredParseCsv);
    vi.mocked(listImportTemplates).mockResolvedValue([]);
    vi.mocked(getAccountImportMapping).mockRejectedValue(new Error("no saved mapping"));
  });

  it("previews the dropped file when the previous drop finishes parsing last", async () => {
    const drop = renderUploadStep();

    drop(wrongFile());
    const releaseWrong = await nextParse("wrong-export.csv", 0);
    // The user drops the right file while the wrong one is still parsing.
    drop(rightFile());
    const releaseRight = await nextParse("right-export.csv", 0);

    releaseRight();
    await screen.findByText("1 row");
    await act(async () => releaseWrong());

    expect(screen.getByTestId("selected-file")).toHaveTextContent("right-export.csv");
    expect(screen.queryByText("3 rows")).toBeNull();
    expect(previewHeaders()).toEqual(["Date", "Symbol", "Quantity"]);
  });

  it("previews the dropped file when a Parse Settings re-parse finishes last", async () => {
    const drop = renderUploadStep();

    drop(wrongFile());
    (await nextParse("wrong-export.csv", 0))();
    await screen.findByText("3 rows");

    // Changing a setting re-parses the wrong file; the right file is dropped meanwhile.
    fireEvent.click(screen.getByText("Parse Settings"));
    const parsesBefore = pending.length;
    fireEvent.change(await screen.findByLabelText("Skip top rows"), { target: { value: "1" } });
    const releaseReparse = await nextParse("wrong-export.csv", parsesBefore);
    drop(rightFileWithPreamble());
    const releaseRight = await nextParse("right-export.csv", parsesBefore);

    releaseRight();
    await screen.findByText("1 row");
    await act(async () => releaseReparse());

    expect(screen.getByTestId("selected-file")).toHaveTextContent("right-export.csv");
    expect(screen.queryByText("2 rows")).toBeNull();
    expect(previewHeaders()).toEqual(["Date", "Symbol", "Quantity"]);
  });

  it("keeps fresh template mappings when the currency effect starts another parse", async () => {
    const template: ImportTemplateData = {
      ...createDefaultActivityTemplate(),
      id: "preamble-template",
      name: "Preamble template",
      scope: "USER",
      parseConfig: { skipTopRows: 1, defaultCurrency: "EUR" },
      fieldMappings: { symbol: "Symbol" },
    };
    vi.mocked(listImportTemplates).mockResolvedValue([template]);
    const drop = renderUploadStep();
    drop(rightFileWithPreamble());
    (await nextParse("right-export.csv", 0))();
    await screen.findByText("2 rows");

    fireEvent.click(await screen.findByText(template.name));
    await waitFor(() => expect(pending).toHaveLength(3));
    expect(pending[1].config).toMatchObject({ skipTopRows: 1, defaultCurrency: "EUR" });
    expect(pending[2].config).toMatchObject({ skipTopRows: 1, defaultCurrency: "USD" });
    await act(async () => pending[2].release());
    await act(async () => pending[1].release());

    expect(previewHeaders()).toEqual(["Date", "Symbol", "Quantity"]);
    expect(screen.getByTestId("field-mappings")).toHaveTextContent('"symbol":"Symbol"');
  });

  it("resets once with the new account currency", async () => {
    const drop = renderUploadStep();
    drop(rightFileWithPreamble());
    (await nextParse("right-export.csv", 0))();
    await screen.findByText("2 rows");
    fireEvent.click(screen.getByText("Parse Settings"));
    fireEvent.change(await screen.findByLabelText("Skip top rows"), { target: { value: "1" } });
    (await nextParse("right-export.csv", 1))();
    await screen.findByText("1 row");

    fireEvent.click(screen.getByRole("button", { name: "Euro account" }));
    await waitFor(() => expect(pending).toHaveLength(3));
    expect(pending[2].config).toMatchObject({ skipTopRows: 0, defaultCurrency: "EUR" });
    await act(async () => pending[2].release());

    expect(screen.getByText("2 rows")).toBeInTheDocument();
    expect(previewHeaders()).toEqual(["Exported by Broker"]);
    expect(screen.getByTestId("parse-config")).toHaveTextContent('"skipTopRows":0');
  });

  it("ignores a stale parse failure but shows the current parse failure", async () => {
    const drop = renderUploadStep();
    drop(wrongFile());
    await nextParse("wrong-export.csv", 0);
    drop(rightFile());
    (await nextParse("right-export.csv", 0))();
    await screen.findByText("1 row");

    await act(async () => pending[0].reject(new Error("stale parse failed")));
    expect(screen.queryByText("Adjust settings to fix errors")).toBeNull();
    expect(previewHeaders()).toEqual(["Date", "Symbol", "Quantity"]);

    drop(wrongFile());
    await nextParse("wrong-export.csv", 2);
    await act(async () => pending[2].reject(new Error("current parse failed")));
    expect(await screen.findByText("Adjust settings to fix errors")).toBeInTheDocument();
  });

  it("keeps the account currency when accounts and a pending linked template load together", async () => {
    const template: ImportTemplateData = {
      ...createDefaultActivityTemplate(),
      id: "usd-template",
      name: "USD template",
      scope: "USER",
      parseConfig: { defaultCurrency: "USD" },
    };
    let releaseTemplates!: (templates: ImportTemplateData[]) => void;
    vi.mocked(listImportTemplates).mockReturnValue(
      new Promise((resolve) => {
        releaseTemplates = resolve;
      }),
    );
    vi.mocked(getAccountImportMapping).mockResolvedValue({
      ...createDefaultActivityMapping("account-2"),
      templateId: template.id,
    });
    accountQuery.accounts = [];
    renderUploadStep("account-2");
    // Let the linked template ID arrive while its template and account are still loading.
    await act(async () => {});
    await act(async () => {
      accountQuery.accounts = accounts;
      releaseTemplates([template]);
    });

    await waitFor(() =>
      expect(screen.getByTestId("selected-template")).toHaveTextContent(template.id),
    );
    expect(screen.getByTestId("parse-config")).toHaveTextContent('"defaultCurrency":"EUR"');
  });

  it.each(["success", "failure"])(
    "ignores a pending re-parse %s after file removal",
    async (outcome) => {
      const drop = renderUploadStep();
      drop(rightFile());
      (await nextParse("right-export.csv", 0))();
      await screen.findByText("1 row");
      fireEvent.click(screen.getByText("Parse Settings"));
      fireEvent.change(await screen.findByLabelText("Skip top rows"), { target: { value: "1" } });
      await nextParse("right-export.csv", 1);

      fireEvent.click(screen.getByRole("button", { name: "Remove File" }));
      await act(async () => {
        if (outcome === "success") pending[1].release();
        else pending[1].reject(new Error("removed file parse failed"));
      });

      expect(screen.getByTestId("selected-file")).toBeEmptyDOMElement();
      expect(previewHeaders()).toEqual([]);
      expect(screen.getByTestId("parsed-data")).toHaveTextContent('{"headers":[],"rows":[]}');
      expect(screen.queryByText("Adjust settings to fix errors")).toBeNull();
    },
  );
});
