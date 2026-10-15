import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadSidebar } from "./thread-sidebar";

const originalWidth = window.innerWidth;
afterEach(() => {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
});

// Safari ends the composition before the keydown that confirms it.
const cases = [
  { label: "modern", eventInit: { isComposing: true }, endsBeforeKeyDown: false },
  {
    label: "legacy WebKit",
    eventInit: { isComposing: false, keyCode: 229 },
    endsBeforeKeyDown: true,
  },
];

async function openRename(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  const onRenameThread = vi.fn();
  render(
    <ThreadSidebar
      threads={[
        {
          id: "thread-1",
          title: "Original title",
          isPinned: false,
          tags: [],
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ]}
      activeThreadId="thread-1"
      onSelectThread={vi.fn()}
      onNewThread={vi.fn()}
      onRenameThread={onRenameThread}
      onDeleteThread={vi.fn()}
      onTogglePin={vi.fn()}
      onAddTag={vi.fn()}
      onRemoveTag={vi.fn()}
    />,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Thread options" }));
  await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const dialog = await screen.findByRole("dialog", { name: "Rename conversation" });
  const input = within(dialog).getByRole("textbox");
  input.focus();
  fireEvent.change(input, { target: { value: "候選標題" } });
  return { input, onRenameThread };
}

describe.each([
  { layout: "desktop", width: 1024 },
  { layout: "mobile", width: 390 },
])("ThreadSidebar $layout IME handling", ({ width }) => {
  it.each(cases)(
    "preserves the rename draft on $label composing Escape",
    async ({ eventInit, endsBeforeKeyDown }) => {
      const { input, onRenameThread } = await openRename(width);
      fireEvent.compositionStart(input);
      if (endsBeforeKeyDown) fireEvent.compositionEnd(input);
      fireEvent.keyDown(input, { key: "Escape", ...eventInit });
      expect(screen.getByRole("dialog", { name: "Rename conversation" })).toBeInTheDocument();
      expect(input).toHaveValue("候選標題");
      expect(onRenameThread).not.toHaveBeenCalled();

      if (!endsBeforeKeyDown) fireEvent.compositionEnd(input);
      // The dialog treats Escape as composing until the tick after compositionend.
      await new Promise((resolve) => setTimeout(resolve, 10));
      fireEvent.keyDown(input, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(onRenameThread).not.toHaveBeenCalled();
    },
  );

  it.each(cases)("saves only after $label composition is committed", async ({ eventInit }) => {
    const { input, onRenameThread } = await openRename(width);
    fireEvent.keyDown(input, { key: "Enter", ...eventInit });
    expect(onRenameThread).not.toHaveBeenCalled();
    expect(input).toHaveValue("候選標題");
    expect(screen.getByRole("dialog", { name: "Rename conversation" })).toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRenameThread).toHaveBeenCalledExactlyOnceWith("thread-1", "候選標題");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
