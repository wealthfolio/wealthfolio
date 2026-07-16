import { describe, expect, it } from "vitest";
import {
  clearActivityUrlDateFilters,
  clearActivityUrlFilters,
  clearActivityUrlSearchFilter,
  clearActivityUrlTypeFilters,
  resolveActivityTabFromUrlFilters,
  resolveActivityUrlFilters,
} from "./url-filters";

describe("resolveActivityUrlFilters", () => {
  it("maps review links to an account pending-review filter", () => {
    expect(
      resolveActivityUrlFilters(new URLSearchParams("account=acct-1&needsReview=true")),
    ).toEqual({
      accountScope: { type: "account", accountId: "acct-1" },
      statusFilter: "pending",
    });
  });

  it("ignores unrelated or false review params", () => {
    expect(resolveActivityUrlFilters(new URLSearchParams("needsReview=false"))).toEqual({});
    expect(resolveActivityUrlFilters(new URLSearchParams("tab=spending"))).toEqual({});
  });

  it("maps transfer-integrity deeplinks to activity types and a date window", () => {
    expect(
      resolveActivityUrlFilters(
        new URLSearchParams("types=TRANSFER_IN,TRANSFER_OUT&from=2026-06-01&to=2026-06-04"),
      ),
    ).toEqual({
      activityTypes: ["TRANSFER_IN", "TRANSFER_OUT"],
      dateFrom: "2026-06-01",
      dateTo: "2026-06-04",
    });
  });

  it("maps activity deep links to search query filters", () => {
    expect(resolveActivityUrlFilters(new URLSearchParams("q=AAPL"))).toEqual({
      searchQuery: "AAPL",
    });
  });

  it("maps health activity deep links to exact activity and context filters", () => {
    expect(
      resolveActivityUrlFilters(new URLSearchParams("activity=act-1&healthContext=activity")),
    ).toEqual({
      activityId: "act-1",
      healthContext: "activity",
    });
  });

  it("ignores an empty types param", () => {
    expect(resolveActivityUrlFilters(new URLSearchParams("types="))).toEqual({});
  });

  it("maps account-filtered links to the spending tab for spending accounts", () => {
    expect(
      resolveActivityTabFromUrlFilters(new URLSearchParams("account=cash-1"), ["cash-1"]),
    ).toBe("spending");
  });

  it("maps account-filtered links to the investments tab for non-spending accounts", () => {
    expect(
      resolveActivityTabFromUrlFilters(new URLSearchParams("account=brokerage-1"), ["cash-1"]),
    ).toBe("investments");
  });

  it("does not choose a tab without an account filter", () => {
    expect(
      resolveActivityTabFromUrlFilters(new URLSearchParams("types=TRANSFER_IN"), ["cash-1"]),
    ).toBeUndefined();
  });

  it("clears broker review filter params without dropping unrelated params", () => {
    const cleared = clearActivityUrlFilters(
      new URLSearchParams("tab=investments&account=acct-1&needsReview=true"),
    );

    expect(cleared.toString()).toBe("tab=investments");
  });

  it("clears transfer-integrity deeplink params", () => {
    const cleared = clearActivityUrlFilters(
      new URLSearchParams(
        "tab=investments&types=TRANSFER_IN&from=2026-06-01&to=2026-06-04&q=AAPL&healthContext=activity",
      ),
    );

    expect(cleared.toString()).toBe("tab=investments");
  });

  it("clears only date params when replacing investment date filter", () => {
    const cleared = clearActivityUrlDateFilters(
      new URLSearchParams(
        "tab=investments&account=acct-1&needsReview=true&types=TRANSFER_IN&from=2026-06-01&to=2026-06-04",
      ),
    );

    expect(cleared.toString()).toBe(
      "tab=investments&account=acct-1&needsReview=true&types=TRANSFER_IN",
    );
  });

  it("clears only type params when replacing investment type filter", () => {
    const cleared = clearActivityUrlTypeFilters(
      new URLSearchParams(
        "tab=investments&account=acct-1&needsReview=true&types=TRANSFER_IN&from=2026-06-01&to=2026-06-04",
      ),
    );

    expect(cleared.toString()).toBe(
      "tab=investments&account=acct-1&needsReview=true&from=2026-06-01&to=2026-06-04",
    );
  });

  it("clears only search params when replacing investment search filter", () => {
    const cleared = clearActivityUrlSearchFilter(
      new URLSearchParams("tab=investments&account=acct-1&from=2026-06-01&q=AAPL"),
    );

    expect(cleared.toString()).toBe("tab=investments&account=acct-1&from=2026-06-01");
  });
});
