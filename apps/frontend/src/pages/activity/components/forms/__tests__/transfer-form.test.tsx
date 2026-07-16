import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TransferForm } from "../transfer-form";
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
  SymbolSearch: ({ name }: { name: string }) => (
    <input data-testid={`symbol-search-${name}`} name={name} />
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

// Mock AnimatedToggleGroup
vi.mock("@wealthfolio/ui/components/ui/animated-toggle-group", () => ({
  AnimatedToggleGroup: ({
    items,
    value,
    onValueChange,
  }: {
    items: { value: string; label: string }[];
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <div data-testid="transfer-mode-toggle">
      {items.map((item) => (
        <button
          key={item.value}
          data-testid={`toggle-${item.value}`}
          onClick={() => onValueChange(item.value)}
          data-active={value === item.value}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

// Mock Checkbox
vi.mock("@wealthfolio/ui/components/ui/checkbox", () => ({
  Checkbox: ({
    id,
    checked,
    onCheckedChange,
  }: {
    id: string;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      id={id}
      data-testid={`checkbox-${id}`}
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}));

// Mock RadioGroup
vi.mock("@wealthfolio/ui/components/ui/radio-group", () => ({
  RadioGroup: ({
    value,
    children,
    className,
  }: {
    value: string;
    onValueChange?: (value: string) => void;
    children: React.ReactNode;
    className?: string;
  }) => (
    <div data-testid="radio-group" data-value={value} className={className}>
      {children}
    </div>
  ),
  RadioGroupItem: ({ value, id }: { value: string; id: string }) => (
    <input type="radio" value={value} id={id} data-testid={`radio-${id}`} name="direction" />
  ),
}));

// Mock Label
vi.mock("@wealthfolio/ui/components/ui/label", () => ({
  Label: ({
    htmlFor,
    children,
    className,
  }: {
    htmlFor: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <label htmlFor={htmlFor} className={className}>
      {children}
    </label>
  ),
}));

const mockAccounts: AccountSelectOption[] = [
  { value: "acc-1", label: "Savings Account", currency: "USD" },
  { value: "acc-2", label: "Investment Account", currency: "EUR" },
  { value: "acc-3", label: "Retirement Account", currency: "USD" },
];

describe("TransferForm", () => {
  const mockOnSubmit = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Render Tests", () => {
    it("renders transfer mode toggle", () => {
      render(<TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("transfer-mode-toggle")).toBeInTheDocument();
      expect(screen.getByTestId("toggle-cash")).toBeInTheDocument();
      expect(screen.getByTestId("toggle-securities")).toBeInTheDocument();
    });

    it("renders cash mode fields by default", () => {
      render(<TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("select-fromAccountId")).toBeInTheDocument();
      expect(screen.getByTestId("select-toAccountId")).toBeInTheDocument();
      expect(screen.getByTestId("date-picker-activityDate")).toBeInTheDocument();
      expect(screen.getByTestId("input-amount")).toBeInTheDocument();
      expect(screen.getByTestId("textarea-comment")).toBeInTheDocument();
      // Symbol and quantity should not be visible in cash mode
      expect(screen.queryByTestId("symbol-search-assetId")).not.toBeInTheDocument();
      expect(screen.queryByTestId("input-quantity")).not.toBeInTheDocument();
    });

    it("renders securities mode fields when toggled", async () => {
      const user = userEvent.setup();
      render(<TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      await user.click(screen.getByTestId("toggle-securities"));

      expect(screen.getByTestId("symbol-search-assetId")).toBeInTheDocument();
      expect(screen.getByTestId("input-quantity")).toBeInTheDocument();
      // Amount should not be visible in securities mode
      expect(screen.queryByTestId("input-amount")).not.toBeInTheDocument();
    });

    it("renders from and to account labels", () => {
      render(<TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByText("From Account")).toBeInTheDocument();
      expect(screen.getByText("To Account")).toBeInTheDocument();
    });

    it("renders submit button with correct text for new transfer", () => {
      render(<TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByRole("button", { name: /add transfer/i })).toBeInTheDocument();
    });

    it("renders submit button with correct text when editing", () => {
      render(<TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={true} />);

      expect(screen.getByRole("button", { name: /update/i })).toBeInTheDocument();
    });

    it("renders cancel button when onCancel is provided", () => {
      render(
        <TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />,
      );

      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    it("does not render cancel button when onCancel is not provided", () => {
      render(<TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
    });

    it("shows loading spinner when isLoading is true", () => {
      render(<TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} isLoading={true} />);

      expect(screen.getByTestId("spinner")).toBeInTheDocument();
    });

    it("disables submit button when isLoading is true", () => {
      render(<TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} isLoading={true} />);

      const submitButton = screen.getByRole("button", { name: /add transfer/i });
      expect(submitButton).toBeDisabled();
    });
  });

  describe("Cancel Button", () => {
    it("calls onCancel when cancel button is clicked", async () => {
      const user = userEvent.setup();
      render(
        <TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />,
      );

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await user.click(cancelButton);

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });

    it("disables cancel button when isLoading is true", () => {
      render(
        <TransferForm
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
      render(<TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getAllByTestId("form-section").length).toBeGreaterThan(0);
    });

    it("renders form with proper structure", () => {
      const { container } = render(
        <TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} />,
      );

      const form = container.querySelector("form");
      expect(form).toBeInTheDocument();
    });
  });

  describe("Transfer Mode Toggle", () => {
    it("defaults to cash mode", () => {
      render(<TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("toggle-cash")).toHaveAttribute("data-active", "true");
      expect(screen.getByTestId("toggle-securities")).toHaveAttribute("data-active", "false");
    });

    it("initializes to securities mode when defaultValues has assetId", () => {
      render(
        <TransferForm
          accounts={mockAccounts}
          onSubmit={mockOnSubmit}
          defaultValues={{ assetId: "AAPL" }}
        />,
      );

      expect(screen.getByTestId("toggle-cash")).toHaveAttribute("data-active", "false");
      expect(screen.getByTestId("toggle-securities")).toHaveAttribute("data-active", "true");
    });

    it("initializes to cash mode for generated cash asset ids", () => {
      render(
        <TransferForm
          accounts={mockAccounts}
          onSubmit={mockOnSubmit}
          defaultValues={{ assetId: "CASH:USD" }}
        />,
      );

      expect(screen.getByTestId("toggle-cash")).toHaveAttribute("data-active", "true");
      expect(screen.getByTestId("toggle-securities")).toHaveAttribute("data-active", "false");
    });
  });

  describe("Loading State", () => {
    it("shows check icon when editing and not loading", () => {
      render(<TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={true} />);

      expect(screen.getByTestId("check-icon")).toBeInTheDocument();
    });

    it("shows plus icon when creating new and not loading", () => {
      render(<TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={false} />);

      expect(screen.getByTestId("plus-icon")).toBeInTheDocument();
    });
  });

  describe("External Transfer", () => {
    it("renders external transfer checkbox", () => {
      render(<TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("checkbox-isExternal")).toBeInTheDocument();
      expect(screen.getByText("External transfer")).toBeInTheDocument();
    });

    it("shows direction selector when external is checked", async () => {
      const user = userEvent.setup();
      render(<TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      await user.click(screen.getByTestId("checkbox-isExternal"));

      expect(screen.getByTestId("radio-group")).toBeInTheDocument();
      expect(screen.getByText("In")).toBeInTheDocument();
      expect(screen.getByText("Out")).toBeInTheDocument();
    });

    it("shows single account selector for external transfers", async () => {
      const user = userEvent.setup();
      render(<TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      await user.click(screen.getByTestId("checkbox-isExternal"));

      // Should show accountId selector, not fromAccountId/toAccountId
      expect(screen.getByTestId("select-accountId")).toBeInTheDocument();
      expect(screen.queryByTestId("select-fromAccountId")).not.toBeInTheDocument();
      expect(screen.queryByTestId("select-toAccountId")).not.toBeInTheDocument();
    });

    it("shows from/to account selectors for internal transfers", () => {
      render(<TransferForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("select-fromAccountId")).toBeInTheDocument();
      expect(screen.getByTestId("select-toAccountId")).toBeInTheDocument();
      expect(screen.queryByTestId("select-accountId")).not.toBeInTheDocument();
    });

    it("initializes to external mode when defaultValues has isExternal", () => {
      render(
        <TransferForm
          accounts={mockAccounts}
          onSubmit={mockOnSubmit}
          defaultValues={{ isExternal: true, direction: "in" }}
        />,
      );

      expect(screen.getByTestId("checkbox-isExternal")).toBeChecked();
      expect(screen.getByTestId("select-accountId")).toBeInTheDocument();
    });
  });
});
