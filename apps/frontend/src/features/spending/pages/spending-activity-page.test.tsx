import { fireEvent, render, screen } from "@/test/render";
import { describe, expect, it, vi } from "vitest";

import SpendingActivityPage from "./spending-activity-page";

const navigation = vi.hoisted(() => ({ navigate: vi.fn(), goBack: vi.fn() }));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => navigation.navigate,
  useLocation: () => ({ state: null }),
  useSearchParams: () => [new URLSearchParams()],
}));
vi.mock("@/pages/layouts/mobile-stack/use-mobile-stack", () => ({
  useBackNavigation: () => navigation.goBack,
}));
vi.mock("@/hooks/use-platform", () => ({ useIsMobileViewport: () => false }));
vi.mock("../hooks/use-spending-settings", () => ({
  useSpendingSettings: () => ({ isEnabled: true, isLoading: false }),
}));
vi.mock("@/hooks/use-accounts", () => {
  const accounts = [
    { id: "card", name: "Visa", currency: "CAD", accountType: "CREDIT_CARD", isArchived: false },
  ];
  return { useAccounts: () => ({ accounts }) };
});
// The form hands over "Record payment" the way the real one does: the
// transfer first, then closing.
vi.mock("../components/cash-activity-form", () => ({
  CashActivityForm: (props: {
    onOpenChange: (open: boolean) => void;
    onTransferClick?: (accountId: string) => void;
  }) => (
    <button
      type="button"
      onClick={() => {
        props.onTransferClick?.("card");
        props.onOpenChange(false);
      }}
    >
      Record payment
    </button>
  ),
}));
vi.mock("@/pages/activity/components/activity-form", () => ({
  ActivityForm: ({ activity }: { activity: unknown }) => (
    <div data-testid="transfer-form">{JSON.stringify(activity)}</div>
  ),
}));

describe("SpendingActivityPage", () => {
  it("opens a card's payment from Add transaction without leaving the screen (#2740)", () => {
    render(<SpendingActivityPage />);
    fireEvent.click(screen.getByRole("button", { name: "Record payment" }));

    expect(JSON.parse(screen.getByTestId("transfer-form").textContent ?? "{}")).toEqual({
      activityType: "TRANSFER_IN",
      accountId: "card",
    });
    expect(navigation.navigate).not.toHaveBeenCalled();
    expect(navigation.goBack).not.toHaveBeenCalled();
  });
});
