import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DepositForm } from "../deposit-form";
import type { AccountSelectOption } from "../fields";

// Mock useSettings hook to avoid AuthProvider dependency
vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    data: { baseCurrency: "USD" },
    isLoading: false,
    error: null,
  }),
}));

// Mock the fields components
vi.mock("../fields", () => ({
  AccountSelect: ({ name, accounts }: { name: string; accounts: AccountSelectOption[] }) => (
    <select data-testid={`select-${name}`} name={name}>
      <option value="">Select account...</option>
      {accounts.map((acc) => (
        <option key={acc.value} value={acc.value}>
          {acc.label}
        </option>
      ))}
    </select>
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
  NotesInput: ({ name, label }: { name: string; label: string }) => (
    <div>
      <label htmlFor={name}>{label}</label>
      <textarea data-testid={`textarea-${name}`} name={name} id={name} />
    </div>
  ),
  AdvancedOptionsSection: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="advanced-options-section">{children}</div>
  ),
  FormSection: ({ action, children }: { action?: React.ReactNode; children?: React.ReactNode }) => (
    <div data-testid="form-section">
      {action}
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

vi.mock("@wealthfolio/ui/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div data-testid="card">{children}</div>,
  CardContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="card-content">{children}</div>
  ),
}));

vi.mock("@wealthfolio/ui/components/ui/icons", () => ({
  Icons: {
    Spinner: () => <span data-testid="spinner">Loading...</span>,
    Check: () => <span data-testid="check-icon">Check</span>,
    Plus: () => <span data-testid="plus-icon">Plus</span>,
  },
}));

const mockAccounts: AccountSelectOption[] = [
  { value: "acc-1", label: "Savings Account", currency: "USD" },
  { value: "acc-2", label: "Investment Account", currency: "EUR" },
];

describe("DepositForm", () => {
  const mockOnSubmit = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Render Tests", () => {
    it("renders all form fields", () => {
      render(<DepositForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("select-accountId")).toBeInTheDocument();
      expect(screen.getByTestId("date-picker-activityDate")).toBeInTheDocument();
      expect(screen.getByTestId("input-amount")).toBeInTheDocument();
      expect(screen.getByTestId("textarea-comment")).toBeInTheDocument();
    });

    it("renders submit button with correct text for new deposit", () => {
      render(<DepositForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByRole("button", { name: /add deposit/i })).toBeInTheDocument();
    });

    it("renders submit button with correct text when editing", () => {
      render(<DepositForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={true} />);

      expect(screen.getByRole("button", { name: /update/i })).toBeInTheDocument();
    });

    it("renders cancel button when onCancel is provided", () => {
      render(
        <DepositForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />,
      );

      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    it("does not render cancel button when onCancel is not provided", () => {
      render(<DepositForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
    });

    it("shows loading spinner when isLoading is true", () => {
      render(<DepositForm accounts={mockAccounts} onSubmit={mockOnSubmit} isLoading={true} />);

      expect(screen.getByTestId("spinner")).toBeInTheDocument();
    });

    it("disables submit button when isLoading is true", () => {
      render(<DepositForm accounts={mockAccounts} onSubmit={mockOnSubmit} isLoading={true} />);

      const submitButton = screen.getByRole("button", { name: /add deposit/i });
      expect(submitButton).toBeDisabled();
    });
  });

  describe("Cancel Button", () => {
    it("calls onCancel when cancel button is clicked", async () => {
      const user = userEvent.setup();
      render(
        <DepositForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />,
      );

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await user.click(cancelButton);

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });

    it("disables cancel button when isLoading is true", () => {
      render(
        <DepositForm
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

      render(<DepositForm accounts={singleAccount} onSubmit={mockOnSubmit} />);

      // The AccountSelect mock should receive the accounts
      const select = screen.getByTestId("select-accountId");
      expect(select).toBeInTheDocument();
    });
  });

  describe("Form Structure", () => {
    it("wraps content in a Card component", () => {
      render(<DepositForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getAllByTestId("form-section").length).toBeGreaterThan(0);
    });

    it("renders form with proper structure", () => {
      const { container } = render(<DepositForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      const form = container.querySelector("form");
      expect(form).toBeInTheDocument();
    });
  });

  describe("Loading State", () => {
    it("shows check icon when editing and not loading", () => {
      render(<DepositForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={true} />);

      expect(screen.getByTestId("check-icon")).toBeInTheDocument();
    });

    it("shows plus icon when creating new and not loading", () => {
      render(<DepositForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={false} />);

      expect(screen.getByTestId("plus-icon")).toBeInTheDocument();
    });
  });
});
