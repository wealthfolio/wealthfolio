import { render, screen } from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EventsCalendarCard } from "./events-calendar-card";

vi.mock("@/hooks/use-balance-privacy", () => ({
  useBalancePrivacy: () => ({ isBalanceHidden: false }),
}));

vi.mock("../../event-dialog-provider", () => ({
  useEventDialog: () => ({ openEventDialog: vi.fn() }),
}));

describe("EventsCalendarCard", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats weekday content with the formatting locale", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T12:00:00Z"));

    render(
      <FormattingProvider locale="de-DE" uiLocale="en">
        <EventsCalendarCard events={[]} currency="EUR" selectedId={null} onSelect={vi.fn()} />
      </FormattingProvider>,
    );

    expect(screen.getByText("So")).toBeInTheDocument();
    expect(screen.queryByText("Su")).not.toBeInTheDocument();
  });
});
