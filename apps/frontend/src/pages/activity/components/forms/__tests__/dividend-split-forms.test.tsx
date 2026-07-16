import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DividendForm } from "../dividend-form";
import { SplitForm } from "../split-form";
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
  QuantityInput: ({
    name,
    label,
    placeholder,
  }: {
    name: string;
    label: string;
    placeholder?: string;
  }) => (
    <div>
      <label htmlFor={name}>{label}</label>
      <input
        data-testid={`input-${name}`}
        name={name}
        type="number"
        id={name}
        placeholder={placeholder}
      />
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
    ChevronDown: () => <span data-testid="chevron-down-icon" />,
    Circle: () => <span data-testid="circle-icon" />,
  },
}));

vi.mock("@wealthfolio/ui/components/ui/radio-group", () => ({
  RadioGroup: ({ children }: { children: React.ReactNode }) => (
    <div role="radiogroup">{children}</div>
  ),
  RadioGroupItem: ({ value, id }: { value: string; id: string }) => (
    <input type="radio" value={value} id={id} readOnly />
  ),
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

const mockAccounts: AccountSelectOption[] = [
  { value: "acc-1", label: "Savings Account", currency: "USD" },
  { value: "acc-2", label: "Investment Account", currency: "EUR" },
];

describe("DividendForm", () => {
  const mockOnSubmit = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Render Tests", () => {
    it("renders all form fields", () => {
      render(<DividendForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("select-accountId")).toBeInTheDocument();
      expect(screen.getByTestId("symbol-search-symbol")).toBeInTheDocument();
      expect(screen.getByTestId("date-picker-activityDate")).toBeInTheDocument();
      expect(screen.getByTestId("input-amount")).toBeInTheDocument();
      expect(screen.getByTestId("textarea-comment")).toBeInTheDocument();
    });

    it("renders submit button with correct text for new dividend", () => {
      render(<DividendForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByRole("button", { name: /add dividend/i })).toBeInTheDocument();
    });

    it("renders submit button with correct text when editing", () => {
      render(<DividendForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={true} />);

      expect(screen.getByRole("button", { name: /update/i })).toBeInTheDocument();
    });

    it("renders cancel button when onCancel is provided", () => {
      render(
        <DividendForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />,
      );

      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    it("shows loading spinner when isLoading is true", () => {
      render(<DividendForm accounts={mockAccounts} onSubmit={mockOnSubmit} isLoading={true} />);

      expect(screen.getByTestId("spinner")).toBeInTheDocument();
    });

    it("disables submit button when isLoading is true", () => {
      render(<DividendForm accounts={mockAccounts} onSubmit={mockOnSubmit} isLoading={true} />);

      const submitButton = screen.getByRole("button", { name: /add dividend/i });
      expect(submitButton).toBeDisabled();
    });
  });

  describe("Cancel Button", () => {
    it("calls onCancel when cancel button is clicked", async () => {
      const user = userEvent.setup();
      render(
        <DividendForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />,
      );

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await user.click(cancelButton);

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe("Form Structure", () => {
    it("wraps content in a Card component", () => {
      render(<DividendForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getAllByTestId("form-section").length).toBeGreaterThan(0);
    });

    it("renders form with proper structure", () => {
      const { container } = render(
        <DividendForm accounts={mockAccounts} onSubmit={mockOnSubmit} />,
      );

      const form = container.querySelector("form");
      expect(form).toBeInTheDocument();
    });
  });

  describe("Loading State", () => {
    it("shows check icon when editing and not loading", () => {
      render(<DividendForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={true} />);

      expect(screen.getByTestId("check-icon")).toBeInTheDocument();
    });

    it("shows plus icon when creating new and not loading", () => {
      render(<DividendForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={false} />);

      expect(screen.getByTestId("plus-icon")).toBeInTheDocument();
    });
  });
});

describe("SplitForm", () => {
  const mockOnSubmit = vi.fn();
  const mockOnCancel = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Render Tests", () => {
    it("renders all form fields", () => {
      render(<SplitForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByTestId("select-accountId")).toBeInTheDocument();
      expect(screen.getByTestId("symbol-search-symbol")).toBeInTheDocument();
      expect(screen.getByTestId("date-picker-activityDate")).toBeInTheDocument();
      expect(screen.getByTestId("input-splitRatio")).toBeInTheDocument();
      expect(screen.getByTestId("textarea-comment")).toBeInTheDocument();
    });

    it("renders submit button with correct text for new split", () => {
      render(<SplitForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getByRole("button", { name: /add split/i })).toBeInTheDocument();
    });

    it("renders submit button with correct text when editing", () => {
      render(<SplitForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={true} />);

      expect(screen.getByRole("button", { name: /update/i })).toBeInTheDocument();
    });

    it("renders cancel button when onCancel is provided", () => {
      render(<SplitForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    it("shows loading spinner when isLoading is true", () => {
      render(<SplitForm accounts={mockAccounts} onSubmit={mockOnSubmit} isLoading={true} />);

      expect(screen.getByTestId("spinner")).toBeInTheDocument();
    });

    it("disables submit button when isLoading is true", () => {
      render(<SplitForm accounts={mockAccounts} onSubmit={mockOnSubmit} isLoading={true} />);

      const submitButton = screen.getByRole("button", { name: /add split/i });
      expect(submitButton).toBeDisabled();
    });
  });

  describe("Cancel Button", () => {
    it("calls onCancel when cancel button is clicked", async () => {
      const user = userEvent.setup();
      render(<SplitForm accounts={mockAccounts} onSubmit={mockOnSubmit} onCancel={mockOnCancel} />);

      const cancelButton = screen.getByRole("button", { name: /cancel/i });
      await user.click(cancelButton);

      expect(mockOnCancel).toHaveBeenCalledTimes(1);
    });
  });

  describe("Form Structure", () => {
    it("wraps content in a Card component", () => {
      render(<SplitForm accounts={mockAccounts} onSubmit={mockOnSubmit} />);

      expect(screen.getAllByTestId("form-section").length).toBeGreaterThan(0);
    });
  });

  describe("Loading State", () => {
    it("shows check icon when editing and not loading", () => {
      render(<SplitForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={true} />);

      expect(screen.getByTestId("check-icon")).toBeInTheDocument();
    });

    it("shows plus icon when creating new and not loading", () => {
      render(<SplitForm accounts={mockAccounts} onSubmit={mockOnSubmit} isEditing={false} />);

      expect(screen.getByTestId("plus-icon")).toBeInTheDocument();
    });
  });
});
