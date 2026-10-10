import { fireEvent, render, screen, waitFor } from "@/test/render";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { FxExchangeForm, fxExchangeFormSchema } from "../fx-exchange-form";
import { newActivitySchema } from "../schemas";

const accounts = [{ value: "a", label: "Account A", currency: "CAD" }];
const values = {
  accountId: "a",
  activityDate: new Date("2025-01-02T12:00:00Z"),
  amount: 100,
  currency: "USD",
  destinationAmount: 92.12345678,
  destinationCurrency: "EUR",
};
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

describe("FX exchange", () => {
  it.each([
    { amount: 0 },
    { amount: -1 },
    { destinationAmount: 0 },
    { destinationAmount: -1 },
    { destinationCurrency: "USD" },
    { destinationCurrency: "" },
  ])("rejects invalid economics %j in desktop and mobile schemas", (patch) => {
    expect(fxExchangeFormSchema.safeParse({ ...values, ...patch }).success).toBe(false);
    expect(
      newActivitySchema.safeParse({ ...values, activityType: "FX_EXCHANGE", ...patch }).success,
    ).toBe(false);
  });
  it("preserves stored currencies and full amount precision through late account loading and a notes-only edit", async () => {
    const onSubmit = vi.fn();
    const { container, rerender } = render(
      <FxExchangeForm accounts={[]} defaultValues={values} onSubmit={onSubmit} isEditing />,
    );
    rerender(
      <FxExchangeForm accounts={accounts} defaultValues={values} onSubmit={onSubmit} isEditing />,
    );
    expect(screen.getByTestId("fx-execution-rate")).toHaveTextContent("0.92123457");
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject(values);
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty("fxRate");
  });
  it("rejects an execution-rate override on mobile", () => {
    expect(
      newActivitySchema.safeParse({ ...values, activityType: "FX_EXCHANGE", fxRate: 0.92 }).success,
    ).toBe(false);
  });
});
