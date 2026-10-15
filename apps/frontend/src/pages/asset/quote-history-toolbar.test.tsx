import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import { QuoteHistoryToolbar } from "./quote-history-toolbar";

function renderToolbar(onChangeDataSource = vi.fn()) {
  render(
    <MemoryRouter>
      <QuoteHistoryToolbar
        selectedRowCount={0}
        hasUnsavedChanges={false}
        dirtyCount={0}
        deletedCount={0}
        isManualDataSource={false}
        onAddRow={vi.fn()}
        onDeleteSelected={vi.fn()}
        onSave={vi.fn()}
        onCancel={vi.fn()}
        onChangeDataSource={onChangeDataSource}
      />
    </MemoryRouter>,
  );
  return onChangeDataSource;
}

describe("QuoteHistoryToolbar manual tracking", () => {
  it("is one switch that asks before changing the mode", async () => {
    const user = userEvent.setup();
    const onChangeDataSource = renderToolbar();
    const manual = screen.getByRole("switch", { name: "Manual" });
    expect(screen.queryByRole("button", { name: "Manual" })).not.toBeInTheDocument();

    manual.focus();
    await user.keyboard(" ");
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onChangeDataSource).not.toHaveBeenCalled();
    expect(manual).toHaveAttribute("aria-checked", "false");

    await user.click(screen.getByText("Manual"));
    await user.click(await screen.findByRole("button", { name: "Confirm Change" }));
    expect(onChangeDataSource).toHaveBeenCalledExactlyOnceWith(true);
  });
});
