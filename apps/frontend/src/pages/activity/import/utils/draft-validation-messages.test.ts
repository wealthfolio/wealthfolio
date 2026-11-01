import { createInstance } from "i18next";
import { expect, it } from "vitest";
import en from "@/i18n/locales/en/activity.json";
import zh from "@/i18n/locales/zh/activity.json";
import { validateDraft, draftToActivityImport } from "./draft-utils";
import type { DraftActivity } from "../context";
import { formatDraftErrors, omitLocalDraftErrors } from "./draft-validation-messages";

it("keeps local error provenance off the wire and raw backend replacements verbatim", async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "zh", resources: { en: { activity: en }, zh: { activity: zh } } });
  const input = { activityType: "BUY", quantity: "0", unitPrice: "-1" };
  const validation = validateDraft(input);
  const draft = {
    ...input,
    ...validation,
    rowIndex: 0,
    activityDate: "",
    currency: "",
    accountId: "",
    rawRow: [],
    isEdited: false,
  } as DraftActivity;
  const original = structuredClone(draft);
  expect(validation.errors).toEqual({
    activityDate: ["Date is required"],
    currency: ["Currency is required"],
    accountId: ["Account is required"],
    symbol: ["Symbol is required for trade activities"],
    quantity: ["Quantity must be greater than 0"],
    unitPrice: ["Unit price must be greater than 0"],
  });
  const payload = draftToActivityImport(draft);
  expect(payload.errors).toEqual(validation.errors);
  expect(payload).not.toHaveProperty("localErrorMessages");
  expect(
    formatDraftErrors(
      i18n.t,
      validation.errors.activityDate,
      validation.localErrorMessages.activityDate,
    ),
  ).toEqual([zh.validation.date_is_required]);
  // A backend replacement owns its text even when identical to the local English string.
  const replaced = omitLocalDraftErrors(validation.localErrorMessages, ["activityDate"]);
  expect(formatDraftErrors(i18n.t, ["Date is required"], replaced?.activityDate)).toEqual([
    "Date is required",
  ]);
  expect(formatDraftErrors(i18n.t, ["activity:validation.date_is_required"])).toEqual([
    "activity:validation.date_is_required",
  ]);
  expect(draft).toEqual(original);
});
