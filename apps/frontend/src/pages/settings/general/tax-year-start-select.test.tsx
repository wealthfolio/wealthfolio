import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaxYearStartSelect } from "./tax-year-start-select";

describe("TaxYearStartSelect", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    Element.prototype.hasPointerCapture = vi.fn(() => false);
    Element.prototype.releasePointerCapture = vi.fn();
  });

  async function pick(user: ReturnType<typeof userEvent.setup>, select: string, option: string) {
    await user.click(screen.getByRole("combobox", { name: select }));
    await user.click(await screen.findByRole("option", { name: option }));
  }

  it("keeps a picked month while it saves when the day is picked next", async () => {
    const user = userEvent.setup();
    // The first save is still under way when the day is picked.
    const onChange = vi.fn(() => new Promise<void>(() => undefined));
    render(<TaxYearStartSelect value="01-01" timezone="UTC" onChange={onChange} />);

    await pick(user, "Month", "July");
    await pick(user, "Day", "6");

    expect(onChange.mock.calls).toEqual([["07-01"], ["07-06"]]);
  });

  it("shows the stored start again when its save fails", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn(() => Promise.reject(new Error("offline")));
    render(<TaxYearStartSelect value="01-01" timezone="UTC" onChange={onChange} />);

    await pick(user, "Month", "July");

    expect(await screen.findByRole("combobox", { name: "Month" })).toHaveTextContent("January");
  });
});
