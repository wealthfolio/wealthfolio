import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WithdrawalForm } from "../withdrawal-form";
import { FeeForm } from "../fee-form";
import { InterestForm } from "../interest-form";
import { TaxForm } from "../tax-form";
import type { AccountSelectOption } from "../fields";

// Mock useSettings hook to avoid AuthProvider dependency
vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    data: { baseCurrency: "USD" },
    isLoading: false,
    error: null,
  }),
}));

// Mock the fields components with actual form integration
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
  SymbolSearch: ({ name, label }: { name: string; label: string }) => (
    <div data-testid={`symbol-search-${name}`}>{label}</div>
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
    MinusCircle: () => <span data-testid="minus-icon">Minus</span>,
    ChevronDown: () => <span data-testid="chevron-down-icon" />,
    Circle: () => <span data-testid="circle-icon" />,
  },
}));

vi.mock("@wealthfolio/ui/components/ui/animated-toggle-group", () => ({
  AnimatedToggleGroup: ({
    items,
    value,
    onValueChange,
  }: {
    items: { value: string; label: string }[];
    value?: string;
    onValueChange?: (value: string) => void;
  }) => (
    <div data-testid="animated-toggle-group">
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={value === item.value}
          onClick={() => onValueChange?.(item.value)}
        >
          {item.label}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@wealthfolio/ui/components/ui/radio-group", () => ({
  RadioGroup: ({ children }: { children: React.ReactNode }) => (
    <div role="radiogroup">{children}</div>
  ),
  RadioGroupItem: ({ value, id }: { value: string; id: string }) => (
    <input type="radio" value={value} id={id} readOnly />
  ),
}));

const mockAccounts: AccountSelectOption[] = [
  { value: "acc-1", label: "Savings Account", currency: "USD" },
  { value: "acc-2", label: "Investment Account", currency: "EUR" },
];

describe("WithdrawalForm", () => {
  const mockOnSubmit = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Render Tests", () => {
    it("renders all form fields", () => {
      render(<WithdrawalForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("select-accountId")).toBeInTheDocument();
      expect(screen.getByTestId("date-picker-activityDate")).toBeInTheDocument();
      expect(screen.getByTestId("input-amount")).toBeInTheDocument();
      expect(screen.getByTestId("textarea-comment")).toBeInTheDocument();
    });

    it("renders submit button with correct text for new withdrawal", () => {
      render(<WithdrawalForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByRole("button", { name: /add withdrawal/i })).toBeInTheDocument();
    });

    it("renders submit button with correct text when editing", () => {
      render(<WithdrawalForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={true} />);

      expect(screen.getByRole("button", { name: /update/i })).toBeInTheDocument();
    });

    it("renders cancel button when onCancel is provided", () => {
      render(
        <WithdrawalForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />,
      );

      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    it("shows loading state when isLoading is true", () => {
      render(<WithdrawalForm accounts={mockAccounts} onSubmit={mockOnSubmit} isLoading={true} />);

      expect(screen.getByTestId("spinner")).toBeInTheDocument();
    });
  });

  describe("Cancel Button", () => {
    it("calls onCancel when clicked", async () => {
      const user = userEvent.setup();
      render(
        <WithdrawalForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />,
      );

      await user.click(screen.getByRole("button", { name: /cancel/i }));
      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });
  });
});

describe("FeeForm", () => {
  const mockOnSubmit = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Render Tests", () => {
    it("renders all form fields", () => {
      render(<FeeForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("select-accountId")).toBeInTheDocument();
      expect(screen.getByTestId("date-picker-activityDate")).toBeInTheDocument();
      expect(screen.getByTestId("input-amount")).toBeInTheDocument();
      expect(screen.getByTestId("textarea-comment")).toBeInTheDocument();
    });

    it("renders submit button with correct text for new fee", () => {
      render(<FeeForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByRole("button", { name: /add fee/i })).toBeInTheDocument();
    });

    it("renders submit button with correct text when editing", () => {
      render(<FeeForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={true} />);

      expect(screen.getByRole("button", { name: /update/i })).toBeInTheDocument();
    });

    it("renders cancel button when onCancel is provided", () => {
      render(<FeeForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    it("shows loading state when isLoading is true", () => {
      render(<FeeForm accounts={mockAccounts} onSubmit={mockOnSubmit} isLoading={true} />);

      expect(screen.getByTestId("spinner")).toBeInTheDocument();
    });
  });
});

describe("InterestForm", () => {
  const mockOnSubmit = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Render Tests", () => {
    it("renders all form fields", () => {
      render(<InterestForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("select-accountId")).toBeInTheDocument();
      expect(screen.getByTestId("date-picker-activityDate")).toBeInTheDocument();
      expect(screen.getByTestId("input-amount")).toBeInTheDocument();
      expect(screen.getByTestId("input-tax")).toBeInTheDocument();
      expect(screen.getByTestId("textarea-comment")).toBeInTheDocument();
    });

    it("renders submit button with correct text for new interest", () => {
      render(<InterestForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByRole("button", { name: /add interest/i })).toBeInTheDocument();
    });

    it("renders submit button with correct text when editing", () => {
      render(<InterestForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={true} />);

      expect(screen.getByRole("button", { name: /update/i })).toBeInTheDocument();
    });

    it("renders cancel button when onCancel is provided", () => {
      render(
        <InterestForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />,
      );

      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });
  });
});

describe("TaxForm", () => {
  const mockOnSubmit = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Render Tests", () => {
    it("renders all form fields", () => {
      render(<TaxForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("select-accountId")).toBeInTheDocument();
      expect(screen.getByTestId("date-picker-activityDate")).toBeInTheDocument();
      expect(screen.getByTestId("input-amount")).toBeInTheDocument();
      expect(screen.getByTestId("textarea-comment")).toBeInTheDocument();
    });

    it("renders submit button with correct text for new tax", () => {
      render(<TaxForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByRole("button", { name: /add tax/i })).toBeInTheDocument();
    });

    it("renders submit button with correct text when editing", () => {
      render(<TaxForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={true} />);

      expect(screen.getByRole("button", { name: /update/i })).toBeInTheDocument();
    });

    it("renders cancel button when onCancel is provided", () => {
      render(<TaxForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    it("shows loading state when isLoading is true", () => {
      render(<TaxForm accounts={mockAccounts} onSubmit={mockOnSubmit} isLoading={true} />);

      expect(screen.getByTestId("spinner")).toBeInTheDocument();
    });
  });
});
