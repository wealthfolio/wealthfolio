import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PatCreateDialog } from "./pat-create-dialog";

vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: vi.fn() }));

function scopeCheckbox(label: string) {
  // Buttons expose `aria-label = "<label>: <description>"`; match on the label.
  return screen.getByRole("checkbox", { name: new RegExp(`^${label}`) });
}

describe("PatCreateDialog scope dependencies", () => {
  it("derives draft from write and clears it when write is unchecked", () => {
    render(
      <PatCreateDialog
        open
        onOpenChange={vi.fn()}
        onCreate={vi.fn().mockResolvedValue("wfp_secret")}
        isCreating={false}
      />,
    );

    const write = scopeCheckbox("Activities — commit/write");
    const draft = scopeCheckbox("Activities — draft");

    // Default selection is read-only, so draft starts off.
    expect(draft).toHaveAttribute("aria-checked", "false");

    // Selecting write implies draft (derived) and locks it on.
    fireEvent.click(write);
    expect(write).toHaveAttribute("aria-checked", "true");
    expect(draft).toHaveAttribute("aria-checked", "true");
    expect(draft).toBeDisabled();

    // Unchecking write must clear the implied draft — not leave it stuck on.
    fireEvent.click(write);
    expect(write).toHaveAttribute("aria-checked", "false");
    expect(draft).toHaveAttribute("aria-checked", "false");
    expect(draft).not.toBeDisabled();
  });

  it("keeps an explicitly chosen draft selected after write is toggled off", () => {
    render(
      <PatCreateDialog
        open
        onOpenChange={vi.fn()}
        onCreate={vi.fn().mockResolvedValue("wfp_secret")}
        isCreating={false}
      />,
    );

    const write = scopeCheckbox("Activities — commit/write");
    const draft = scopeCheckbox("Activities — draft");

    // User explicitly picks draft first.
    fireEvent.click(draft);
    expect(draft).toHaveAttribute("aria-checked", "true");

    // Then write (which also implies draft), then unchecks write.
    fireEvent.click(write);
    fireEvent.click(write);

    // The user's explicit draft choice is preserved.
    expect(write).toHaveAttribute("aria-checked", "false");
    expect(draft).toHaveAttribute("aria-checked", "true");
  });

  it("derives classification suggest from classification write", () => {
    render(
      <PatCreateDialog
        open
        onOpenChange={vi.fn()}
        onCreate={vi.fn().mockResolvedValue("wfp_secret")}
        isCreating={false}
      />,
    );

    const write = scopeCheckbox("Asset classification — apply/write");
    const suggest = scopeCheckbox("Asset classification — suggest");

    expect(suggest).toHaveAttribute("aria-checked", "false");

    fireEvent.click(write);
    expect(write).toHaveAttribute("aria-checked", "true");
    expect(suggest).toHaveAttribute("aria-checked", "true");
    expect(suggest).toBeDisabled();

    fireEvent.click(write);
    expect(write).toHaveAttribute("aria-checked", "false");
    expect(suggest).toHaveAttribute("aria-checked", "false");
    expect(suggest).not.toBeDisabled();
  });

  it.each(["Organize spending", "Manage budgets"])(
    "derives spending read for %s without granting the other write",
    (label) => {
      render(<PatCreateDialog open onOpenChange={vi.fn()} onCreate={vi.fn()} isCreating={false} />);
      const read = scopeCheckbox("View spending");
      fireEvent.click(read);
      expect(read).toHaveAttribute("aria-checked", "false");
      const write = scopeCheckbox(label);
      fireEvent.click(write);
      expect(read).toBeDisabled();
      expect(read).toHaveAttribute("aria-checked", "true");
      expect(
        scopeCheckbox(label === "Organize spending" ? "Manage budgets" : "Organize spending"),
      ).toHaveAttribute("aria-checked", "false");
      fireEvent.click(write);
      expect(read).not.toBeDisabled();
      expect(read).toHaveAttribute("aria-checked", "false");
    },
  );

  it("derives holdings read from market data write", () => {
    render(
      <PatCreateDialog
        open
        onOpenChange={vi.fn()}
        onCreate={vi.fn().mockResolvedValue("wfp_secret")}
        isCreating={false}
      />,
    );

    const write = scopeCheckbox("Market data — write");
    const holdings = scopeCheckbox("Holdings & value \\(read\\)");

    // Holdings read is on by default; drop it to see it derived.
    fireEvent.click(holdings);
    expect(holdings).toHaveAttribute("aria-checked", "false");

    fireEvent.click(write);
    expect(write).toHaveAttribute("aria-checked", "true");
    expect(holdings).toHaveAttribute("aria-checked", "true");
    expect(holdings).toBeDisabled();
    expect(holdings).toHaveAttribute("title", "Required by Market data — write");

    fireEvent.click(write);
    expect(holdings).toHaveAttribute("aria-checked", "false");
    expect(holdings).not.toBeDisabled();
  });
});

describe("PatCreateDialog client config", () => {
  it("shows the Claude Code command for the new token, and Codex TOML on request", async () => {
    render(
      <PatCreateDialog
        open
        onOpenChange={vi.fn()}
        onCreate={vi.fn().mockResolvedValue("wfp_secret")}
        isCreating={false}
        serverUrl="http://127.0.0.1:4321/mcp"
      />,
    );

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Claude" } });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    expect(
      await screen.findByText(
        'claude mcp add --scope user --transport http wealthfolio http://127.0.0.1:4321/mcp --header "Authorization: Bearer wfp_secret"',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Codex / ChatGPT" }));
    expect(screen.getByText(/\[mcp_servers\.wealthfolio\]/)).toHaveTextContent(
      'http_headers = { Authorization = "Bearer wfp_secret" }',
    );
  });
});
