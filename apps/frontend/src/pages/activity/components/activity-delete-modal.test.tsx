import { render, screen } from "@/test/render";
import { describe, expect, it, vi } from "vitest";
import { ActivityDeleteModal } from "./activity-delete-modal";

describe("ActivityDeleteModal", () => {
  it("says a conversion's other side goes too", () => {
    render(<ActivityDeleteModal isOpen linkedTransfer conversion onConfirm={vi.fn()} />);

    expect(screen.getByText(/one side of a conversion/i)).toBeInTheDocument();
    expect(screen.queryByText(/transfer pair/i)).not.toBeInTheDocument();
  });

  it("keeps the transfer pair wording for a transfer", () => {
    render(<ActivityDeleteModal isOpen linkedTransfer onConfirm={vi.fn()} />);

    expect(screen.getByText(/linked to a transfer pair/i)).toBeInTheDocument();
  });
});
