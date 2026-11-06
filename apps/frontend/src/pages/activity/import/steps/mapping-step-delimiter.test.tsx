import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseCsv } from "@/adapters";
import type { ImportTemplateData, ParseConfig } from "@/lib/types";
import { ImportProvider, setFile, setMapping, setParsedData, useImportContext } from "../context";
import {
  createDefaultActivityMapping,
  createDefaultActivityTemplate,
} from "../utils/default-activity-template";
import { MappingStepUnified } from "./mapping-step-unified";

const { autoTemplate } = vi.hoisted(() => ({
  autoTemplate: {
    id: "auto-template",
    name: "Auto broker",
    scope: "USER",
    kind: "CSV_ACTIVITY",
    fieldMappings: {},
    activityMappings: {},
    symbolMappings: {},
    accountMappings: {},
    symbolMappingMeta: {},
    parseConfig: { delimiter: "auto" },
  } satisfies ImportTemplateData,
}));

vi.mock("@/adapters", () => ({
  getAccounts: vi.fn().mockResolvedValue([]),
  listImportTemplates: vi.fn().mockResolvedValue([autoTemplate]),
  // The parser reports the delimiter it detected in the semicolon file.
  parseCsv: vi.fn((_file: File, config: ParseConfig) =>
    Promise.resolve({
      headers: ["Date", "Symbol", "Quantity"],
      rows: [["2026-01-02", "AAA", "1"]],
      detectedConfig: { ...config, delimiter: ";" },
      errors: [],
      rowCount: 1,
    }),
  ),
  saveImportTemplate: vi.fn(),
  saveAccountImportMapping: vi.fn(),
  deleteImportTemplate: vi.fn(),
}));
vi.mock("../components/mapping-table", () => ({ MappingTable: () => null }));
vi.mock("../components/csv-file-viewer", () => ({ CSVFileViewer: () => null }));
vi.mock("../components/template-picker", () => ({
  TemplatePicker: ({
    templates,
    onSelect,
  }: {
    templates: ImportTemplateData[];
    onSelect: (id: string) => void;
  }) =>
    templates.map((template) => (
      <button key={template.id} onClick={() => onSelect(template.id)}>
        {template.name}
      </button>
    )),
}));

function SeedMapping() {
  const { state, dispatch } = useImportContext();

  useEffect(() => {
    dispatch(setFile(new File(["Date;Symbol;Quantity\n2026-01-02;AAA;1\n"], "semicolon.csv")));
    dispatch(setMapping(createDefaultActivityMapping("account-1")));
    dispatch(setParsedData(["Date", "Symbol", "Quantity"], [["2026-01-02", "AAA", "1"]]));
  }, [dispatch]);

  return state.parsedRows.length > 0 ? (
    <>
      <MappingStepUnified />
      <output data-testid="selected-template">{state.selectedTemplateId}</output>
      <output data-testid="delimiter">{state.parseConfig.delimiter}</output>
    </>
  ) : null;
}

describe("MappingStepUnified template delimiter", () => {
  beforeEach(() => {
    vi.mocked(parseCsv).mockClear();
  });

  it.each([
    { name: "a saved template set to Auto-detect", template: autoTemplate },
    { name: "the Default template", template: createDefaultActivityTemplate() },
  ])("keeps Auto-detect after re-parsing with $name", async ({ template }) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ImportProvider initialAccountId="account-1">
          <SeedMapping />
        </ImportProvider>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: template.name }));

    await waitFor(() =>
      expect(screen.getByTestId("selected-template")).toHaveTextContent(template.id),
    );
    expect(vi.mocked(parseCsv).mock.lastCall?.[1].delimiter).toBe("auto");
    expect(screen.getByTestId("delimiter")).toHaveTextContent("auto");
  });
});
