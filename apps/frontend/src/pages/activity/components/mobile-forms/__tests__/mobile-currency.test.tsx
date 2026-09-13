import { ActivityType } from "@/lib/constants";
import { render, screen, waitFor } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import type { AccountSelectOption } from "../../forms/fields";
import type { NewActivityFormValues } from "../../forms/schemas";
import { MobileDetailsStep } from "../mobile-details-step";

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "CAD" } }),
}));

const accounts: AccountSelectOption[] = [
  { value: "cad-account", label: "CAD account", currency: "CAD" },
];

function TestForm({
  currency,
  options = accounts,
  onSubmit = vi.fn(),
}: {
  currency: string;
  options?: AccountSelectOption[];
  onSubmit?: (values: NewActivityFormValues) => void;
}) {
  const form = useForm<NewActivityFormValues>({
    defaultValues: {
      activityType: ActivityType.DEPOSIT,
      accountId: "cad-account",
      activityDate: new Date("2026-09-01T12:00:00Z"),
      amount: 100,
      currency,
    },
  });
  const amountWasEdited = useRef(false);
  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <MobileDetailsStep
          accounts={options}
          activityType={ActivityType.DEPOSIT}
          isEditing
          amountWasEdited={amountWasEdited}
        />
        <output data-testid="currency">{form.watch("currency")}</output>
        <button type="submit">Save test activity</button>
      </form>
    </FormProvider>
  );
}

describe("mobile activity currency backfill", () => {
  it("preserves a stored activity currency when saving without edits", async () => {
    const onSubmit = vi.fn();
    render(<TestForm currency="USD" onSubmit={onSubmit} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Save test activity" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].currency).toBe("USD");
  });

  it("preserves the stored currency when account options arrive later", async () => {
    const { rerender } = render(<TestForm currency="USD" options={[]} />);
    rerender(<TestForm currency="USD" />);
    await waitFor(() => expect(screen.getByTestId("currency")).toHaveTextContent("USD"));
  });

  it("still fills an empty currency when account options arrive later", async () => {
    const { rerender } = render(<TestForm currency="" options={[]} />);
    rerender(<TestForm currency="" />);
    await waitFor(() => expect(screen.getByTestId("currency")).toHaveTextContent("CAD"));
  });
});
