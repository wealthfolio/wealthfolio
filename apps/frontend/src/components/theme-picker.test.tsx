import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ThemePicker } from "@/components/theme-picker";
import { themeSelectionUpdate } from "@/themes/selection";
import { themes } from "@/themes/themes";

// None of this batch's themes is designed for dark; Ember carries the flag here so
// the picker's moon and its description stay tested.
vi.mock("@/themes/themes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/themes/themes")>();
  return {
    ...actual,
    themes: actual.themes.map((theme) =>
      theme.id === "ember" ? { ...theme, mode: "dark" as const } : theme,
    ),
  };
});

describe("ThemePicker", () => {
  it("offers every theme, Classic first, and checks the saved one", () => {
    render(<ThemePicker value="ember" onChange={vi.fn()} />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((radio) => (radio as HTMLInputElement).value)).toEqual(
      themes.map(({ id }) => id),
    );
    expect(radios[0]).toHaveAccessibleName("Classic");
    expect(screen.getByRole("radio", { name: /Ember/ })).toBeChecked();
  });

  it("checks Classic for a missing or unknown theme", () => {
    const { rerender } = render(<ThemePicker onChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "Classic" })).toBeChecked();
    rerender(<ThemePicker value="from-a-newer-version" onChange={vi.fn()} />);
    expect(screen.getByRole("radio", { name: "Classic" })).toBeChecked();
  });

  it("reports the picked theme and describes the mode a theme is designed for", () => {
    const onChange = vi.fn();
    render(<ThemePicker value="classic" onChange={onChange} />);
    const ember = screen.getByRole("radio", { name: /Ember/ });
    expect(ember).toHaveAccessibleDescription("Ember is designed for dark mode.");
    fireEvent.click(ember);
    expect(onChange).toHaveBeenCalledWith("ember");
  });

  it("draws each miniature in its own theme", () => {
    const { container } = render(<ThemePicker value="classic" onChange={vi.fn()} />);
    expect(
      [...container.querySelectorAll("[data-theme-preview]")].map((preview) =>
        preview.getAttribute("data-theme-preview"),
      ),
    ).toEqual(themes.map(({ id }) => id));
  });

  it("draws each miniature in a font role, the theme's or the user's", () => {
    const { container } = render(
      <ThemePicker value="cupertino" font="font-serif" onChange={vi.fn()} />,
    );
    const fonts = Object.fromEntries(
      [...container.querySelectorAll("[data-theme-preview]")].map((preview) => [
        preview.getAttribute("data-theme-preview"),
        ["font-sans", "font-serif", "font-mono"].find((role) => preview.classList.contains(role)),
      ]),
    );
    expect(fonts).toEqual({
      classic: "font-mono",
      ember: "font-serif",
      signature: "font-sans",
      cupertino: "font-sans",
    });
  });
});

describe("themeSelectionUpdate", () => {
  it("saves the theme with the font it suggests, never the mode", () => {
    expect(themeSelectionUpdate("cupertino")).toEqual({
      themeId: "cupertino",
      font: "font-sans",
    });
    expect(themeSelectionUpdate("ember")).toEqual({ themeId: "ember" });
  });
});
