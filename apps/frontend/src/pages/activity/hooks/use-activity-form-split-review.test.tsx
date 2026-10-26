import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, it, expect, vi } from "vitest";
import { useActivityForm } from "./use-activity-form";
import { ActivitySplitReviewProvider } from "@/features/spending/components/activity-split-review-provider";
import { ActivityType } from "@/lib/constants";
import type { ActivityDetails, ActivityUpdate } from "@/lib/types";
const mocks = vi.hoisted(() => ({
  reviewActivitiesSplitEffects: vi.fn(),
  reviewInternalTransferPairSplitEffects: vi.fn(),
  updateActivity: vi.fn(),
  deleteActivity: vi.fn(),
  createActivity: vi.fn(),
  saveActivities: vi.fn(),
  saveInternalTransferPair: vi.fn(),
  linkTransferActivities: vi.fn(),
  unlinkTransferActivities: vi.fn(),
  getTransferPairForActivity: vi.fn(),
  logger: { error: vi.fn() },
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock("@/adapters", () => mocks);
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
function Editor({
  transfer = false,
  internal = false,
}: {
  transfer?: boolean;
  internal?: boolean;
}) {
  const form = useActivityForm({
    accounts: [
      { value: "account", label: "Account", currency: "USD" },
      { value: "destination", label: "Destination", currency: "USD" },
    ],
    selectedType: transfer ? "TRANSFER" : ActivityType.WITHDRAWAL,
    activity: {
      id: "a",
      accountId: "account",
      activityType: transfer ? ActivityType.TRANSFER_OUT : ActivityType.WITHDRAWAL,
      date: new Date("2026-04-01T12:00:00Z"),
      currency: "USD",
      amount: "12.5",
      ...(transfer ? { sourceGroupId: "pair", transferOutId: "a", transferInId: "b" } : {}),
    } as Partial<ActivityDetails>,
  });
  return (
    <>
      <button
        onClick={() =>
          void form.handleSubmit({
            accountId: "account",
            activityDate: new Date("2026-04-01T12:00:00Z"),
            currency: "USD",
            amount: 25,
            ...(transfer
              ? {
                  transferMode: "cash",
                  isExternal: !internal,
                  direction: "out",
                  ...(internal ? { fromAccountId: "account", toAccountId: "destination" } : {}),
                }
              : {}),
          } as never)
        }
      >
        Save edit
      </button>
      <output data-testid="error">{String(form.error)}</output>
      <output data-testid="is-error">{String(form.isError)}</output>
      <output data-testid="is-loading">{String(form.isLoading)}</output>
    </>
  );
}
function mount(transfer = false, internal = false) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <ActivitySplitReviewProvider>
        <Editor transfer={transfer} internal={internal} />
      </ActivitySplitReviewProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.reviewActivitiesSplitEffects.mockImplementation(async (updates: ActivityUpdate[]) =>
    updates.map((update) => [
      {
        activityId: update.id,
        removedSplits: 2,
        hasRetainedCategoryAssignment: false,
        fingerprint: "review",
      },
      ...(update.unlinkTransferPairId
        ? [
            {
              activityId: update.unlinkTransferPairId,
              removedSplits: 0,
              hasRetainedCategoryAssignment: false,
              fingerprint: "counterpart-review",
            },
          ]
        : []),
    ]),
  );
  mocks.unlinkTransferActivities.mockResolvedValue({});
  mocks.reviewInternalTransferPairSplitEffects.mockResolvedValue(
    ["a", "b"].map((activityId) => ({
      activityId,
      removedSplits: 1,
      hasRetainedCategoryAssignment: false,
      fingerprint: `${activityId}-pair-review`,
    })),
  );
  mocks.saveInternalTransferPair.mockResolvedValue({
    transferOut: { id: "a", accountId: "account" },
    transferIn: { id: "b", accountId: "destination" },
  });
});
it("cancelling split removal leaves the desktop form neutral and saves nothing", async () => {
  mount();
  fireEvent.click(screen.getByText("Save edit"));
  await screen.findByRole("alertdialog");
  fireEvent.click(screen.getByText("common:cancel"));
  await waitFor(() => expect(screen.getByTestId("is-loading").textContent).toBe("false"));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(mocks.toast.error).not.toHaveBeenCalled();
  expect(screen.getByTestId("is-error").textContent).toBe("false");
  expect(screen.getByTestId("error").textContent).toBe("null");
  expect(mocks.updateActivity).not.toHaveBeenCalled();
});
it("cancelling transfer externalization performs neither unlink nor financial write", async () => {
  mount(true);
  fireEvent.click(screen.getByText("Save edit"));
  await screen.findByRole("alertdialog");
  expect(mocks.unlinkTransferActivities).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("common:cancel"));
  await waitFor(() => expect(screen.getByTestId("is-loading").textContent).toBe("false"));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByTestId("is-error").textContent).toBe("false");
  expect(mocks.toast.error).not.toHaveBeenCalled();
  expect(mocks.updateActivity).not.toHaveBeenCalled();
  expect(mocks.unlinkTransferActivities).not.toHaveBeenCalled();
});

it("approving transfer externalization submits the unlink and edit with the same review", async () => {
  mocks.updateActivity.mockResolvedValue({ id: "a" });
  mount(true);
  fireEvent.click(screen.getByText("Save edit"));
  await screen.findByRole("alertdialog");
  fireEvent.click(screen.getByText("spending:splitEditReview.confirm"));
  await waitFor(() => expect(mocks.updateActivity).toHaveBeenCalledOnce());
  expect(mocks.updateActivity).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "a",
      amount: "25",
      unlinkTransferPairId: "b",
      splitReview: [
        expect.objectContaining({ activityId: "a", fingerprint: "review" }),
        expect.objectContaining({
          activityId: "b",
          fingerprint: "counterpart-review",
          removedSplits: 0,
        }),
      ],
    }),
  );
  expect(mocks.unlinkTransferActivities).not.toHaveBeenCalled();
  expect(mocks.toast.error).not.toHaveBeenCalled();
});

it.each([false, true])(
  "internal pair edits review both legs before saving (approve=%s)",
  async (approve) => {
    mount(true, true);
    fireEvent.click(screen.getByText("Save edit"));
    await screen.findByRole("alertdialog");
    expect(mocks.reviewInternalTransferPairSplitEffects).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        transferOutId: "a",
        transferInId: "b",
        sourceAmount: 25,
        destinationAmount: 25,
      }),
    );
    expect(mocks.saveInternalTransferPair).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByText(approve ? "spending:splitEditReview.confirm" : "common:cancel"),
    );
    await waitFor(() => expect(screen.getByTestId("is-loading").textContent).toBe("false"));
    if (approve) {
      expect(mocks.saveInternalTransferPair).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          splitReview: [
            expect.objectContaining({ activityId: "a", fingerprint: "a-pair-review" }),
            expect.objectContaining({ activityId: "b", fingerprint: "b-pair-review" }),
          ],
        }),
      );
    } else {
      expect(mocks.saveInternalTransferPair).not.toHaveBeenCalled();
      expect(screen.getByTestId("is-error").textContent).toBe("false");
      expect(screen.getByTestId("error").textContent).toBe("null");
    }
    expect(mocks.updateActivity).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
  },
);

it("internal pair edits carry both proofs even when no allocations are removed", async () => {
  mocks.reviewInternalTransferPairSplitEffects.mockResolvedValue(
    ["a", "b"].map((activityId) => ({
      activityId,
      removedSplits: 0,
      hasRetainedCategoryAssignment: false,
      fingerprint: `${activityId}-unchanged`,
    })),
  );
  mount(true, true);
  fireEvent.click(screen.getByText("Save edit"));
  await waitFor(() => expect(mocks.saveInternalTransferPair).toHaveBeenCalledOnce());
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(mocks.saveInternalTransferPair).toHaveBeenCalledWith(
    expect.objectContaining({
      splitReview: [
        expect.objectContaining({ activityId: "a", fingerprint: "a-unchanged" }),
        expect.objectContaining({ activityId: "b", fingerprint: "b-unchanged" }),
      ],
    }),
  );
});

it.each([["a"], ["a", "a"], ["a", "other"]])(
  "does not save a pair when review returns the wrong legs (%j)",
  async (...ids) => {
    mocks.reviewInternalTransferPairSplitEffects.mockResolvedValue(
      ids.map((activityId) => ({
        activityId,
        removedSplits: 0,
        hasRetainedCategoryAssignment: false,
        fingerprint: "incomplete",
      })),
    );
    mount(true, true);
    fireEvent.click(screen.getByText("Save edit"));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    expect(mocks.saveInternalTransferPair).not.toHaveBeenCalled();
    expect(mocks.updateActivity).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  },
);
