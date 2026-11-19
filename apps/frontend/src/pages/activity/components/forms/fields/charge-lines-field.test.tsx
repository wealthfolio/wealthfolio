import type { ChargeLineFormValues } from "@/lib/activity-charges";
import { TooltipProvider } from "@wealthfolio/ui";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FormProvider, useForm } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import { ChargeLinesField } from "./charge-lines-field";

type Values = ChargeLineFormValues & { fee?: number };

function Harness({
  defaultValues,
  onTotalChange,
}: {
  defaultValues: Values;
  onTotalChange?: () => void;
}) {
  const form = useForm<Values>({ defaultValues });
  return (
    <TooltipProvider>
      <FormProvider {...form}>
        <ChargeLinesField
          totalName="fee"
          linesName="feeLines"
          category="fee"
          label="Fee"
          currency="USD"
          onTotalChange={onTotalChange}
        />
        <output data-testid="values">{JSON.stringify(form.watch())}</output>
      </FormProvider>
    </TooltipProvider>
  );
}

const total = () => screen.getByTestId("fee-input") as HTMLInputElement;
const values = () => JSON.parse(screen.getByTestId("values").textContent ?? "{}") as Values;

describe("ChargeLinesField", () => {
  it("breaks a total down into lines that then set it", async () => {
    const onTotalChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness defaultValues={{ fee: 10 }} onTotalChange={onTotalChange} />);

    await user.click(screen.getByRole("button", { name: "Break down" }));
    expect(screen.getByRole("textbox", { name: "Line label" })).toHaveFocus();
    // The first line starts with the whole total, which can no longer be typed over.
    expect(screen.getAllByRole("textbox", { name: "Line amount" })[0]).toHaveValue("10");
    expect(total()).toHaveAttribute("readonly");

    await user.type(screen.getByRole("textbox", { name: "Line label" }), "Commission");
    const firstAmount = screen.getAllByRole("textbox", { name: "Line amount" })[0];
    await user.clear(firstAmount);
    await user.type(firstAmount, "0.1");
    await user.click(screen.getByRole("button", { name: "Add line" }));
    await user.type(screen.getAllByRole("textbox", { name: "Line label" })[1], "Exchange fee");
    await user.type(screen.getAllByRole("textbox", { name: "Line amount" })[1], "0.2");

    // Added exactly: 0.1 + 0.2 as floats would be 0.30000000000000004.
    await waitFor(() => expect(total()).toHaveValue("0.3"));
    expect(values()).toMatchObject({
      fee: 0.3,
      feeLines: [
        { label: "Commission", amount: 0.1 },
        { label: "Exchange fee", amount: 0.2 },
      ],
    });
    expect(onTotalChange).toHaveBeenCalled();
  });

  it("hands the total back once the last line is removed", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        defaultValues={{
          fee: 9.99,
          feeLines: [
            { label: "Commission", amount: 8 },
            { label: "Exchange fee", amount: 1.99 },
          ],
          hadChargeLines: true,
        }}
      />,
    );

    await user.click(screen.getAllByRole("button", { name: "Remove line" })[1]);
    await waitFor(() => expect(total()).toHaveValue("8"));
    expect(total()).toHaveAttribute("readonly");

    await user.click(screen.getByRole("button", { name: "Remove line" }));
    expect(total()).not.toHaveAttribute("readonly");
    expect(values()).toMatchObject({ fee: 8, feeLines: [] });
    expect(screen.getByRole("button", { name: "Break down" })).toBeInTheDocument();
  });

  it("offers no breakdown when the stored lines can't be edited here", () => {
    render(<Harness defaultValues={{ fee: 4, chargeLinesLocked: true }} />);

    expect(screen.queryByRole("button", { name: "Break down" })).not.toBeInTheDocument();
    expect(total()).not.toHaveAttribute("readonly");
  });

  it("preserves stored sub-cent lines and their total on opening", async () => {
    render(
      <Harness
        defaultValues={{
          fee: 0.01,
          feeLines: [
            { label: "a", amount: 0.005 },
            { label: "b", amount: 0.005 },
          ],
        }}
      />,
    );
    await waitFor(() => {
      expect(screen.getAllByRole("textbox", { name: "Line amount" })[0]).toHaveValue("0.005");
      expect(values().feeLines?.map((line) => line.amount)).toEqual([0.005, 0.005]);
      expect(values().fee).toBe(0.01);
    });
  });

  it("keeps a sub-cent total unchanged when its last line is removed", async () => {
    render(<Harness defaultValues={{ fee: 0.005, feeLines: [{ label: "a", amount: 0.005 }] }} />);
    await userEvent.click(screen.getByRole("button", { name: "Remove line" }));
    await waitFor(() => expect(total()).toHaveValue("0.005"));
    expect(total()).not.toHaveAttribute("readonly");
    expect(values().fee).toBe(0.005);
  });
});
