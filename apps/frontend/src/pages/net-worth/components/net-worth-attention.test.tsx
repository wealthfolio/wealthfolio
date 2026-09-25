import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlternativeAssetHolding } from "@/lib/types";
import { NetWorthAttention } from "./net-worth-attention";

const mocks = vi.hoisted(() => ({
  holdings: vi.fn<() => AlternativeAssetHolding[]>(),
  link: vi.fn(),
  pending: false,
  error: false,
}));
vi.mock("@/hooks/use-alternative-assets", () => ({
  useAlternativeHoldings: () => ({ data: mocks.holdings(), isError: mocks.error }),
  useLinkLiability: () => ({ mutate: mocks.link, isPending: mocks.pending }),
}));
vi.mock("@wealthfolio/ui", () => ({
  ResponsiveSelect: ({
    options,
    onValueChange,
    disabled,
    placeholder,
  }: {
    options: { value: string; label: string }[];
    onValueChange: (value: string) => void;
    disabled: boolean;
    placeholder: string;
  }) => (
    <select
      aria-label={placeholder}
      disabled={disabled}
      defaultValue=""
      onChange={(event) => onValueChange(event.target.value)}
    >
      <option value="">{placeholder}</option>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
vi.mock("@/pages/asset/alternative-assets/components/alternative-asset-quick-add-modal", () => ({
  AlternativeAssetQuickAddModal: ({
    onAssetCreated,
    onOpenChange,
    defaultKind,
    allowKindChange,
  }: {
    onAssetCreated: (response: { assetId: string }) => void;
    onOpenChange: (open: boolean) => void;
    defaultKind: string;
    allowKindChange: boolean;
  }) => (
    <div role="dialog" aria-label="Create property">
      <span>{defaultKind}</span>
      <span>{String(allowKindChange)}</span>
      <button
        onClick={() => {
          onAssetCreated({ assetId: "new-property" });
          onOpenChange(false);
        }}
      >
        Save property
      </button>
      <button onClick={() => onOpenChange(false)}>Cancel</button>
    </div>
  ),
}));

const mortgage: AlternativeAssetHolding = {
  id: "mortgage",
  kind: "liability",
  name: "Home mortgage",
  symbol: "Mortgage",
  currency: "USD",
  marketValue: "500000",
  valuationDate: "2025-01-01",
  metadata: { sub_type: "mortgage" },
};
const property: AlternativeAssetHolding = {
  ...mortgage,
  id: "home",
  kind: "property",
  name: "Home",
  metadata: {},
};
const stale = [
  { assetId: "mortgage", name: "Home mortgage", valuationDate: "2025-01-01", daysStale: 200 },
];
const renderCard = (staleAssets = stale) =>
  render(
    <MemoryRouter>
      <NetWorthAttention staleAssets={staleAssets} />
    </MemoryRouter>,
  );

beforeEach(() => {
  mocks.holdings.mockReturnValue([mortgage, property]);
  mocks.pending = false;
  mocks.error = false;
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NetWorthAttention", () => {
  it("retains history links and distinguishes liability balances from asset values", () => {
    renderCard([...stale, { ...stale[0], assetId: "home", name: "Home" }]);
    expect(screen.getByRole("link", { name: /Update balance/ })).toHaveAttribute(
      "href",
      "/holdings/mortgage?tab=history",
    );
    expect(screen.getByRole("link", { name: /Update value/ })).toHaveAttribute(
      "href",
      "/holdings/home?tab=history",
    );
  });

  it("offers only properties and links the selected one without creating a duplicate", () => {
    mocks.holdings.mockReturnValue([
      mortgage,
      property,
      { ...property, id: "car", kind: "vehicle", name: "Car" },
    ]);
    renderCard([]);
    expect(screen.queryByRole("option", { name: "Car" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "home" } });
    expect(mocks.link).toHaveBeenCalledWith({ liabilityId: "mortgage", targetAssetId: "home" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers creation from the property picker without linking the action identifier", () => {
    renderCard([]);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "__add_property__" } });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mocks.link).not.toHaveBeenCalled();
  });

  it("creates a property before linking the existing mortgage", () => {
    mocks.holdings.mockReturnValue([mortgage]);
    renderCard([]);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add a property for Home mortgage" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("property");
    expect(screen.getByRole("dialog")).toHaveTextContent("false");
    expect(mocks.link).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Save property"));
    expect(mocks.link).toHaveBeenCalledWith({
      liabilityId: "mortgage",
      targetAssetId: "new-property",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not link anything when property creation is cancelled", () => {
    mocks.holdings.mockReturnValue([mortgage]);
    renderCard([]);
    fireEvent.click(screen.getByRole("button", { name: "Add a property for Home mortgage" }));
    fireEvent.click(screen.getByText("Cancel"));
    expect(mocks.link).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { sub_type: "" }])(
    "offers an action for legacy liabilities with metadata %j",
    (metadata) => {
      mocks.holdings.mockReturnValue([{ ...mortgage, metadata }]);
      renderCard([]);
      expect(
        screen.getByRole("button", { name: "Add a property for Home mortgage" }),
      ).toBeVisible();
    },
  );

  it("does not suggest linked mortgages or other kinds of debt", () => {
    mocks.holdings.mockReturnValue([
      { ...mortgage, linkedAssetId: "home" },
      { ...mortgage, id: "card", metadata: { sub_type: "credit_card" } },
    ]);
    renderCard([]);
    expect(screen.queryByRole("region")).not.toBeInTheDocument();
  });

  it("preserves reminders but suppresses link suggestions if holdings failed to load", () => {
    mocks.error = true;
    renderCard();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/holdings/mortgage?tab=history");
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add a property for Home mortgage" }),
    ).not.toBeInTheDocument();
  });

  it("disables link and create actions while linking", () => {
    mocks.pending = true;
    renderCard([]);
    expect(screen.getByRole("combobox")).toBeDisabled();
  });
});
