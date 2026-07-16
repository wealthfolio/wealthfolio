import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { MetricDisplay } from "./metric-display";

describe("MetricDisplay", () => {
  it("links unavailable metric reasons to the Health Center", () => {
    const reason =
      "TWR unavailable for 2025-11-02 because an external flow amount or transfer boundary is unknown.";

    render(
      <MemoryRouter>
        <MetricDisplay
          label="Time Weighted Return"
          infoText="Time-weighted return"
          emptyReason={reason}
        />
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", {
      name: "Open Health Center for Time Weighted Return issue",
    });

    expect(link).toHaveAttribute("href", "/health");
    expect(link).toHaveAttribute("title", reason);
    expect(link).toHaveTextContent(reason);
  });
});
