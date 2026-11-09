import { fireEvent, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import copy from "@/i18n/locales/en/settings.json";
import type { ExportDatasetSummary } from "@/lib/types";
import { ExportForm } from "./exports-form";

const mocks = vi.hoisted(() => ({
  summary: vi.fn(),
  exportFile: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  getDataExportSummary: mocks.summary,
  exportDataFile: mocks.exportFile,
  logger: { error: vi.fn() },
}));

const text = copy.data_export;

function summaryRow(
  dataset: ExportDatasetSummary["dataset"],
  count: number | null,
  available = count !== 0,
): ExportDatasetSummary {
  return { dataset, group: "accounts", count, available };
}

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return render(<ExportForm />, { wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exportFile.mockResolvedValue({ status: "saved", filename: "x.csv" });
});

it("shows what each dataset holds and only offers downloads for those with data", async () => {
  // The support case: only a manual asset and a liability, nothing else.
  mocks.summary.mockResolvedValue([
    summaryRow("accounts", 0),
    summaryRow("assets-and-liabilities", 2),
    summaryRow("asset-valuations", 3),
    summaryRow("net-worth-history", null, true),
  ]);
  renderForm();

  expect(
    await screen.findByRole("button", {
      name: `Download ${text.datasets["assets-and-liabilities"].name}`,
    }),
  ).toBeEnabled();
  expect(screen.getByText("2 rows")).toBeVisible();
  expect(screen.getByText(text.daily)).toBeVisible();
  expect(
    screen.queryByRole("button", { name: `Download ${text.datasets.accounts.name}` }),
  ).toBeNull();
  expect(screen.getAllByText(text.none_yet).length).toBeGreaterThan(0);
  expect(mocks.summary).toHaveBeenCalledWith({
    includeArchived: true,
    startDate: undefined,
    endDate: undefined,
  });
});

it("exports one dataset or everything with the chosen format and options", async () => {
  mocks.summary.mockResolvedValue([summaryRow("assets-and-liabilities", 2)]);
  renderForm();

  fireEvent.click(await screen.findByRole("switch", { name: text.include_archived }));
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  fireEvent.click(
    await screen.findByRole("button", {
      name: `Download ${text.datasets["assets-and-liabilities"].name}`,
    }),
  );
  await waitFor(() =>
    expect(mocks.exportFile).toHaveBeenCalledWith(
      "JSON",
      "assets-and-liabilities",
      expect.objectContaining({ includeArchived: false }),
    ),
  );

  fireEvent.click(screen.getByRole("button", { name: text.all_button }));
  await waitFor(() =>
    expect(mocks.exportFile).toHaveBeenLastCalledWith(
      "JSON",
      "all",
      expect.objectContaining({ includeArchived: false }),
    ),
  );
});

it("turns off export all when there is nothing to export", async () => {
  mocks.summary.mockResolvedValue([summaryRow("accounts", 0), summaryRow("goals", 0)]);
  renderForm();
  await waitFor(() => expect(screen.getByRole("button", { name: text.all_button })).toBeDisabled());
});

it("still offers every download when the counts can't be loaded", async () => {
  mocks.summary.mockRejectedValue(new Error("offline"));
  renderForm();
  expect(await screen.findByText(text.summary_error)).toBeVisible();
  expect(
    screen.getByRole("button", { name: `Download ${text.datasets.goals.name}` }),
  ).toBeEnabled();
});
