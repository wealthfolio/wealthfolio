import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ExchangeForm } from "../exchange-form";
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

// Mock the useHoldings hook (needs QueryClientProvider otherwise)
vi.mock("@/hooks/use-holdings", () => ({
  useHoldings: holdingsHook.useHoldings,
}));

// Mock the fields components
vi.mock("../fields", () => ({
  AccountSelect: ({
    name,
    accounts,
    label,
  }: {
    name: string;
    accounts: AccountSelectOption[];
    label?: string;
  }) => (
    <div>
      {label && <label htmlFor={name}>{label}</label>}
      <select data-testid={`select-${name}`} name={name} id={name}>
        <option value="">Select account...</option>
        {accounts.map((acc) => (
          <option key={acc.value} value={acc.value}>
            {acc.label}
          </option>
        ))}
      </select>
    </div>
  ),
  SymbolSearch: ({ name, label }: { name: string; label?: string }) => (
    <div>
      {label && <label htmlFor={name}>{label}</label>}
      <input data-testid={`symbol-search-${name}`} name={name} id={name} />
    </div>
  ),
  DatePicker: ({ name, label }: { name: string; label: string }) => (
    <div data-testid={`date-picker-${name}`}>{label}</div>
  ),
  AmountInput: ({ name, label }: { name: string; label: string }) => (
    <div>
      <label htmlFor={name}>{label}</label>
      <input data-testid={`input-${name}`} name={name} type="number" id={name} />
    </div>
  ),
  QuantityInput: ({ name, label }: { name: string; label: string }) => (
    <div>
      <label htmlFor={name}>{label}</label>
      <input data-testid={`input-${name}`} name={name} type="number" id={name} />
    </div>
  ),
  NotesInput: ({ name, label }: { name: string; label: string }) => (
    <div>
      <label htmlFor={name}>{label}</label>
      <textarea data-testid={`textarea-${name}`} name={name} id={name} />
    </div>
  ),
  FormSection: ({ title, children }: { title?: string; children?: React.ReactNode }) => (
    <div data-testid="form-section">
      {title && <h3>{title}</h3>}
      {children}
    </div>
  ),
  createValidatedSubmit: vi.fn((_form, handler) => handler),
}));

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

vi.mock("@wealthfolio/ui/components/ui/icons", () => ({
  Icons: {
    Spinner: () => <span data-testid="spinner">Loading...</span>,
    Check: () => <span data-testid="check-icon">Check</span>,
    Plus: () => <span data-testid="plus-icon">Plus</span>,
    AlertTriangle: () => <span data-testid="alert-triangle-icon">!</span>,
  },
}));

const mockAccounts: AccountSelectOption[] = [
  { value: "acc-1", label: "Savings Account", currency: "USD" },
  { value: "acc-2", label: "Investment Account", currency: "EUR" },
];

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

describe("ExchangeForm", () => {
  const mockOnSubmit = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    holdingsHook.useHoldings.mockReturnValue({ holdings: [], isLoading: false });
  });

  describe("Render Tests", () => {
    it("renders account select and date picker", () => {
      render(<ExchangeForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("select-accountId")).toBeInTheDocument();
      expect(screen.getByTestId("date-picker-activityDate")).toBeInTheDocument();
    });

    it("renders distinct closing and opening date pickers", () => {
      render(<ExchangeForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("date-picker-activityDate")).toBeInTheDocument();
      expect(screen.getByTestId("date-picker-toActivityDate")).toBeInTheDocument();
      expect(screen.getByText("Closing Date")).toBeInTheDocument();
      expect(screen.getByText("Opening Date")).toBeInTheDocument();
    });

    it("renders distinct closing and opening asset pickers", () => {
      render(<ExchangeForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("symbol-search-fromAssetId")).toBeInTheDocument();
      expect(screen.getByTestId("symbol-search-toAssetId")).toBeInTheDocument();
      // The two pickers must be independently identifiable (this is what broke
      // e2e symbol search before ticker-search.tsx wired up aria-label).
      expect(screen.getByText("Closing Asset")).toBeInTheDocument();
      expect(screen.getByText("Opening Asset")).toBeInTheDocument();
    });

    it("renders distinct quantity inputs for each leg", () => {
      render(<ExchangeForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("input-fromQuantity")).toBeInTheDocument();
      expect(screen.getByTestId("input-toQuantity")).toBeInTheDocument();
    });

    it("renders an optional fee input", () => {
      render(<ExchangeForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("input-fee")).toBeInTheDocument();
    });

    it("renders notes field", () => {
      render(<ExchangeForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("textarea-comment")).toBeInTheDocument();
    });

    it("renders submit button with correct text for a new exchange", () => {
      render(<ExchangeForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByRole("button", { name: /add exchange/i })).toBeInTheDocument();
    });

    it("renders submit button with correct text when editing", () => {
      render(<ExchangeForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={true} />);

      expect(screen.getByRole("button", { name: /update/i })).toBeInTheDocument();
    });

    it("renders cancel button when onCancel is provided", () => {
      render(
        <ExchangeForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />,
      );

      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    it("does not render cancel button when onCancel is not provided", () => {
      render(<ExchangeForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
    });

    it("shows loading spinner and disables submit when isLoading is true", () => {
      render(<ExchangeForm accounts={mockAccounts} onSubmit={mockOnSubmit} isLoading={true} />);

      expect(screen.getByTestId("spinner")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /add exchange/i })).toBeDisabled();
    });
  });

  describe("Cancel Button", () => {
    it("calls onCancel when cancel button is clicked", async () => {
      const user = userEvent.setup();
      render(
        <ExchangeForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />,
      );

      await user.click(screen.getByRole("button", { name: /cancel/i }));

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe("Form Structure", () => {
    it("renders form with proper structure", () => {
      const { container } = render(
        <ExchangeForm accounts={mockAccounts} onSubmit={mockOnSubmit} />,
      );

      expect(container.querySelector("form")).toBeInTheDocument();
      expect(screen.getAllByTestId("form-section").length).toBeGreaterThan(0);
    });
  });

  describe("Holdings validation", () => {
    it("blocks submission when exchanging out more shares than currently held", async () => {
      holdingsHook.useHoldings.mockReturnValue({
        holdings: [createHolding("AAPL", 5, "aapl-id")],
        isLoading: false,
      });
      const user = userEvent.setup();
      render(
        <ExchangeForm
          accounts={mockAccounts}
          onSubmit={mockOnSubmit}
          defaultValues={{
            accountId: "acc-1",
            fromAssetId: "AAPL",
            fromQuantity: 10,
          }}
        />,
      );

      await user.click(screen.getByRole("button", { name: /add exchange/i }));

      expect(mockOnSubmit).not.toHaveBeenCalled();
    });

    it("allows submission when exchanging out no more than currently held", async () => {
      holdingsHook.useHoldings.mockReturnValue({
        holdings: [createHolding("AAPL", 5, "aapl-id")],
        isLoading: false,
      });
      const user = userEvent.setup();
      render(
        <ExchangeForm
          accounts={mockAccounts}
          onSubmit={mockOnSubmit}
          defaultValues={{
            accountId: "acc-1",
            fromAssetId: "AAPL",
            fromQuantity: 5,
          }}
        />,
      );

      await user.click(screen.getByRole("button", { name: /add exchange/i }));

      expect(mockOnSubmit).toHaveBeenCalledTimes(1);
    });
  });
});
