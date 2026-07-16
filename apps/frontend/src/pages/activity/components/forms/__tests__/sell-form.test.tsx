import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SellForm } from "../sell-form";
import { ACTIVITY_SUBTYPES } from "@/lib/constants";
import type { AccountSelectOption } from "../fields";
import type { Holding } from "@/lib/types";

interface UseHoldingsResult {
  holdings: Holding[];
  isLoading: boolean;
}

const holdingsHook = vi.hoisted(() => ({
  useHoldings: vi.fn<() => UseHoldingsResult>(() => ({
    holdings: [],
    isLoading: false,
  })),
}));

// Mock useSettings hook to avoid AuthProvider dependency
vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    data: { baseCurrency: "USD" },
    isLoading: false,
    error: null,
  }),
}));

// Mock the useHoldings hook
vi.mock("@/hooks/use-holdings", () => ({
  useHoldings: holdingsHook.useHoldings,
}));

// Mock the fields components
vi.mock("../fields", async () => {
  const { useFormContext } =
    await vi.importActual<typeof import("react-hook-form")>("react-hook-form");

  return {
    AccountSelect: ({ name, accounts }: { name: string; accounts: AccountSelectOption[] }) => {
      const { register } = useFormContext();

      return (
        <select data-testid={`select-${name}`} {...register(name)}>
          <option value="">Select account...</option>
          {accounts.map((acc) => (
            <option key={acc.value} value={acc.value}>
              {acc.label}
            </option>
          ))}
        </select>
      );
    },
    SymbolSearch: ({ name }: { name: string }) => {
      const { register } = useFormContext();

      return <input data-testid={`symbol-search-${name}`} {...register(name)} />;
    },
    DatePicker: ({ name, label }: { name: string; label: string }) => (
      <div data-testid={`date-picker-${name}`}>{label}</div>
    ),
    AmountInput: ({ name, label }: { name: string; label: string }) => {
      const { register } = useFormContext();

      return (
        <div>
          <label htmlFor={name}>{label}</label>
          <input
            data-testid={`input-${name}`}
            type="number"
            id={name}
            {...register(name, { valueAsNumber: true })}
          />
        </div>
      );
    },
    QuantityInput: ({ name, label }: { name: string; label: string }) => {
      const { register } = useFormContext();

      return (
        <div>
          <label htmlFor={name}>{label}</label>
          <input
            data-testid={`input-${name}`}
            type="number"
            id={name}
            {...register(name, { valueAsNumber: true })}
          />
        </div>
      );
    },
    NotesInput: ({ name, label }: { name: string; label: string }) => {
      const { register } = useFormContext();

      return (
        <div>
          <label htmlFor={name}>{label}</label>
          <textarea data-testid={`textarea-${name}`} id={name} {...register(name)} />
        </div>
      );
    },
    OptionContractFields: () => {
      const { register } = useFormContext();
      return (
        <div data-testid="option-contract-fields">
          <input data-testid="input-underlyingSymbol" {...register("underlyingSymbol")} />
          <input
            data-testid="input-strikePrice"
            type="number"
            {...register("strikePrice", { valueAsNumber: true })}
          />
          <input data-testid="input-expirationDate" {...register("expirationDate")} />
        </div>
      );
    },
    PositionIntentSelector: ({ name = "subtype" }: { name?: string }) => {
      const { setValue, watch } = useFormContext();
      const value = watch(name);
      return (
        <div data-testid="position-intent-selector" data-value={value ?? ""}>
          <button type="button" onClick={() => setValue(name, "POSITION_OPEN")}>
            Open
          </button>
          <button type="button" onClick={() => setValue(name, "POSITION_CLOSE")}>
            Close
          </button>
        </div>
      );
    },
    StockTradeIntentSelector: () => <div data-testid="stock-trade-intent-selector" />,
    AssetTypeSelector: ({ name }: { name: string }) => (
      <div data-testid={`asset-type-selector-${name}`} />
    ),
    AdvancedOptionsSection: ({ children }: { children?: React.ReactNode }) => (
      <div data-testid="advanced-options-section">{children}</div>
    ),
    FormSection: ({
      action,
      children,
    }: {
      action?: React.ReactNode;
      children?: React.ReactNode;
    }) => (
      <div data-testid="form-section">
        {action}
        {children}
      </div>
    ),
    createValidatedSubmit: vi.fn((form, handler) => form.handleSubmit(handler)),
  };
});

// Mock UI components
vi.mock("@wealthfolio/ui/components/ui/button", () => ({
  Button: ({
    children,
    type,
    onClick,
    disabled,
    variant,
  }: {
    children: React.ReactNode;
    type?: string;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
  }) => (
    <button
      type={type as "submit" | "button"}
      onClick={onClick}
      disabled={disabled}
      data-variant={variant}
    >
      {children}
    </button>
  ),
}));

vi.mock("@wealthfolio/ui/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div data-testid="card">{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="card-content">{children}</div>
  ),
}));

vi.mock("@wealthfolio/ui/components/ui/alert", () => ({
  Alert: ({ children }: { children: React.ReactNode }) => <div data-testid="alert">{children}</div>,
  AlertDescription: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="alert-description">{children}</div>
  ),
}));

vi.mock("@wealthfolio/ui/components/ui/icons", () => ({
  Icons: {
    Spinner: () => <span data-testid="spinner">Loading...</span>,
    Check: () => <span data-testid="check-icon">Check</span>,
    Plus: () => <span data-testid="plus-icon">Plus</span>,
    AlertTriangle: () => <span data-testid="alert-triangle">Warning</span>,
  },
}));

const mockAccounts: AccountSelectOption[] = [
  { value: "acc-1", label: "Savings Account", currency: "USD" },
  { value: "acc-2", label: "Investment Account", currency: "EUR" },
];

const baseSellDefaults = {
  accountId: "acc-1",
  assetId: "CJR28A",
  assetType: "bond" as const,
  activityDate: new Date("2026-04-16T16:00:00"),
  quantity: 100_000,
  unitPrice: 1,
  fee: 0,
  currency: "USD",
};

function createHolding(symbol: string, quantity: number, assetId = symbol): Holding {
  return {
    id: `SEC-acc-1-${assetId}`,
    instrument: {
      id: assetId,
      symbol,
    },
    quantity,
  } as Holding;
}

describe("SellForm", () => {
  const mockOnSubmit = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    holdingsHook.useHoldings.mockReturnValue({
      holdings: [],
      isLoading: false,
    });
  });

  describe("Render Tests", () => {
    it("renders all form fields", () => {
      render(<SellForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("select-accountId")).toBeInTheDocument();
      expect(screen.getByTestId("symbol-search-assetId")).toBeInTheDocument();
      expect(screen.getByTestId("date-picker-activityDate")).toBeInTheDocument();
      expect(screen.getByTestId("input-quantity")).toBeInTheDocument();
      expect(screen.getByTestId("input-unitPrice")).toBeInTheDocument();
      expect(screen.getByTestId("input-fee")).toBeInTheDocument();
      // Amount is now calculated and displayed as text, not as an input field
      expect(screen.getByTestId("textarea-comment")).toBeInTheDocument();
    });

    it("renders submit button with correct text for new sell", () => {
      render(<SellForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByRole("button", { name: /add sell/i })).toBeInTheDocument();
    });

    it("renders submit button with correct text when editing", () => {
      render(<SellForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={true} />);

      expect(screen.getByRole("button", { name: /update/i })).toBeInTheDocument();
    });

    it("renders cancel button when onCancel is provided", () => {
      render(<SellForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    it("does not render cancel button when onCancel is not provided", () => {
      render(<SellForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
    });

    it("shows loading spinner when isLoading is true", () => {
      render(<SellForm accounts={mockAccounts} onSubmit={mockOnSubmit} isLoading={true} />);

      expect(screen.getByTestId("spinner")).toBeInTheDocument();
    });

    it("disables submit button when isLoading is true", () => {
      render(<SellForm accounts={mockAccounts} onSubmit={mockOnSubmit} isLoading={true} />);

      const submitButton = screen.getByRole("button", { name: /add sell/i });
      expect(submitButton).toBeDisabled();
    });
  });

  describe("Cancel Button", () => {
    it("calls onCancel when cancel button is clicked", async () => {
      const user = userEvent.setup();
      render(<SellForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await user.click(cancelButton);

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });

    it("disables cancel button when isLoading is true", () => {
      render(
        <SellForm
          accounts={mockAccounts}
          onSubmit={mockOnSubmit}
          onCancel={mockOnCancel}
          isLoading={true}
        />,
      );

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      expect(cancelButton).toBeDisabled();
    });
  });

  describe("Form Structure", () => {
    it("wraps content in a Card component", () => {
      render(<SellForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getAllByTestId("form-section").length).toBeGreaterThan(0);
    });

    it("renders form with proper structure", () => {
      const { container } = render(<SellForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      const form = container.querySelector("form");
      expect(form).toBeInTheDocument();
    });
  });

  describe("Loading State", () => {
    it("shows check icon when editing and not loading", () => {
      render(<SellForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={true} />);

      expect(screen.getByTestId("check-icon")).toBeInTheDocument();
    });

    it("shows plus icon when creating new and not loading", () => {
      render(<SellForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={false} />);

      expect(screen.getByTestId("plus-icon")).toBeInTheDocument();
    });
  });

  describe("Holdings Warning", () => {
    it("does not warn when editing a sell that fully closed the holding", () => {
      render(
        <SellForm
          accounts={mockAccounts}
          defaultValues={baseSellDefaults}
          onSubmit={mockOnSubmit}
          isEditing={true}
        />,
      );

      expect(screen.queryByTestId("alert")).not.toBeInTheDocument();
      expect(screen.getByText("Available: 100,000")).toBeInTheDocument();
    });

    it("adds back the original sell quantity when editing the same holding", async () => {
      const user = userEvent.setup();
      holdingsHook.useHoldings.mockReturnValue({
        holdings: [createHolding("CJR28A", 60)],
        isLoading: false,
      });

      render(
        <SellForm
          accounts={mockAccounts}
          defaultValues={{ ...baseSellDefaults, quantity: 40 }}
          onSubmit={mockOnSubmit}
          isEditing={true}
        />,
      );

      expect(screen.getByText("Available: 100")).toBeInTheDocument();

      const quantityInput = screen.getByTestId("input-quantity");
      await user.clear(quantityInput);
      await user.type(quantityInput, "80");

      await waitFor(() => {
        expect(screen.queryByTestId("alert")).not.toBeInTheDocument();
      });
    });

    it("warns when an edited sell exceeds the adjusted available quantity", async () => {
      const user = userEvent.setup();
      holdingsHook.useHoldings.mockReturnValue({
        holdings: [createHolding("CJR28A", 60)],
        isLoading: false,
      });

      render(
        <SellForm
          accounts={mockAccounts}
          defaultValues={{ ...baseSellDefaults, quantity: 40 }}
          onSubmit={mockOnSubmit}
          isEditing={true}
        />,
      );

      const quantityInput = screen.getByTestId("input-quantity");
      await user.clear(quantityInput);
      await user.type(quantityInput, "101");

      await waitFor(() => {
        expect(screen.getByTestId("alert-description")).toHaveTextContent(
          "than your available holdings (100)",
        );
      });
    });

    it("warns for Sell Short while the selected stock is long", () => {
      holdingsHook.useHoldings.mockReturnValue({
        holdings: [createHolding("AAPL", 5)],
        isLoading: false,
      });

      render(
        <SellForm
          accounts={mockAccounts}
          defaultValues={{
            accountId: "acc-1",
            assetId: "AAPL",
            assetType: "stock",
            subtype: ACTIVITY_SUBTYPES.POSITION_OPEN,
          }}
          onSubmit={mockOnSubmit}
        />,
      );

      expect(screen.getByText(/split this into a normal Sell first/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /sell short/i })).toBeEnabled();
    });

    it("warns for a normal Sell while the selected stock is already short", () => {
      holdingsHook.useHoldings.mockReturnValue({
        holdings: [createHolding("AAPL", -5)],
        isLoading: false,
      });

      render(
        <SellForm
          accounts={mockAccounts}
          defaultValues={{
            accountId: "acc-1",
            assetId: "AAPL",
            assetType: "stock",
          }}
          onSubmit={mockOnSubmit}
        />,
      );

      expect(screen.getByText(/already have a short position/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /add sell/i })).toBeEnabled();
    });

    it("does not add back the original sell quantity after changing the asset", async () => {
      const user = userEvent.setup();
      holdingsHook.useHoldings.mockReturnValue({
        holdings: [createHolding("CJR28A", 60)],
        isLoading: false,
      });

      render(
        <SellForm
          accounts={mockAccounts}
          defaultValues={{ ...baseSellDefaults, quantity: 40 }}
          onSubmit={mockOnSubmit}
          isEditing={true}
        />,
      );

      const symbolInput = screen.getByTestId("symbol-search-assetId");
      await user.clear(symbolInput);
      await user.type(symbolInput, "MSFT");

      await waitFor(() => {
        expect(screen.getByTestId("alert-description")).toHaveTextContent(
          "than your available holdings (0)",
        );
      });
    });

    it("resets the Sell Short intent when the selected symbol changes", async () => {
      const user = userEvent.setup();

      render(
        <SellForm
          accounts={mockAccounts}
          defaultValues={{
            accountId: "acc-1",
            assetId: "AAPL",
            assetType: "stock",
            subtype: ACTIVITY_SUBTYPES.POSITION_OPEN,
            quantity: 1,
            unitPrice: 10,
            currency: "USD",
          }}
          onSubmit={mockOnSubmit}
        />,
      );

      // Starts as Sell Short.
      expect(screen.getByRole("button", { name: /sell short/i })).toBeInTheDocument();

      const symbolInput = screen.getByTestId("symbol-search-assetId");
      await user.clear(symbolInput);
      await user.type(symbolInput, "MSFT");

      // Intent reset back to normal Sell.
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /add sell/i })).toBeInTheDocument();
      });
    });

    it("matches current holdings by instrument id as well as display symbol", () => {
      holdingsHook.useHoldings.mockReturnValue({
        holdings: [createHolding("CJR28A", 10, "SEC:CJR28A:XTSE")],
        isLoading: false,
      });

      render(
        <SellForm
          accounts={mockAccounts}
          defaultValues={{
            ...baseSellDefaults,
            assetId: "SEC:CJR28A:XTSE",
            assetType: "stock",
            quantity: 5,
          }}
          onSubmit={mockOnSubmit}
        />,
      );

      expect(screen.queryByTestId("alert")).not.toBeInTheDocument();
      expect(screen.getByText("Available: 10")).toBeInTheDocument();
    });
  });

  describe("Option Position Intent", () => {
    const optionDefaults = {
      accountId: "acc-1",
      assetType: "option" as const,
      underlyingSymbol: "AAPL",
      strikePrice: 200,
      expirationDate: "2026-12-19",
      optionType: "CALL" as const,
      quantity: 1,
      unitPrice: 5,
      currency: "USD",
    };

    it("blocks submit for an option with no Open/Close intent chosen", async () => {
      const user = userEvent.setup();

      render(
        <SellForm accounts={mockAccounts} defaultValues={optionDefaults} onSubmit={mockOnSubmit} />,
      );

      // No intent pre-selected.
      expect(screen.getByTestId("position-intent-selector")).toHaveAttribute("data-value", "");

      await user.click(screen.getByRole("button", { name: /add sell/i }));

      await waitFor(() => {
        expect(mockOnSubmit).not.toHaveBeenCalled();
      });
    });

    it("submits an option once an intent is chosen", async () => {
      const user = userEvent.setup();

      render(
        <SellForm accounts={mockAccounts} defaultValues={optionDefaults} onSubmit={mockOnSubmit} />,
      );

      await user.click(screen.getByRole("button", { name: "Open" }));
      await user.click(screen.getByRole("button", { name: /sell to open/i }));

      await waitFor(() => {
        expect(mockOnSubmit).toHaveBeenCalledTimes(1);
      });
      expect(mockOnSubmit.mock.calls[0][0].subtype).toBe(ACTIVITY_SUBTYPES.POSITION_OPEN);
    });
  });
});
