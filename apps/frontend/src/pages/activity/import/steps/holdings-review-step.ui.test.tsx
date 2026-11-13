import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HoldingsFormat } from "./holdings-mapping-step";
import { HoldingsReviewStep } from "./holdings-review-step";
import type { HoldingsRow } from "../components/holdings-data-grid";
import { parseHoldingsSnapshots } from "../utils/holdings-import-utils";

const { checkHoldingsImportMock, useImportContextMock, holdingsDataGridMock } = vi.hoisted(() => ({
  checkHoldingsImportMock: vi.fn(),
  useImportContextMock: vi.fn(),
  holdingsDataGridMock: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  checkHoldingsImport: checkHoldingsImportMock,
}));

vi.mock("../context", () => ({
  useImportContext: useImportContextMock,
}));

vi.mock("../components/holdings-data-grid", () => ({
  HoldingsDataGrid: (props: unknown) => {
    holdingsDataGridMock(props);
    return <div data-testid="holdings-grid" />;
  },
}));

describe("HoldingsReviewStep validation feedback", () => {
  const dispatch = vi.fn();

  beforeEach(() => {
    dispatch.mockReset();
    holdingsDataGridMock.mockReset();
    checkHoldingsImportMock.mockReset();
    checkHoldingsImportMock.mockReturnValue(new Promise(() => undefined));
    useImportContextMock.mockReturnValue({
      dispatch,
      state: {
        headers: ["Date", "Symbol", "Quantity", "Currency"],
        parsedRows: [["2024-07-20", "AAPL", "150", "USD"]],
        mapping: {
          fieldMappings: {
            [HoldingsFormat.DATE]: "Date",
            [HoldingsFormat.SYMBOL]: "Symbol",
            [HoldingsFormat.QUANTITY]: "Quantity",
            [HoldingsFormat.CURRENCY]: "Currency",
          },
          symbolMappings: {},
        },
        parseConfig: {
          dateFormat: "YYYY-MM-DD",
          decimalSeparator: ".",
          thousandsSeparator: ",",
          defaultCurrency: "USD",
        },
        accountId: "account-1",
        draftActivities: [],
      },
    });
  });

  it("shows an accessible in-progress card while backend validation is pending", async () => {
    render(<HoldingsReviewStep />);

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Checking your holdings…");
    expect(status).toHaveTextContent("Checking 1 row before import");
    expect(dispatch).toHaveBeenCalledWith({ type: "SET_IS_VALIDATING", payload: true });

    await waitFor(() => {
      expect(checkHoldingsImportMock).toHaveBeenCalledTimes(1);
    });
  });

  it("offers a retry when validation fails", async () => {
    checkHoldingsImportMock
      .mockReset()
      .mockRejectedValueOnce(new Error("offline"))
      .mockReturnValueOnce(new Promise(() => undefined));

    render(<HoldingsReviewStep />);

    expect(await screen.findByText("We couldn't check your holdings")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Checking your holdings…");
    await waitFor(() => {
      expect(checkHoldingsImportMock).toHaveBeenCalledTimes(2);
    });
  });

  it("allows a mixed-date import to continue when one complete group is valid", async () => {
    checkHoldingsImportMock.mockReset().mockResolvedValue({
      existingDates: [],
      symbols: [],
      validationErrors: ["The snapshot date 1969-12-31 is outside the supported range."],
      validSnapshotDates: ["2024-07-20"],
      invalidSnapshotDates: ["1969-12-31"],
    });

    render(<HoldingsReviewStep />);

    expect((await screen.findAllByText("Validation Errors")).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({
        type: "SET_HOLDINGS_CHECK_PASSED",
        payload: true,
      });
    });
  });

  it("shows only format guidance when the date column is ambiguous", async () => {
    useImportContextMock.mockReturnValue({
      dispatch,
      state: {
        headers: ["Date", "Symbol", "Quantity", "Currency"],
        parsedRows: [
          ["01/02/26", "IUIT", "301", "USD"],
          ["03/04/26", "IUIT", "302", "USD"],
          ["05/06/26", "IUIT", "303", "USD"],
        ],
        mapping: {
          fieldMappings: {
            [HoldingsFormat.DATE]: "Date",
            [HoldingsFormat.SYMBOL]: "Symbol",
            [HoldingsFormat.QUANTITY]: "Quantity",
            [HoldingsFormat.CURRENCY]: "Currency",
          },
          symbolMappings: {},
        },
        parseConfig: {
          dateFormat: "auto",
          decimalSeparator: ".",
          thousandsSeparator: ",",
          defaultCurrency: "USD",
        },
        accountId: "account-1",
        draftActivities: [],
      },
    });

    render(<HoldingsReviewStep />);

    expect(await screen.findByText("Date order is ambiguous")).toBeInTheDocument();
    expect(screen.queryByText(/Use YYYY-MM-DD/)).not.toBeInTheDocument();
    expect(checkHoldingsImportMock).not.toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith({
      type: "SET_HOLDINGS_CHECK_PASSED",
      payload: false,
    });
  });

  it("clears the shared validating state when the step unmounts", async () => {
    const view = render(<HoldingsReviewStep />);

    await waitFor(() => {
      expect(dispatch).toHaveBeenCalledWith({ type: "SET_IS_VALIDATING", payload: true });
    });

    dispatch.mockClear();
    view.unmount();

    expect(dispatch).toHaveBeenCalledWith({ type: "SET_IS_VALIDATING", payload: false });
  });

  it("shows unresolved numeric formats without changing backend validation behavior", async () => {
    const context = useImportContextMock();
    context.state.parseConfig.decimalSeparator = "auto";
    context.state.parseConfig.thousandsSeparator = "auto";
    context.state.parsedRows = [["2024-07-20", "AAPL", "1,000", "USD"]];

    render(<HoldingsReviewStep />);

    expect(screen.getByText("Check number formats")).toBeInTheDocument();
    expect(screen.getByText(/ambiguous or conflicting/)).toHaveTextContent("Quantity");
    await waitFor(() => expect(checkHoldingsImportMock).toHaveBeenCalledTimes(1));
  });

  it.each(["auto", ","])(
    "preserves untouched holdings when editing with decimal %s",
    async (decimal) => {
      const context = useImportContextMock();
      context.state.parseConfig.decimalSeparator = decimal;
      context.state.parseConfig.thousandsSeparator = "auto";
      context.state.headers = ["Date", "Symbol", "Quantity", "Currency", "Cost"];
      context.state.mapping.fieldMappings.avgCost = "Cost";
      context.state.parsedRows = [
        ["2024-07-20", "AAPL", decimal === "auto" ? "1,000" : "1.000", "USD", "1,000"],
        ["2024-07-20", "MSFT", decimal === "auto" ? "25.50" : "25,50", "USD", "1,5"],
      ];

      render(<HoldingsReviewStep />);

      const { rows, onDataChange } = holdingsDataGridMock.mock.calls.at(-1)?.[0] as {
        rows: HoldingsRow[];
        onDataChange: (rows: HoldingsRow[]) => void;
      };
      expect(rows[0]).toMatchObject({ quantity: "1000", avgCost: "1.000" });
      await waitFor(() => expect(checkHoldingsImportMock).toHaveBeenCalledTimes(1));
      expect(checkHoldingsImportMock.mock.calls[0][1][0].positions[0].quantity).toBe("1000");

      // A currency-only edit must not rewrite the original numeric columns.
      act(() => onDataChange(rows.map((row) => ({ ...row, currency: "EUR" }))));
      const currencyEdit = dispatch.mock.calls
        .filter(([action]) => action.type === "SET_PARSED_DATA")
        .at(-1)?.[0];
      expect(currencyEdit.payload.rows[0][2]).toBe(context.state.parsedRows[0][2]);
      expect(currencyEdit.payload.rows[0][4]).toBe("1,000");

      // Removing the only decisive decimal must not turn the first quantity back into 1.
      act(() =>
        onDataChange(rows.map((row, index) => (index === 1 ? { ...row, quantity: "25" } : row))),
      );
      const numericEdit = dispatch.mock.calls
        .filter(([action]) => action.type === "SET_PARSED_DATA")
        .at(-1)?.[0];
      const snapshots = parseHoldingsSnapshots(
        context.state.headers,
        numericEdit.payload.rows,
        context.state.mapping.fieldMappings,
        context.state.parseConfig,
      );
      expect(snapshots[0].positions[0]).toMatchObject({ quantity: "1000", avgCost: "1.000" });
      expect(snapshots[0].positions[1].quantity).toBe("25");
    },
  );

  it.each(["quantity", "avgCost"])("accepts a cleared %s cell with decimal comma", (field) => {
    const context = useImportContextMock();
    context.state.parseConfig.decimalSeparator = ",";
    context.state.parseConfig.thousandsSeparator = ".";
    context.state.headers = ["Date", "Symbol", "Quantity", "Currency", "Cost"];
    context.state.mapping.fieldMappings.avgCost = "Cost";
    context.state.parsedRows = [["2024-07-20", "AAPL", "1,5", "USD"]];
    render(<HoldingsReviewStep />);
    const { rows, onDataChange } = holdingsDataGridMock.mock.calls.at(-1)?.[0] as {
      rows: HoldingsRow[];
      onDataChange: (rows: HoldingsRow[]) => void;
    };
    // Number cells emit null when cleared, despite the row's nominal string type.
    act(() =>
      onDataChange(rows.map((row) => ({ ...row, [field]: null })) as unknown as HoldingsRow[]),
    );
    const edit = dispatch.mock.calls
      .filter(([action]) => action.type === "SET_PARSED_DATA")
      .at(-1)?.[0];
    expect(edit.payload.rows[0][field === "quantity" ? 2 : 4]).toBe("");
  });

  it("does not let hidden footer cells reinterpret an edited numeric column", () => {
    const context = useImportContextMock();
    context.state.parseConfig.decimalSeparator = "auto";
    context.state.parseConfig.thousandsSeparator = "auto";
    context.state.parsedRows = [
      ["2024-07-20", "AAPL", "1,000", "USD"],
      ["2024-07-20", "MSFT", "2,000", "USD"],
      ["", "", "3,5", "USD"],
    ];
    render(<HoldingsReviewStep />);
    const { rows, onDataChange } = holdingsDataGridMock.mock.calls.at(-1)?.[0] as {
      rows: HoldingsRow[];
      onDataChange: (rows: HoldingsRow[]) => void;
    };
    expect(rows).toHaveLength(2);
    act(() =>
      onDataChange(rows.map((row, index) => (index === 1 ? { ...row, quantity: "2.500" } : row))),
    );
    const edit = dispatch.mock.calls
      .filter(([action]) => action.type === "SET_PARSED_DATA")
      .at(-1)?.[0];
    const snapshots = parseHoldingsSnapshots(
      context.state.headers,
      edit.payload.rows,
      context.state.mapping.fieldMappings,
      context.state.parseConfig,
    );
    expect(snapshots[0].positions.map((position) => Number(position.quantity))).toEqual([1, 2.5]);
  });
});
