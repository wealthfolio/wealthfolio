import { act, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import i18n from "i18next";
import { useTranslation } from "react-i18next";
import { FormattingProvider } from "@wealthfolio/ui";
import enActivity from "@/i18n/locales/en/activity.json";
import zhActivity from "@/i18n/locales/zh/activity.json";
import type { ImportMappingData } from "@/lib/types";
import { ImportProvider, useImportContext, type DraftActivity } from "./import-context";
import { ReviewStep } from "../steps/review-step";
import { formatDraftErrors } from "../utils/draft-validation-messages";

const mocks = vi.hoisted(() => ({ check: vi.fn(), preview: vi.fn(), log: vi.fn() }));
vi.mock("@/adapters", () => ({
  checkActivitiesImport: mocks.check,
  previewImportAssets: mocks.preview,
  logger: { error: mocks.log },
}));
vi.mock("@/hooks/use-accounts", () => ({ useAccounts: () => ({ accounts: [] }) }));
// The context owns provenance; the grid's real rendering is covered by its own UI tests.
vi.mock("../components/import-review-grid", () => ({
  ImportReviewGrid: ({ drafts }: { drafts: DraftActivity[] }) => {
    const { t } = useTranslation();
    return (
      <div>
        {drafts.flatMap((draft) =>
          Object.entries(draft.errors).flatMap(([field, errors]) =>
            formatDraftErrors(t, errors, draft.localErrorMessages?.[field]).map((error, index) => (
              <p key={`${draft.rowIndex}-${field}-${index}`}>{error}</p>
            )),
          ),
        )}
      </div>
    );
  },
}));
const draft: DraftActivity = {
  rowIndex: 0,
  isEdited: false,
  rawRow: [],
  activityDate: "2026-01-01",
  activityType: "DEPOSIT",
  amount: "10",
  currency: "USD",
  accountId: "account-1",
  status: "valid",
  errors: {},
  warnings: {},
};
let context: ReturnType<typeof useImportContext>;
function Review() {
  context = useImportContext();
  return <ReviewStep />;
}
async function renderReview(errors: Record<string, string[]> = {}) {
  render(
    <FormattingProvider locale="en-US">
      <ImportProvider>
        <Review />
      </ImportProvider>
    </FormattingProvider>,
  );
  act(() => {
    context.dispatch({
      type: "SET_PARSED_DATA",
      payload: { headers: ["Date"], rows: [["2026-01-01"]] },
    });
    context.dispatch({
      type: "SET_MAPPING",
      payload: {
        accountId: "account-1",
        importType: "CSV_ACTIVITY",
        name: "Test import",
        fieldMappings: { date: "Date" },
        activityMappings: {},
        symbolMappings: {},
        accountMappings: {},
      } satisfies ImportMappingData,
    });
    context.dispatch({ type: "SET_DRAFT_ACTIVITIES", payload: [{ ...draft, errors }] });
  });
}
beforeEach(async () => {
  vi.clearAllMocks();
  i18n.addResourceBundle("zh", "activity", zhActivity, true, true);
  await i18n.changeLanguage("en");
});
afterEach(async () => {
  await act(() => i18n.changeLanguage("en"));
});

it("retranslates the held backend-failure banner without validating again", async () => {
  mocks.check.mockRejectedValueOnce(new Error("Raw backend error"));
  await renderReview();
  await act(() => context.validateDrafts(context.state.draftActivities));
  expect(screen.getByText(enActivity.import.review.backend_failed)).toBeInTheDocument();
  const validation = context.validateDrafts;
  const drafts = context.state.draftActivities;
  await act(() => i18n.changeLanguage("zh"));
  expect(screen.getByText(zhActivity.import.review.backend_failed)).toBeInTheDocument();
  await act(() => i18n.changeLanguage("en"));
  expect(screen.getByText(enActivity.import.review.backend_failed)).toBeInTheDocument();
  expect(context.validateDrafts).toBe(validation);
  expect(context.state.draftActivities).toBe(drafts);
  expect(mocks.check).toHaveBeenCalledTimes(1);
  expect(mocks.preview).not.toHaveBeenCalled();
});

it.each([false, true])(
  "localizes only a generated general fallback, not identical raw text (%s)",
  async (rawAlreadyPresent) => {
    mocks.check.mockResolvedValue([{ lineNumber: 1, isValid: false }]);
    await renderReview(rawAlreadyPresent ? { general: [enActivity.validation_failed] } : {});
    await act(() => context.validateDrafts(context.state.draftActivities));
    expect(context.state.draftActivities[0].errors.general).toEqual([enActivity.validation_failed]);
    await act(() => i18n.changeLanguage("zh"));
    expect(
      screen.getByText(
        rawAlreadyPresent ? enActivity.validation_failed : zhActivity.validation_failed,
      ),
    ).toBeInTheDocument();
    expect(context.state.draftActivities[0].errors.general).toEqual([enActivity.validation_failed]);
    expect(mocks.check).toHaveBeenCalledTimes(1);
    expect(mocks.check.mock.calls[0][0].activities[0]).not.toHaveProperty("localErrorMessages");
    // Explicitly revalidate the now-tagged draft: display provenance must stay local.
    await act(() => context.validateDrafts(context.state.draftActivities));
    expect(mocks.check).toHaveBeenCalledTimes(2);
    expect(mocks.check.mock.calls[1][0].activities[0]).not.toHaveProperty("localErrorMessages");
  },
);

it("keeps backend diagnostics and key-looking raw banner text verbatim", async () => {
  const raw = "activity:validation_failed";
  mocks.check.mockResolvedValue([{ lineNumber: 1, isValid: false, errors: { general: [raw] } }]);
  await renderReview();
  await act(() => context.validateDrafts(context.state.draftActivities));
  act(() =>
    context.dispatch({
      type: "SET_VALIDATION_ERROR",
      payload: "activity:import.review.backend_failed",
    }),
  );
  await act(() => i18n.changeLanguage("zh"));
  expect(screen.getByText(raw)).toBeInTheDocument();
  expect(screen.getByText("activity:import.review.backend_failed")).toBeInTheDocument();
  expect(context.state.draftActivities[0].localErrorMessages?.general).toBeUndefined();
  expect(mocks.check).toHaveBeenCalledTimes(1);
});
