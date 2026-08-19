import batchDraftUiSource from "./record-activities-tool-ui.tsx?raw";
import singleDraftUiSource from "./record-activity-tool-ui.tsx?raw";

describe("activity draft confirmation contract", () => {
  it("persists a single draft only through an explicit confirm or edited-form submit", () => {
    expect(singleDraftUiSource).toContain("const handleConfirm = useCallback(() => {");
    expect(singleDraftUiSource).toContain("void handleFormSubmit(defaultValues");
    expect(singleDraftUiSource).toContain("onClick={onConfirm}");
    expect(singleDraftUiSource).toContain("onSubmit={handleFormSubmit}");
    expect(singleDraftUiSource).toContain("addActivityMutation.mutateAsync(submitData)");
  });

  it("persists batch drafts only from the confirmation button handler", () => {
    expect(batchDraftUiSource).toContain("const handleSubmit = async () => {");
    expect(batchDraftUiSource).toContain("const saveResult = await saveActivities({");
    expect(batchDraftUiSource).toContain("<Button onClick={handleSubmit}");
    expect(batchDraftUiSource).toContain("confirmActivities");
  });
});
