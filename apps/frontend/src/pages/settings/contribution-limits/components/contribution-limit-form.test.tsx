import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { Dialog } from "@wealthfolio/ui";
import { Activity } from "react";
import { describe, expect, it, vi } from "vitest";
import { ContributionLimitForm } from "./contribution-limit-form";

const mocks = vi.hoisted(() => ({
  // Swapped for a real save in tests that need one.
  useAddLimit: null as null | (() => unknown),
}));

vi.mock("../use-contribution-limit-mutations", () => ({
  useContributionLimitMutations: () => ({
    addContributionLimitMutation: mocks.useAddLimit?.() ?? {
      mutateAsync: vi.fn(),
      isPending: false,
    },
    updateContributionLimitMutation: { mutateAsync: vi.fn(), isPending: false },
  }),
}));

/** The month segment of each date field, start date first. */
const monthSegments = () =>
  screen
    .getAllByRole("spinbutton")
    .filter((segment) => /month/i.test(segment.getAttribute("aria-label") ?? ""));

describe("ContributionLimitForm on a screen kept out of sight", () => {
  it("keeps a start date set by hand when the screen is shown again", () => {
    const view = (hidden: boolean) => (
      <Activity mode={hidden ? "hidden" : "visible"}>
        {/* The form is the body of the add/edit dialog. */}
        <Dialog open>
          <ContributionLimitForm
            defaultValues={{
              groupName: "TFSA",
              contributionYear: 2026,
              limitAmount: 7000,
            }}
          />
        </Dialog>
      </Activity>
    );
    const { rerender } = render(view(false));
    const [startMonth] = monthSegments();
    expect(startMonth).toHaveAttribute("aria-valuenow", "1");

    // The year's dates fill in; the user moves the start to April.
    act(() => startMonth.focus());
    for (let step = 0; step < 3; step++) fireEvent.keyDown(startMonth, { key: "ArrowUp" });
    expect(monthSegments()[0]).toHaveAttribute("aria-valuenow", "4");

    rerender(view(true));
    rerender(view(false));
    expect(monthSegments()[0]).toHaveAttribute("aria-valuenow", "4");
  });

  it("finishes when its save ends while the screen is out of sight", async () => {
    let finish: () => void = () => undefined;
    const saved = new Promise<void>((resolve) => (finish = resolve));
    mocks.useAddLimit = () => useMutation({ mutationFn: () => saved });
    const client = new QueryClient();
    const onSuccess = vi.fn();
    const view = (hidden: boolean) => (
      <QueryClientProvider client={client}>
        <Activity mode={hidden ? "hidden" : "visible"}>
          <Dialog open>
            <ContributionLimitForm
              defaultValues={{ groupName: "TFSA", contributionYear: 2026, limitAmount: 7000 }}
              onSuccess={onSuccess}
            />
          </Dialog>
        </Activity>
      </QueryClientProvider>
    );
    const saveStatus = () => client.getMutationCache().getAll()[0]?.state.status;
    const { rerender } = render(view(false));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveStatus()).toBe("pending"));

    rerender(view(true));
    act(() => finish());
    await waitFor(() => expect(saveStatus()).toBe("success"));
    rerender(view(false));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
    mocks.useAddLimit = null;
  });
});
