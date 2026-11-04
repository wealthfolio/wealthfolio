import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ResponsiveSelect } from "@wealthfolio/ui/components/ui/responsive-select";
import { DatePickerInput } from "@wealthfolio/ui/components/ui/date-picker-input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@wealthfolio/ui/components/ui/sheet";
import { SheetNavigation } from "@wealthfolio/ui/components/ui/sheet-navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";

if (typeof ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => undefined;
}

const options = [
  { value: "checking", label: "Checking (USD)" },
  { value: "visa", label: "Visa (USD)" },
];

function renderForm(onOpenChange = vi.fn(), onValueChange = vi.fn()) {
  render(
    <Sheet open onOpenChange={onOpenChange}>
      <SheetContent side="bottom">
        <SheetNavigation>
          <SheetTitle>Add expense</SheetTitle>
          <input aria-label="Amount" defaultValue="18" />
          <ResponsiveSelect
            aria-label="Account"
            sheetTitle="Select an account"
            options={options}
            value="checking"
            onValueChange={onValueChange}
          />
        </SheetNavigation>
      </SheetContent>
    </Sheet>,
  );
  return { onOpenChange, onValueChange };
}

describe("SheetNavigation", () => {
  it("opens a picker as a screen of the same sheet and keeps the form underneath", async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole("combobox", { name: "Account" }));

    const pickerScreen = screen.getByRole("dialog", { name: "Select an account" });
    expect(pickerScreen.closest('[data-slot="sheet-content"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-slot="sheet-content"]')).toHaveLength(1);
    // The form stays mounted, so what was typed is kept, but can't be reached.
    const amount = screen.getByDisplayValue("18");
    expect(amount).toHaveAttribute("inert");
    expect(pickerScreen.closest("[inert]")).toBeNull();
  });

  it("goes back to the form on Escape without closing the sheet", async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderForm();
    const trigger = screen.getByRole("combobox", { name: "Account" });

    await user.click(trigger);
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Select an account" })).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("18").closest("[inert]")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("goes back with the back button, and a choice returns to the form with the value", async () => {
    const user = userEvent.setup();
    const { onValueChange } = renderForm();
    const trigger = screen.getByRole("combobox", { name: "Account" });

    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.queryByRole("dialog", { name: "Select an account" })).not.toBeInTheDocument();

    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Visa (USD)" }));
    expect(onValueChange).toHaveBeenCalledWith("visa");
    expect(screen.queryByRole("dialog", { name: "Select an account" })).not.toBeInTheDocument();
  });

  it("renders only its children when disabled, so pickers keep their own popups", () => {
    render(
      <SheetNavigation enabled={false}>
        <p>Form</p>
      </SheetNavigation>,
    );
    expect(screen.getByText("Form")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="sheet-navigation-layer"]')).toBeNull();
  });
});

describe("DatePickerInput in a phone form's sheet", () => {
  function renderDate(enableTime: boolean, onChange = vi.fn()) {
    render(
      <SheetNavigation>
        <DatePickerInput
          value={new Date(2026, 10, 4, 9, 30)}
          onChange={onChange}
          enableTime={enableTime}
        />
      </SheetNavigation>,
    );
    return onChange;
  }

  function day(label: string) {
    const calendar = screen.getByRole("dialog", { name: "Date" });
    const cell = within(calendar)
      .getAllByRole("button")
      .find((button) => button.textContent === label);
    if (!cell) throw new Error(`No day ${label}`);
    return cell;
  }

  it("opens a calendar screen and keeps the time when a day is picked", async () => {
    const user = userEvent.setup();
    const onChange = renderDate(true);
    // The date can still be typed, segment by segment.
    expect(screen.getAllByRole("spinbutton").length).toBeGreaterThanOrEqual(5);

    await user.click(screen.getByRole("button", { name: "Pick a date" }));
    await user.click(day("15"));

    expect(onChange).toHaveBeenLastCalledWith(new Date(2026, 10, 15, 9, 30));
    // With a time to set as well, the screen stays until Back.
    expect(screen.getByRole("dialog", { name: "Date" })).toBeInTheDocument();
    expect(screen.getByLabelText("Time")).toHaveValue("09:30");
  });

  it("returns to the form once a day is picked when there is no time", async () => {
    const user = userEvent.setup();
    const onChange = renderDate(false);

    await user.click(screen.getByRole("button", { name: "Pick a date" }));
    await user.click(day("15"));

    expect(onChange).toHaveBeenLastCalledWith(new Date(2026, 10, 15));
    expect(screen.queryByRole("dialog", { name: "Date" })).not.toBeInTheDocument();
  });
});

describe("floating SheetHeader", () => {
  it("tells its parent how much room to leave and clears it when removed", () => {
    const { unmount } = render(
      <div data-testid="parent">
        <SheetHeader floating>Add expense</SheetHeader>
      </div>,
    );
    const parent = screen.getByTestId("parent");
    expect(parent.style.getPropertyValue("--sheet-header-height")).toBe("0px");
    unmount();
    expect(parent.style.getPropertyValue("--sheet-header-height")).toBe("");
  });
});

describe("Select in a phone form's sheet", () => {
  it("lists its items on a screen named by the field's label", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const items = [
      { value: "MANUAL", label: "Manual" },
      { value: "MARKET", label: "Market" },
    ];
    render(
      <SheetNavigation>
        <label htmlFor="quote-mode">Quote mode</label>
        <Select items={items} value="MANUAL" onValueChange={onValueChange}>
          <SelectTrigger id="quote-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SheetNavigation>,
    );

    await user.click(screen.getByRole("combobox", { name: "Quote mode" }));
    // The Select opens its screen from its own open handler, a beat after the click.
    const quoteScreen = await screen.findByRole("dialog", { name: "Quote mode" });
    // The dropdown's own popup never opens.
    expect(document.querySelector('[data-slot="select-content"][data-open]')).toBeNull();

    await user.click(within(quoteScreen).getByRole("option", { name: "Market" }));
    expect(onValueChange).toHaveBeenCalledWith("MARKET");
    expect(screen.queryByRole("dialog", { name: "Quote mode" })).not.toBeInTheDocument();
  });
});
