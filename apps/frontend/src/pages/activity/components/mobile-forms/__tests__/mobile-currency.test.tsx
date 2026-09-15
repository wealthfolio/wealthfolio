import { ActivityType } from "@/lib/constants";
import { render, screen, waitFor } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountSelectOption } from "../../forms/fields";
import type { NewActivityFormValues } from "../../forms/schemas";
import { MobileDetailsStep } from "../mobile-details-step";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { baseActivitySchema } from "../../forms/schemas";
import { useActivityMutations } from "../../../hooks/use-activity-mutations";

const updateActivity = vi.hoisted(() => vi.fn());
vi.mock("@/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/adapters")>()),
  updateActivity,
}));

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "CAD" } }),
}));

const accounts: AccountSelectOption[] = [
  { value: "cad-account", label: "CAD account", currency: "CAD" },
  { value: "other-account", label: "Other CAD account", currency: "CAD" },
];

function TestForm({
  currency,
  options = accounts,
  onSubmit = vi.fn(),
  isEditing = true,
  fxRate,
}: {
  currency: string;
  options?: AccountSelectOption[];
  onSubmit?: (values: NewActivityFormValues) => void;
  isEditing?: boolean;
  fxRate?: number;
}) {
  const form = useForm<NewActivityFormValues>({
    resolver: zodResolver(baseActivitySchema.passthrough()) as never,
    defaultValues: {
      activityType: ActivityType.DEPOSIT,
      accountId: "cad-account",
      activityDate: new Date("2026-09-01T12:00:00Z"),
      amount: 100,
      currency,
      fxRate,
    },
  });
  const amountWasEdited = useRef(false);
  return (
    <FormProvider {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        <MobileDetailsStep
          accounts={options}
          activityType={ActivityType.DEPOSIT}
          isEditing={isEditing}
          amountWasEdited={amountWasEdited}
        />
        <output data-testid="currency">{form.watch("currency")}</output>
        <button type="submit">Save test activity</button>
      </form>
    </FormProvider>
  );
}

function TestEdit({ options }: { options: AccountSelectOption[] }) {
  const { updateActivityMutation } = useActivityMutations();
  return (
    <TestForm
      currency="USD"
      fxRate={1.2}
      options={options}
      onSubmit={(values) => {
        void updateActivityMutation.mutateAsync({ ...values, id: "synthetic-mobile" });
      }}
    />
  );
}

describe("mobile activity currency backfill", () => {
  it.each(["CAD", "EUR"])("submits the correct FX patch for an account in %s", async (currency) => {
    updateActivity.mockReset().mockResolvedValue({ id: "synthetic-mobile" });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <TestEdit options={[accounts[0], { ...accounts[1], currency }]} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox", { name: "Account" }));
    await user.click(screen.getByRole("button", { name: /Other CAD account/ }));
    await user.click(screen.getByRole("button", { name: "Save test activity" }));
    await waitFor(() => expect(updateActivity).toHaveBeenCalled());
    expect(JSON.parse(JSON.stringify(updateActivity.mock.calls[0][0]))).toMatchObject({
      currency: "USD",
      fxRate: currency === "CAD" ? "1.2" : null,
    });
  });
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  it.each([true, false])(
    "handles an explicit account change with isEditing=%s",
    async (isEditing) => {
      const onSubmit = vi.fn();
      render(<TestForm currency="USD" isEditing={isEditing} onSubmit={onSubmit} />);
      const user = userEvent.setup();
      await user.click(screen.getByRole("combobox", { name: "Account" }));
      await user.click(screen.getByRole("button", { name: /Other CAD account/ }));
      await user.click(screen.getByRole("button", { name: "Save test activity" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalled());
      expect(onSubmit.mock.calls[0][0].accountId).toBe("other-account");
      expect(onSubmit.mock.calls[0][0].currency).toBe(isEditing ? "USD" : "CAD");
    },
  );
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
