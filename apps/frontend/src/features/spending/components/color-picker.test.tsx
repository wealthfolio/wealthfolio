import { fireEvent, render, screen } from "@testing-library/react";
import { Activity } from "react";
import { expect, it, vi } from "vitest";
import { ColorPicker } from "./color-picker";

it("keeps a hex being typed when its phone screen is shown again", async () => {
  // A phone screen kept under another one is a hidden <Activity>, whose
  // effects run again when it is shown.
  const onChange = vi.fn();
  const view = (hidden: boolean) => (
    <Activity mode={hidden ? "hidden" : "visible"}>
      <ColorPicker value="#ef4444" onChange={onChange} />
    </Activity>
  );
  const { rerender } = render(view(false));
  fireEvent.click(screen.getByRole("button", { name: "Pick a custom color" }));
  const hex = await screen.findByPlaceholderText("#888888");
  fireEvent.change(hex, { target: { value: "#12ab" } });

  rerender(view(true));
  rerender(view(false));

  expect(screen.getByPlaceholderText("#888888")).toHaveValue("#12ab");
  expect(onChange).not.toHaveBeenCalled();
});
