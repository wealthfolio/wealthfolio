import { format } from "date-fns";
import { render, screen, act } from "@/test/render";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import i18n from "i18next";
import zhCommon from "@/i18n/locales/zh/common.json";
import zhAi from "@/i18n/locales/zh/ai.json";
import { ValuationContentImpl } from "./valuation-tool-ui";

vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { baseCurrency: "USD" } }),
}));
vi.mock("@/components/history-chart", () => ({ HistoryChart: () => <div>Chart</div> }));
afterEach(async () => {
  await i18n.changeLanguage("en");
  vi.useRealTimers();
});

describe("AI valuation card labels", () => {
  it.each(["2026-10-27T02:00:00Z", "2026-10-27T23:00:00Z"])(
    "translates the portfolio fallback but preserves explicit account names and IDs at %s",
    async (now) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(now));
      i18n.addResourceBundle("zh", "common", zhCommon, true, true);
      i18n.addResourceBundle("zh", "ai", zhAi, true, true);
      type Props = ComponentProps<typeof ValuationContentImpl>;
      const props: Props = {
        args: {},
        argsText: "",
        status: { type: "complete" },
        result: {
          baseCurrency: "USD",
          valuations: [
            {
              // The chart interprets date-only valuations in local calendar time.
              valuationDate: format(new Date(), "yyyy-MM-dd"),
              totalValue: 100,
              netContribution: 90,
              baseCurrency: "USD",
            },
          ],
        } as Props["result"],
        toolName: "get_valuation_history",
        toolCallId: "call",
        type: "tool-call",
        addResult: vi.fn(),
        resume: vi.fn(),
      };
      const view = render(<ValuationContentImpl {...props} />);
      expect(screen.getByText("Portfolio")).toBeInTheDocument();
      await act(async () => {
        await i18n.changeLanguage("zh");
      });
      expect(screen.getByText(zhCommon.component.account_type_portfolio)).toBeInTheDocument();
      expect(screen.getByText(zhAi.valuation.title)).toBeInTheDocument();
      view.rerender(
        <ValuationContentImpl
          {...props}
          result={{ ...props.result!, accountId: "Portfolio", accountName: "Portfolio" }}
        />,
      );
      expect(screen.getByText("Portfolio")).toBeInTheDocument();
      expect(screen.queryByText(zhCommon.component.account_type_portfolio)).not.toBeInTheDocument();
      view.rerender(
        <ValuationContentImpl {...props} result={{ ...props.result!, accountId: "account-USD" }} />,
      );
      expect(screen.getByText("account-USD")).toBeInTheDocument();
    },
  );
});
