import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ActivityUpdate } from "@/lib/types";
import {
  ActivitySplitReviewProvider,
  useActivitySplitReview,
} from "./activity-split-review-provider";

const mocks = vi.hoisted(() => ({ preview: vi.fn(), saved: vi.fn(), cancelled: vi.fn() }));
vi.mock("@/adapters", () => ({ reviewActivitySplitEffects: mocks.preview }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      `${key}${opts?.count === undefined ? "" : ` ${opts.count}`}`,
  }),
}));
const update = {
  id: "cash",
  accountId: "account",
  activityType: "WITHDRAWAL",
  amount: "125",
  activityDate: "2026-10-01",
} as ActivityUpdate;
const effect = {
  activityId: "cash",
  removedSplits: 2,
  existingCategoryBecomesEffective: true,
  fingerprint: "opaque-review",
};
function Editor() {
  const review = useActivitySplitReview();
  return (
    <button
      onClick={() => {
        void review([update]).then(mocks.saved, mocks.cancelled);
      }}
    >
      Save edit
    </button>
  );
}
function mount() {
  return render(
    <div dir="rtl">
      <ActivitySplitReviewProvider>
        <Editor />
      </ActivitySplitReviewProvider>
    </div>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.preview.mockResolvedValue([effect]);
});

describe("financial split effects review", () => {
  it("shows removals and hidden-category effects before sending the exact reviewed snapshot", async () => {
    mount();
    fireEvent.click(screen.getByText("Save edit"));
    await screen.findByText(/spending:splitEditReview.removed 2/);
    expect(screen.getByText(/spending:splitEditReview.hiddenCategory/)).toBeTruthy();
    expect(mocks.saved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("spending:splitEditReview.confirm"));
    await waitFor(() =>
      expect(mocks.saved).toHaveBeenCalledWith([{ ...update, splitReview: [effect] }]),
    );
    expect(mocks.preview).toHaveBeenCalledTimes(1);
  });
  it("cancels without writing, and cancels a pending review on profile unmount", async () => {
    const view = mount();
    fireEvent.click(screen.getByText("Save edit"));
    await screen.findByText("spending:splitEditReview.title");
    fireEvent.click(screen.getByText("common:cancel"));
    await waitFor(() => expect(mocks.cancelled).toHaveBeenCalledTimes(1));
    expect(mocks.saved).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Save edit"));
    await screen.findByText("spending:splitEditReview.title");
    view.unmount();
    await waitFor(() => expect(mocks.cancelled).toHaveBeenCalledTimes(2));
  });
  it("guards edits even when the preview currently has no removable splits", async () => {
    mocks.preview.mockResolvedValue([
      { ...effect, removedSplits: 0, existingCategoryBecomesEffective: false },
    ]);
    mount();
    await act(async () => fireEvent.click(screen.getByText("Save edit")));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(mocks.saved).toHaveBeenCalledWith([
      {
        ...update,
        splitReview: [{ ...effect, removedSplits: 0, existingCategoryBecomesEffective: false }],
      },
    ]);
  });
});
