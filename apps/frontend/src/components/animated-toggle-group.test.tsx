import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnimatedToggleGroup } from "@wealthfolio/ui/components/ui/animated-toggle-group";

describe("AnimatedToggleGroup", () => {
  it("names an option by its aria-label when the visible label needs context", () => {
    const onValueChange = vi.fn();
    render(
      <AnimatedToggleGroup
        aria-label="Billing period"
        value="monthly"
        onValueChange={onValueChange}
        items={[
          { value: "monthly", label: "Monthly", "aria-label": "Monthly billing" },
          { value: "yearly", label: "Yearly", "aria-label": "Yearly billing" },
        ]}
      />,
    );
    expect(screen.getByRole("group", { name: "Billing period" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Monthly billing" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Yearly billing" }));
    expect(onValueChange).toHaveBeenCalledWith("yearly");
  });

  it("keeps one thumb that moves between options instead of handing it over", () => {
    // A thumb handed from button to button was measured while React was still
    // swapping the content the group controls, and Safari clamped the page's
    // scroll to that half-updated layout.
    const items = [
      { value: "holdings", label: "Holdings" },
      { value: "activities", label: "Activities" },
    ];
    const { container, rerender } = render(<AnimatedToggleGroup value="holdings" items={items} />);
    const thumb = container.querySelector('[data-slot="segmented-thumb"]');
    expect(thumb).not.toBeNull();

    rerender(<AnimatedToggleGroup value="activities" items={items} />);
    expect(container.querySelectorAll('[data-slot="segmented-thumb"]')).toHaveLength(1);
    expect(container.querySelector('[data-slot="segmented-thumb"]')).toBe(thumb);
  });

  describe("when the options overflow", () => {
    afterEach(() => vi.restoreAllMocks());

    // jsdom drops a gradient with calc() in it, so record the mask as it is set.
    let mask = "";
    beforeEach(() => {
      mask = "";
      vi.spyOn(CSSStyleDeclaration.prototype, "maskImage", "set").mockImplementation((value) => {
        mask = value;
      });
    });
    function fadedSides() {
      const stops = mask.replace(/^linear-gradient\(to right, |\)$/g, "").split(", ");
      return [stops[0] === "transparent" && "left", stops.at(-1) === "transparent" && "right"]
        .filter(Boolean)
        .join(" ");
    }

    // jsdom has no layout: give the group 500px of options in 350px.
    function overflowing() {
      vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(500);
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(350);
      const items = ["1D", "1W", "1M", "3M", "YTD", "1Y", "ALL"].map((value) => ({
        value,
        label: value,
      }));
      return items;
    }

    it("fades the side where options are hidden, and both sides mid-scroll", () => {
      const items = overflowing();
      render(<AnimatedToggleGroup aria-label="Period" value="1D" items={items} />);
      const group = screen.getByRole("group", { name: "Period" });
      expect(group).toHaveAttribute("data-hidden-sides", "right");
      expect(fadedSides()).toBe("right");

      group.scrollLeft = 75;
      fireEvent.scroll(group);
      expect(group).toHaveAttribute("data-hidden-sides", "left right");
      expect(fadedSides()).toBe("left right");
    });

    it("fades the left side first in right-to-left", () => {
      const items = overflowing();
      // jsdom does not inherit direction into computed style.
      const computed = window.getComputedStyle;
      vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
        const style = computed(element);
        return new Proxy(style, {
          get: (target, key) => (key === "direction" ? "rtl" : Reflect.get(target, key)),
        });
      });
      render(<AnimatedToggleGroup aria-label="Period" value="1D" items={items} />);
      const group = screen.getByRole("group", { name: "Period" });
      expect(group).toHaveAttribute("data-hidden-sides", "left");
      expect(fadedSides()).toBe("left");
    });

    it("does not fade options that fit", () => {
      render(
        <AnimatedToggleGroup aria-label="Period" value="a" items={[{ value: "a", label: "A" }]} />,
      );
      expect(screen.getByRole("group", { name: "Period" })).not.toHaveAttribute(
        "data-hidden-sides",
      );
      expect(fadedSides()).toBe("");
    });
  });

  it("marks its thumb for theme tokens", () => {
    const { container } = render(
      <AnimatedToggleGroup value="a" items={[{ value: "a", label: "A" }]} />,
    );
    expect(container.querySelector('[data-slot="segmented-thumb"]')).not.toBeNull();
  });
});
