import { render, screen, within } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { DirectionProvider } from "@wealthfolio/ui/components/ui/direction";
import { expect, it, vi } from "vitest";

import { IconPicker } from "./icon-picker";

vi.mock("@tanstack/react-virtual", () => ({
  defaultRangeExtractor: () => [],
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 36,
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 8) }, (_, index) => ({
        key: index,
        index,
        start: index * 36,
      })),
    scrollToIndex: vi.fn(),
  }),
}));

it("keeps legacy selections until a Lucide icon is selected", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<IconPicker value="Home" onChange={onChange} />);

  await user.click(screen.getByRole("button", { name: "Home" }));
  expect(onChange).not.toHaveBeenCalled();
  const search = screen.getByPlaceholderText("Search icons...");
  await user.type(search, "shopping cart");
  const choice = await screen.findByRole("button", { name: "shopping cart" });
  expect(choice).toHaveAttribute("aria-pressed", "false");
  await user.click(choice);
  expect(onChange).toHaveBeenCalledWith("lucide:shopping-cart");
});

it("highlights and clears an existing Lucide choice", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<IconPicker value="lucide:house" onChange={onChange} />);

  await user.click(screen.getByRole("button", { name: "house" }));
  await user.type(screen.getByPlaceholderText("Search icons..."), "house");
  const dialog = screen.getByRole("dialog");
  const choice = within(dialog).getByRole("button", { name: "house" });
  expect(choice).toHaveAttribute("aria-pressed", "true");
  await user.click(choice);
  expect(onChange).toHaveBeenCalledWith(null);
});

it("shows the empty state and clears a legacy selection", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<IconPicker value="Home" onChange={onChange} />);
  await user.click(screen.getByRole("button", { name: "Home" }));
  await user.type(screen.getByPlaceholderText("Search icons..."), "no-such-icon-xyz");
  expect(screen.getByText(/No icons match/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Clear icon" }));
  expect(onChange).toHaveBeenCalledWith(null);
});

it("finds both preferred and remaining icons", async () => {
  const user = userEvent.setup();
  render(<IconPicker value={null} onChange={vi.fn()} />);
  await user.click(screen.getByRole("button", { name: "Choose an icon" }));
  const search = screen.getByPlaceholderText("Search icons...");
  await user.type(search, "wallet");
  expect(screen.getByRole("button", { name: /^wallet$/ })).toBeInTheDocument();
  await user.clear(search);
  await user.type(search, "a arrow down");
  expect(screen.getByRole("button", { name: "a arrow down" })).toBeInTheDocument();
});

it("moves keyboard focus without changing the selected icon", async () => {
  const user = userEvent.setup();
  const onChange = vi.fn();
  render(<IconPicker value="lucide:banknote" onChange={onChange} />);
  await user.click(screen.getByRole("button", { name: "banknote" }));
  await user.tab();
  const dialog = within(screen.getByRole("dialog"));
  const wallet = dialog.getByRole("button", { name: "wallet" });
  const banknote = dialog.getByRole("button", { name: "banknote" });
  expect(wallet).toHaveFocus();
  expect(wallet).toHaveAttribute("aria-pressed", "false");
  expect(banknote).toHaveAttribute("aria-pressed", "true");
  await user.keyboard("{ArrowRight}");
  expect(banknote).toHaveFocus();
  expect(onChange).not.toHaveBeenCalled();
  await user.keyboard("{Enter}");
  expect(onChange).toHaveBeenCalledWith(null);
});

it("navigates horizontally in RTL", async () => {
  const user = userEvent.setup();
  render(
    <DirectionProvider direction="rtl">
      <IconPicker value={null} onChange={vi.fn()} />
    </DirectionProvider>,
  );
  await user.click(screen.getByRole("button", { name: "Choose an icon" }));
  const first = await screen.findByRole("button", { name: "wallet" });
  first.focus();
  await user.keyboard("{ArrowLeft}");
  expect(screen.getByRole("button", { name: "banknote" })).toHaveFocus();
});
