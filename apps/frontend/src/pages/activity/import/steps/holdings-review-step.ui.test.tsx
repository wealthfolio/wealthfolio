import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HoldingsFormat } from "./holdings-mapping-step";
import { HoldingsReviewStep } from "./holdings-review-step";

const { checkHoldingsImportMock, useImportContextMock } = vi.hoisted(() => ({
  checkHoldingsImportMock: vi.fn(),
  useImportContextMock: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  checkHoldingsImport: checkHoldingsImportMock,
}));

vi.mock("../context", () => ({
  useImportContext: useImportContextMock,
}));

vi.mock("../components/holdings-data-grid", () => ({
  HoldingsDataGrid: () => <div data-testid="holdings-grid" />,
}));

describe("HoldingsReviewStep validation feedback", () => {
  const dispatch = vi.fn();

  beforeEach(() => {
    dispatch.mockReset();
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
});
