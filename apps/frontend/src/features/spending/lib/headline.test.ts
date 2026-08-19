import { describe, expect, it, vi } from "vitest";

import { buildHeadline } from "./headline";

describe("buildHeadline", () => {
  it("uses translated copy for empty periods", () => {
    const t = vi.fn((key: string) =>
      key === "spending:whatChanged.headlineNoActivity"
        ? "この期間に記録された支出はありません。"
        : key,
    );

    const headline = buildHeadline({
      periodState: { kind: "no_activity_either_side" },
      movers: [],
      currentTotal: 0,
      priorTotal: 0,
      priorLabel: "前回",
      metaLabel: "",
      t,
    });

    expect(headline.fragments).toEqual([
      { type: "text", text: "この期間に記録された支出はありません。" },
    ]);
  });

  it("removes date-abbreviation punctuation before the translated comparison suffix", () => {
    const t = vi.fn((key: string, options?: Record<string, unknown>) => {
      if (key === "spending:whatChanged.headlineLeadPrefix") return "You spent ";
      if (key === "spending:whatChanged.headlineMoreSuffix") {
        return ` more than ${String(options?.priorLabel)}.`;
      }
      return key;
    });

    const headline = buildHeadline({
      periodState: { kind: "valid_comparison" },
      movers: [],
      currentTotal: 200,
      priorTotal: 100,
      priorLabel: "juil.",
      metaLabel: "",
      t,
    });

    expect(headline.fragments).toContainEqual({ type: "text", text: " more than juil." });
  });
});
