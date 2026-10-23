import { act, fireEvent, render, screen } from "@/test/render";
import { Dialog } from "@wealthfolio/ui";
import { Activity } from "react";
import { describe, expect, it, vi } from "vitest";
import { ContributionLimitForm } from "./contribution-limit-form";

vi.mock("../use-contribution-limit-mutations", () => ({
  useContributionLimitMutations: () => ({
    addContributionLimitMutation: { mutate: vi.fn(), isPending: false },
    updateContributionLimitMutation: { mutate: vi.fn(), isPending: false },
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
});
