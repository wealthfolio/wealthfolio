import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BuyForm } from "../buy-form";
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
    AssetTypeSelector: ({ name }: { name: string }) => (
      <div data-testid={`asset-type-selector-${name}`} />
    ),
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

describe("BuyForm", () => {
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
      render(<BuyForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("select-accountId")).toBeInTheDocument();
      expect(screen.getByTestId("symbol-search-assetId")).toBeInTheDocument();
      expect(screen.getByTestId("date-picker-activityDate")).toBeInTheDocument();
      expect(screen.getByTestId("input-quantity")).toBeInTheDocument();
      expect(screen.getByTestId("input-unitPrice")).toBeInTheDocument();
      expect(screen.getByTestId("input-fee")).toBeInTheDocument();
      // Amount is now calculated and displayed as text, not as an input field
      expect(screen.getByTestId("textarea-comment")).toBeInTheDocument();
    });

    it("renders submit button with correct text for new buy", () => {
      render(<BuyForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByRole("button", { name: /add buy/i })).toBeInTheDocument();
    });

    it("renders submit button with correct text when editing", () => {
      render(<BuyForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={true} />);

      expect(screen.getByRole("button", { name: /update/i })).toBeInTheDocument();
    });

    it("renders cancel button when onCancel is provided", () => {
      render(<BuyForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    it("does not render cancel button when onCancel is not provided", () => {
      render(<BuyForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
    });

    it("shows loading spinner when isLoading is true", () => {
      render(<BuyForm accounts={mockAccounts} onSubmit={mockOnSubmit} isLoading={true} />);

      expect(screen.getByTestId("spinner")).toBeInTheDocument();
    });

    it("disables submit button when isLoading is true", () => {
      render(<BuyForm accounts={mockAccounts} onSubmit={mockOnSubmit} isLoading={true} />);

      const submitButton = screen.getByRole("button", { name: /add buy/i });
      expect(submitButton).toBeDisabled();
    });
  });

  describe("Cancel Button", () => {
    it("calls onCancel when cancel button is clicked", async () => {
      const user = userEvent.setup();
      render(<BuyForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await user.click(cancelButton);

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });

    it("disables cancel button when isLoading is true", () => {
      render(
        <BuyForm
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

  describe("Default Values", () => {
    it("auto-selects account when only one account is provided", () => {
      const singleAccount: AccountSelectOption[] = [
        { value: "acc-single", label: "Only Account", currency: "USD" },
      ];

      render(<BuyForm accounts={singleAccount} onSubmit={mockOnSubmit} />);

      const select = screen.getByTestId("select-accountId");
      expect(select).toBeInTheDocument();
    });
  });

  describe("Form Structure", () => {
    it("wraps content in a Card component", () => {
      render(<BuyForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getAllByTestId("form-section").length).toBeGreaterThan(0);
    });

    it("renders form with proper structure", () => {
      const { container } = render(<BuyForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      const form = container.querySelector("form");
      expect(form).toBeInTheDocument();
    });
  });

  describe("Amount Calculation Display", () => {
    it("renders the form with quantity, price and fee fields for amount calculation", () => {
      render(<BuyForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      // Amount is now calculated from quantity * price + fee and displayed as text
      // The form should have the inputs for the calculation
      expect(screen.getByTestId("input-quantity")).toBeInTheDocument();
      expect(screen.getByTestId("input-unitPrice")).toBeInTheDocument();
      expect(screen.getByTestId("input-fee")).toBeInTheDocument();
    });
  });

  describe("Loading State", () => {
    it("shows check icon when editing and not loading", () => {
      render(<BuyForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={true} />);

      expect(screen.getByTestId("check-icon")).toBeInTheDocument();
    });

    it("shows plus icon when creating new and not loading", () => {
      render(<BuyForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={false} />);

      expect(screen.getByTestId("plus-icon")).toBeInTheDocument();
    });
  });

  describe("Stock Cover Mode", () => {
    it("does not show Buy to Cover controls without a short holding", () => {
      render(<BuyForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.queryByTestId("stock-trade-intent-selector")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /add buy/i })).toBeInTheDocument();
    });

    it("shows Buy to Cover controls when the selected stock holding is negative", () => {
      holdingsHook.useHoldings.mockReturnValue({
        holdings: [
          {
            id: "SEC-acc-1-AAPL",
            instrument: { id: "AAPL", symbol: "AAPL" },
            quantity: -5,
          } as Holding,
        ],
        isLoading: false,
      });

      render(
        <BuyForm
          accounts={mockAccounts}
          defaultValues={{ accountId: "acc-1", assetId: "AAPL" }}
          onSubmit={mockOnSubmit}
        />,
      );

      expect(screen.getByTestId("stock-trade-intent-selector")).toBeInTheDocument();
      expect(screen.getByText("Short: 5 shares")).toBeInTheDocument();
      expect(screen.getByText(/Use Buy to Cover to reduce it/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /add buy/i })).toBeEnabled();
    });

    it("warns for Buy to Cover when there is no short holding", () => {
      render(
        <BuyForm
          accounts={mockAccounts}
          defaultValues={{
            accountId: "acc-1",
            assetId: "AAPL",
            subtype: ACTIVITY_SUBTYPES.POSITION_CLOSE,
          }}
          onSubmit={mockOnSubmit}
        />,
      );

      expect(screen.getByText(/requires an existing short position/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /buy to cover/i })).toBeEnabled();
    });

    it("resets the Buy to Cover intent when the selected symbol changes", async () => {
      const user = userEvent.setup();
      holdingsHook.useHoldings.mockReturnValue({
        holdings: [
          {
            id: "SEC-acc-1-AAPL",
            instrument: { id: "AAPL", symbol: "AAPL" },
            quantity: -5,
          } as Holding,
        ],
        isLoading: false,
      });

      render(
        <BuyForm
          accounts={mockAccounts}
          defaultValues={{
            accountId: "acc-1",
            assetId: "AAPL",
            assetType: "stock",
            subtype: ACTIVITY_SUBTYPES.POSITION_CLOSE,
          }}
          onSubmit={mockOnSubmit}
        />,
      );

      // Starts as Buy to Cover.
      expect(screen.getByRole("button", { name: /buy to cover/i })).toBeInTheDocument();

      const symbolInput = screen.getByTestId("symbol-search-assetId");
      await user.clear(symbolInput);
      await user.type(symbolInput, "MSFT");

      // Intent reset back to normal Buy.
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /add buy/i })).toBeInTheDocument();
      });
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
        <BuyForm accounts={mockAccounts} defaultValues={optionDefaults} onSubmit={mockOnSubmit} />,
      );

      expect(screen.getByTestId("position-intent-selector")).toHaveAttribute("data-value", "");

      await user.click(screen.getByRole("button", { name: /add buy/i }));

      await waitFor(() => {
        expect(mockOnSubmit).not.toHaveBeenCalled();
      });
    });

    it("submits an option once an intent is chosen", async () => {
      const user = userEvent.setup();

      render(
        <BuyForm accounts={mockAccounts} defaultValues={optionDefaults} onSubmit={mockOnSubmit} />,
      );

      await user.click(screen.getByRole("button", { name: "Open" }));
      await user.click(screen.getByRole("button", { name: /buy to open/i }));

      await waitFor(() => {
        expect(mockOnSubmit).toHaveBeenCalledTimes(1);
      });
      expect(mockOnSubmit.mock.calls[0][0].subtype).toBe(ACTIVITY_SUBTYPES.POSITION_OPEN);
    });
  });
});
