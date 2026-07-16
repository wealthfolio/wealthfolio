import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PatCreateDialog } from "./pat-create-dialog";

vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: vi.fn() }));

function scopeCheckbox(label: string) {
  // Buttons expose `aria-label = "<label>: <description>"`; match on the label.
  return screen.getByRole("checkbox", { name: new RegExp(`^${label}`) });
}

describe("PatCreateDialog scope dependencies", () => {
  it("derives draft from write and clears it when write is unchecked", () => {
    render(
      <PatCreateDialog
        open
        onOpenChange={vi.fn()}
        onCreate={vi.fn().mockResolvedValue("wfp_secret")}
        isCreating={false}
      />,
    );

    const write = scopeCheckbox("Activities — commit/write");
    const draft = scopeCheckbox("Activities — draft");

    // Default selection is read-only, so draft starts off.
    expect(draft).toHaveAttribute("aria-checked", "false");

    // Selecting write implies draft (derived) and locks it on.
    fireEvent.click(write);
    expect(write).toHaveAttribute("aria-checked", "true");
    expect(draft).toHaveAttribute("aria-checked", "true");
    expect(draft).toBeDisabled();

    // Unchecking write must clear the implied draft — not leave it stuck on.
    fireEvent.click(write);
    expect(write).toHaveAttribute("aria-checked", "false");
    expect(draft).toHaveAttribute("aria-checked", "false");
    expect(draft).not.toBeDisabled();
  });

  it("keeps an explicitly chosen draft selected after write is toggled off", () => {
    render(
      <PatCreateDialog
        open
        onOpenChange={vi.fn()}
        onCreate={vi.fn().mockResolvedValue("wfp_secret")}
        isCreating={false}
      />,
    );

    const write = scopeCheckbox("Activities — commit/write");
    const draft = scopeCheckbox("Activities — draft");

    // User explicitly picks draft first.
    fireEvent.click(draft);
    expect(draft).toHaveAttribute("aria-checked", "true");

    // Then write (which also implies draft), then unchecks write.
    fireEvent.click(write);
    fireEvent.click(write);

    // The user's explicit draft choice is preserved.
    expect(write).toHaveAttribute("aria-checked", "false");
    expect(draft).toHaveAttribute("aria-checked", "true");
  });

  it("derives classification suggest from classification write", () => {
    render(
      <PatCreateDialog
        open
        onOpenChange={vi.fn()}
        onCreate={vi.fn().mockResolvedValue("wfp_secret")}
        isCreating={false}
      />,
    );

    const write = scopeCheckbox("Classification — apply/write");
    const suggest = scopeCheckbox("Classification — suggest");

    expect(suggest).toHaveAttribute("aria-checked", "false");

    fireEvent.click(write);
    expect(write).toHaveAttribute("aria-checked", "true");
    expect(suggest).toHaveAttribute("aria-checked", "true");
    expect(suggest).toBeDisabled();

    fireEvent.click(write);
    expect(write).toHaveAttribute("aria-checked", "false");
    expect(suggest).toHaveAttribute("aria-checked", "false");
    expect(suggest).not.toBeDisabled();
  });
});
