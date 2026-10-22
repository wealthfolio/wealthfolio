import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button } from "@wealthfolio/ui/components/ui/button";
import { Input } from "@wealthfolio/ui/components/ui/input";
import { CardTitle } from "@wealthfolio/ui/components/ui/card";
import { Switch } from "@wealthfolio/ui/components/ui/switch";

// Themes restyle components only through the tokens these classes read
// (src/themes/definitions/classic.css); theme rules sit in @layer base. So a call
// site's own class must replace the token class, and then no theme can override it.
describe("a call site's classes replace the theme's component tokens", () => {
  it("keeps the addon store's white Details button white in every theme", () => {
    render(
      <Button variant="secondary" size="sm" className="bg-white/90 text-black hover:bg-white">
        Details
      </Button>,
    );
    const classes = screen.getByRole("button", { name: "Details" }).className.split(" ");
    expect(classes).toEqual(
      expect.arrayContaining(["bg-white/90", "text-black", "hover:bg-white"]),
    );
    expect(classes).not.toContain("bg-(--button-secondary-bg)");
    expect(classes).not.toContain("hover:bg-(--button-secondary-hover-bg)");
    expect(classes).not.toContain("text-secondary-foreground");
  });

  it("keeps a field's own border colour", () => {
    render(<Input aria-label="Amount" className="border-destructive shadow-none" />);
    const classes = screen.getByRole("textbox", { name: "Amount" }).className.split(" ");
    expect(classes).toEqual(expect.arrayContaining(["border-destructive", "shadow-none"]));
    expect(classes).not.toContain("border-(color:--field-border)");
    expect(classes).not.toContain("shadow-(--field-shadow)");
  });

  it("keeps a card title's own size and tracking", () => {
    render(<CardTitle className="text-sm tracking-normal">Holdings</CardTitle>);
    const classes = screen.getByText("Holdings").className.split(" ");
    expect(classes).toEqual(expect.arrayContaining(["text-sm", "tracking-normal"]));
    expect(classes).not.toContain("text-(length:--card-title-size)");
    expect(classes).not.toContain("tracking-(--card-title-tracking)");
  });

  it("keeps a switch's own track colour and size", () => {
    render(<Switch aria-label="Sync" className="data-checked:bg-success h-5" />);
    const classes = screen.getByRole("switch", { name: "Sync" }).className.split(" ");
    expect(classes).toEqual(expect.arrayContaining(["data-checked:bg-success", "h-5"]));
    expect(classes).not.toContain("data-checked:bg-(--switch-on)");
    expect(classes).not.toContain("h-(--switch-height)");
  });
});
