import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";

import { FacetedFilter } from "@wealthfolio/ui";

// The popover's list measures itself and scrolls its active item into view;
// jsdom has neither.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
Element.prototype.scrollIntoView = vi.fn();

it("lists a search-only option only while searching, or once it is picked", async () => {
  const user = userEvent.setup();
  const onFilterChange = vi.fn();
  const options = [
    { value: "type:travel", label: "Travel events" },
    { value: "event:1", label: "Lisbon weekend", searchOnly: true },
    { value: "event:2", label: "Oslo conference", searchOnly: true },
  ];
  const { rerender } = render(
    <FacetedFilter
      title="Without"
      searchPlaceholder="Search payees and events"
      options={options}
      selectedValues={new Set()}
      onFilterChange={onFilterChange}
    />,
  );

  await user.click(screen.getByRole("button", { name: /Without/ }));
  expect(await screen.findByText("Travel events")).toBeInTheDocument();
  expect(screen.queryByText("Lisbon weekend")).not.toBeInTheDocument();

  await user.type(screen.getByPlaceholderText("Search payees and events"), "lisbon");
  expect(await screen.findByText("Lisbon weekend")).toBeInTheDocument();
  expect(screen.queryByText("Oslo conference")).not.toBeInTheDocument();

  await user.click(screen.getByText("Lisbon weekend"));
  expect(onFilterChange).toHaveBeenCalledWith(new Set(["event:1"]));

  // Once picked it stays listed with the search box empty, so it can be unticked.
  rerender(
    <FacetedFilter
      title="Without"
      searchPlaceholder="Search payees and events"
      options={options}
      selectedValues={new Set(["event:1"])}
      onFilterChange={onFilterChange}
    />,
  );
  await user.clear(screen.getByPlaceholderText("Search payees and events"));
  expect(screen.getAllByText("Lisbon weekend").length).toBeGreaterThan(0);
  expect(screen.queryByText("Oslo conference")).not.toBeInTheDocument();
});
