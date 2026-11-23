import { fireEvent, render, screen } from "@/test/render";
import { act } from "@testing-library/react";
import { DirectionProvider } from "@wealthfolio/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "i18next";
import zh from "@/i18n/locales/zh/activity.json";
import { AssetPreviewFeedback } from "./asset-preview-feedback";

afterEach(async () => {
  vi.useRealTimers();
  await act(() => i18n.changeLanguage("en"));
});

describe.each(["ltr", "rtl"] as const)("asset preview feedback (%s)", (direction) => {
  it("shows real completed counts, keeps errors actionable, and retries unchecked assets", () => {
    const retry = vi.fn();
    render(
      <DirectionProvider direction={direction}>
        <AssetPreviewFeedback
          total={12}
          remaining={7}
          isChecking={false}
          progress={{ total: 12, completed: 5, startedAt: 0, finishedAt: 30_000 }}
          error={{ kind: "timeout", httpStatus: 408 }}
          onRetry={retry}
        />
      </DirectionProvider>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Asset matching timed out");
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "5");
    expect(screen.getByText("Assets checked: 5 / 12")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Check remaining assets (7)" }));
    expect(retry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText(/http_status=408/)).toBeVisible();
    expect(screen.getByText(/No activities or holdings have been imported/)).toBeInTheDocument();
  });

  it("explains a slow request without inventing progress or an ETA", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    render(
      <DirectionProvider direction={direction}>
        <AssetPreviewFeedback
          total={12}
          remaining={12}
          isChecking
          progress={{ total: 12, completed: 0, startedAt: Date.now() }}
          error={null}
          onRetry={vi.fn()}
        />
      </DirectionProvider>,
    );
    expect(screen.getByText("Matching assets")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(31_000));
    expect(screen.getByText("Asset matching is taking longer than usual")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

it("translates a held failure at display time without another request", async () => {
  i18n.addResourceBundle("zh", "activity", zh, true, true);
  render(
    <AssetPreviewFeedback
      total={1}
      remaining={1}
      isChecking={false}
      progress={null}
      error={{ kind: "timeout" }}
      onRetry={vi.fn()}
    />,
  );
  await act(() => i18n.changeLanguage("zh"));
  expect(screen.getByText(zh.import.assets.timeoutTitle)).toBeInTheDocument();
});

it("keeps recovery available when a manual merge covers the remaining candidates", () => {
  const retry = vi.fn();
  render(
    <AssetPreviewFeedback
      total={2}
      remaining={0}
      isChecking={false}
      progress={null}
      error={{ kind: "timeout" }}
      onRetry={retry}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledOnce();
});
