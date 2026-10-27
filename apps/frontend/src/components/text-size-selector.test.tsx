import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { setSystemTextScale } from "@/themes/text-size";
import { TextSizeSelector } from "./text-size-selector";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

afterEach(() => setSystemTextScale(undefined));

const pressed = (name: string) =>
  screen.getByRole("button", { name: `settings:appearance_text_size_${name}` });

it("follows a new system font scale until a size is picked", () => {
  const { rerender } = render(<TextSizeSelector onChange={vi.fn()} />);
  expect(pressed("default")).toHaveAttribute("aria-pressed", "true");

  // iOS re-measured Dynamic Type on returning to the foreground.
  act(() => setSystemTextScale(21 / 17));
  expect(pressed("extra_large")).toHaveAttribute("aria-pressed", "true");

  // A picked size wins over the system's.
  rerender(<TextSizeSelector value="small" onChange={vi.fn()} />);
  act(() => setSystemTextScale(19 / 17));
  expect(pressed("small")).toHaveAttribute("aria-pressed", "true");
});
