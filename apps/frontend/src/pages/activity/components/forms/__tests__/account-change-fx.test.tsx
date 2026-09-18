import { ActivityType } from "@/lib/constants";
import { render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useActivityForm } from "../../../hooks/use-activity-form";
import { DepositForm } from "../deposit-form";
import { FeeForm } from "../fee-form";
import { TaxForm } from "../tax-form";

const adapter = vi.hoisted(() => ({
  updateActivity: vi.fn(),
  deleteActivity: vi.fn(),
  logger: { error: vi.fn() },
}));
vi.mock("@/adapters", () => adapter);
vi.mock("@/hooks/use-settings", () => ({ useSettings: () => ({ data: { baseCurrency: "USD" } }) }));
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));

function EditDeposit({
  destinationCurrency,
  type,
  storedRate = "1.2",
}: {
  destinationCurrency: string;
  type: "DEPOSIT" | "FEE" | "TAX";
  storedRate?: string;
}) {
  const accounts = [
    { value: "old", label: "Original account", currency: "USD" },
    { value: "new", label: "Destination account", currency: destinationCurrency },
  ];
  const form = useActivityForm({
    accounts,
    selectedType: type,
    activity: {
      id: "synthetic-activity",
      accountId: "old",
      activityType: ActivityType[type],
      date: new Date("2026-09-01T12:00:00Z"),
      currency: "EUR",
      amount: "100",
      fxRate: storedRate,
    },
  });
  const Component = type === "FEE" ? FeeForm : type === "TAX" ? TaxForm : DepositForm;
  return (
    <Component
      accounts={accounts}
      isEditing
      defaultValues={form.defaultValues as never}
      onSubmit={form.handleSubmit}
    />
  );
}

describe("account currency change through validated desktop submission", () => {
  const originalScroll = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  beforeAll(() =>
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    }),
  );
  afterAll(() => {
    if (originalScroll) Object.defineProperty(Element.prototype, "scrollIntoView", originalScroll);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });
  beforeEach(() => {
    vi.clearAllMocks();
    adapter.updateActivity.mockResolvedValue({ id: "synthetic-activity" });
  });
  describe.each(["DEPOSIT", "FEE", "TAX"] as const)("%s", (type) => {
    it.each(["USD", "CAD", "EUR"])(
      "serializes FX correctly for %s destination",
      async (currency) => {
        render(
          <QueryClientProvider client={new QueryClient()}>
            <EditDeposit type={type} destinationCurrency={currency} />
          </QueryClientProvider>,
        );
        const user = userEvent.setup();
        await user.click(screen.getByTestId("advanced-options-button"));
        screen.getByRole("combobox", { name: "Account" }).focus();
        await user.keyboard("[ArrowDown]");
        await user.keyboard("[End][Enter]");
        await user.click(screen.getByRole("button", { name: /update/i }));
        await waitFor(() => expect(adapter.updateActivity).toHaveBeenCalledTimes(1));
        const payload = JSON.parse(JSON.stringify(adapter.updateActivity.mock.calls[0][0]));
        expect(payload).toMatchObject({
          accountId: "new",
          currency: "EUR",
        });
        if (currency === "USD" && type !== "DEPOSIT") {
          expect(payload).not.toHaveProperty("fxRate");
        } else {
          expect(payload.fxRate).toBe(currency === "USD" ? "1.2" : null);
        }
      },
    );
  });
  describe.each(["FEE", "TAX"] as const)("hidden FX in %s", (type) => {
    it.each(["0", "1.234567890123456789"])(
      "leaves the stored %s rate untouched",
      async (storedRate) => {
        render(
          <QueryClientProvider client={new QueryClient()}>
            <EditDeposit type={type} destinationCurrency="USD" storedRate={storedRate} />
          </QueryClientProvider>,
        );
        const user = userEvent.setup();
        await user.click(screen.getByTestId("advanced-options-button"));
        screen.getByRole("combobox", { name: "Account" }).focus();
        await user.keyboard("[ArrowDown][End][Enter]");
        await user.click(screen.getByRole("button", { name: /update/i }));
        await waitFor(() => expect(adapter.updateActivity).toHaveBeenCalledTimes(1));
        expect(
          JSON.parse(JSON.stringify(adapter.updateActivity.mock.calls[0][0])),
        ).not.toHaveProperty("fxRate");
      },
    );
  });
});
