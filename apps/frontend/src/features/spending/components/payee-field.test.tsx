import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import type { TaxonomyCategory } from "@/lib/types";
import { render, screen } from "@/test/render";

import { PayeeCommand } from "./payee-field";

// The list measures itself and scrolls its active item into view; jsdom has neither.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
Element.prototype.scrollIntoView = vi.fn();

const payee = (id: string, name: string) => ({ id, name }) as TaxonomyCategory;
const payees = [payee("p2", "City Water"), payee("p1", "Corner Bakery")];
const search = () => screen.getByPlaceholderText("Search or add a payee");

it("offers to add a name no payee has, and picks it as typed", async () => {
  const user = userEvent.setup();
  const onPick = vi.fn();
  render(<PayeeCommand value="" payees={payees} onPick={onPick} />);

  await user.type(search(), "New Dentist");
  await user.click(await screen.findByText('Add "New Dentist"'));

  expect(onPick).toHaveBeenCalledWith("New Dentist");
});

it("does not offer to add a name a payee already has, whatever its case", async () => {
  const user = userEvent.setup();
  render(<PayeeCommand value="" payees={payees} onPick={vi.fn()} />);

  await user.type(search(), "corner bakery");

  expect(await screen.findByText("Corner Bakery")).toBeInTheDocument();
  expect(screen.queryByText(/^Add "/)).not.toBeInTheDocument();
});

it("offers to clear the payee only when one is set", async () => {
  const user = userEvent.setup();
  const onPick = vi.fn();
  const { rerender } = render(<PayeeCommand value="" payees={payees} onPick={onPick} />);
  expect(screen.queryByText("No payee")).not.toBeInTheDocument();

  rerender(<PayeeCommand value="City Water" payees={payees} onPick={onPick} />);
  await user.click(screen.getByText("No payee"));

  expect(onPick).toHaveBeenCalledWith("");
});

it("offers to clear with no payee set when asked to, for a selection of several", async () => {
  const user = userEvent.setup();
  const onPick = vi.fn();
  render(<PayeeCommand value="" clearable payees={payees} onPick={onPick} />);

  await user.click(screen.getByText("No payee"));

  expect(onPick).toHaveBeenCalledWith("");
});
