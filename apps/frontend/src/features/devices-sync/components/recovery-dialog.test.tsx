import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryDialog } from "./recovery-dialog";

const hookMocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
}));

vi.mock("../hooks", () => ({
  useSyncActions: () => ({
    handleRecovery: {
      mutateAsync: hookMocks.mutateAsync,
      isPending: false,
    },
  }),
}));

describe("RecoveryDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookMocks.mutateAsync.mockResolvedValue(undefined);
  });

  it("shows the consumer recovery copy and runs recovery on confirm", async () => {
    render(<RecoveryDialog open />);

    expect(screen.getAllByText("Set up this device again")).toHaveLength(2);
    expect(
      screen.getByText(
        "Sync was turned off for this device. Set it up again to keep your data up to date across your devices.",
      ),
    ).toBeInTheDocument();

    expect(
      screen.getByRole("button", { name: "Set up this device again" }).parentElement,
    ).toHaveClass("max-sm:[&>button]:whitespace-normal", "sm:flex-wrap");

    fireEvent.click(screen.getByRole("button", { name: "Set up this device again" }));

    expect(hookMocks.mutateAsync).toHaveBeenCalledTimes(1);
  });
});
