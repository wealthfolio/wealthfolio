import { render, screen } from "@/test/render";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { PeriodNavigation } from "./period-navigation";

it("announces the updated period while focus can stay on an arrow", () => {
  const navigation = {
    label: "Past 6 months",
    previousDisabled: false,
    nextDisabled: true,
    onStep: vi.fn(),
  };
  const { rerender } = render(<PeriodNavigation navigation={navigation} />);
  expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
  rerender(
    <PeriodNavigation navigation={{ ...navigation, label: "Sep 15, 2025 – Mar 15, 2026" }} />,
  );
  expect(screen.getByRole("status")).toHaveTextContent("Sep 15, 2025 – Mar 15, 2026");
});

it("exposes header navigation for the current preset and keeps Next disabled", async () => {
  const onStep = vi.fn();
  render(
    <PeriodNavigation
      navigation={{ label: "Past 6 months", previousDisabled: false, nextDisabled: true, onStep }}
    />,
  );
  expect(screen.getByRole("group", { name: "Past 6 months" })).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "Previous period" }));
  expect(onStep).toHaveBeenCalledWith(-1);
  expect(screen.getByRole("button", { name: "Next period" })).toBeDisabled();
});

it("allows returning to a newer historical window and mirrors the arrow icons in RTL", async () => {
  const onStep = vi.fn();
  render(
    <PeriodNavigation
      navigation={{ label: "2024", previousDisabled: true, nextDisabled: false, onStep }}
    />,
  );
  expect(screen.getByRole("button", { name: "Previous period" })).toBeDisabled();
  const next = screen.getByRole("button", { name: "Next period" });
  expect(next.querySelector("svg")).toHaveClass("rtl:rotate-180");
  await userEvent.setup().click(next);
  expect(onStep).toHaveBeenCalledWith(1);
});
