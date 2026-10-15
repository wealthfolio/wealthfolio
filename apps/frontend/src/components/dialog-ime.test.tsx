import { act, fireEvent, render, screen } from "@testing-library/react";
import { Dialog, DialogContent, DialogTitle } from "@wealthfolio/ui/components/ui/dialog";
import { describe, expect, it, vi } from "vitest";

const useDesktop = () => false;
const useMobile = () => true;

describe.each([
  { layout: "desktop", useIsMobile: useDesktop },
  { layout: "mobile", useIsMobile: useMobile },
])("Dialog $layout Escape handling", ({ useIsMobile }) => {
  it("ignores composition and preserves the caller's ordinary Escape veto", async () => {
    const onOpenChange = vi.fn(
      (_open: boolean, details: { reason: string; cancel: () => void }) => {
        if (details.reason === "escape-key") details.cancel();
      },
    );
    render(
      <Dialog defaultOpen onOpenChange={onOpenChange} useIsMobile={useIsMobile}>
        <DialogContent>
          <DialogTitle>Edit name</DialogTitle>
          <input aria-label="Name" defaultValue="候選" />
        </DialogContent>
      </Dialog>,
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    input.focus();
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });
    // Safari ends the composition before the keydown that confirms it.
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Escape", isComposing: false, keyCode: 229 });
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledOnce();
    expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(input).toHaveValue("候選");
  });
});
