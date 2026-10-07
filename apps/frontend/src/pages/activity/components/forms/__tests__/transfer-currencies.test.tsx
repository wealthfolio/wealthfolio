import { fireEvent, render, screen, waitFor } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TransferForm } from "../transfer-form";

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ data: { baseCurrency: "USD" } }),
}));

const accounts = [
  { value: "a", label: "Account A", currency: "USD" },
  { value: "b", label: "Account B", currency: "USD" },
];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

describe("internal transfer currencies (real form)", () => {
  it("offers both cash currencies in advanced options", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const { container } = render(
      <TransferForm
        accounts={accounts}
        onSubmit={onSubmit}
        defaultValues={{ fromAccountId: "a", toAccountId: "b" }}
      />,
    );
    await user.click(screen.getByText(/Advanced.*Notes/i));
    expect(screen.getByRole("combobox", { name: "Source currency" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Destination currency" })).toBeInTheDocument();
    for (const name of ["Source currency", "Destination currency"]) {
      await user.click(screen.getByRole("combobox", { name }));
      await user.type(screen.getByPlaceholderText("Search currency..."), "HKD");
      await user.click(screen.getByRole("option", { name: /HKD/ }));
    }
    fireEvent.change(screen.getByTestId("input-amount"), { target: { value: "1000" } });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      sourceCurrency: "HKD",
      destinationCurrency: "HKD",
      sourceAmount: 1000,
      destinationAmount: 1000,
    });
  });

  it.each([
    [780, 100],
    [1_000_000_000, 1],
  ])(
    "preserves stored amounts %s → %s and currencies through late account loading",
    async (sourceAmount, destinationAmount) => {
      const onSubmit = vi.fn();
      const { container, rerender } = render(
        <TransferForm
          accounts={[]}
          isEditing
          onSubmit={onSubmit}
          defaultValues={{
            fromAccountId: "a",
            toAccountId: "b",
            currency: "HKD",
            sourceCurrency: "HKD",
            destinationCurrency: "USD",
            sourceAmount,
            destinationAmount,
          }}
        />,
      );
      rerender(<TransferForm accounts={accounts} isEditing onSubmit={onSubmit} />);
      fireEvent.submit(container.querySelector("form")!);
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit.mock.calls[0][0]).toMatchObject({
        sourceCurrency: "HKD",
        destinationCurrency: "USD",
        sourceAmount,
        destinationAmount,
      });
    },
  );

  it("keeps cash amounts exact when the sent amount changes", async () => {
    const onSubmit = vi.fn();
    const { container } = render(
      <TransferForm
        accounts={accounts}
        isEditing
        onSubmit={onSubmit}
        defaultValues={{
          fromAccountId: "a",
          toAccountId: "b",
          currency: "HKD",
          sourceCurrency: "HKD",
          destinationCurrency: "USD",
          sourceAmount: 78_000_000,
          destinationAmount: 10_000_000,
        }}
      />,
    );
    fireEvent.change(screen.getByTestId("sent-amount-input"), {
      target: { value: "156000000" },
    });
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      sourceAmount: 156_000_000,
      destinationAmount: 20_000_000,
    });
  });
});
