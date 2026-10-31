import { ActivityType } from "@/lib/constants";
import { describe, expect, it } from "vitest";

import type { SavePayloadResult } from "@/pages/activity/components/activity-data-grid/types";

import type { CashActivity } from "../types/cash-activity";
import {
  EDIT_REJECTIONS,
  INCOME_TAXONOMY,
  SAVINGS_TAXONOMY,
  SPENDING_TAXONOMY,
  applySpendingRules,
  createSpendingDraft,
  duplicateSpendingRow,
  getEditRejection,
  planCategoryWrites,
  prepareSpendingPayload,
  toSpendingGridRow,
  validateSpendingRows,
  type SpendingGridRow,
} from "./spending-grid";

const ACCOUNT_TYPES: Record<string, string> = { cash: "CASH", card: "CREDIT_CARD" };
const accountTypeOf = (id: string) => ACCOUNT_TYPES[id];

function cashActivity(overrides: Partial<CashActivity> = {}): CashActivity {
  return {
    id: "a1",
    accountId: "cash",
    activityType: "WITHDRAWAL",
    status: "POSTED",
    activityDate: "2026-10-01T12:00:00.000Z",
    amount: "25",
    currency: "USD",
    isUserModified: false,
    needsReview: false,
    createdAt: "2026-10-01T12:00:00.000Z",
    updatedAt: "2026-10-01T12:00:00.000Z",
    cashFlowBucket: "spending",
    assignments: [],
    splits: [],
    netAmount: -25,
    ...overrides,
  } as CashActivity;
}

const assignment = (taxonomyId: string, categoryId: string) => ({
  id: `asg-${categoryId}`,
  activityId: "a1",
  taxonomyId,
  categoryId,
  weight: 1,
  source: "manual",
  createdAt: "",
  updatedAt: "",
});

const row = (overrides: Partial<CashActivity> = {}) => toSpendingGridRow(cashActivity(overrides));

describe("toSpendingGridRow", () => {
  it("takes the category of the row's own bucket and the effective type", () => {
    const grid = row({
      activityTypeOverride: "FEE",
      assignments: [assignment(INCOME_TAXONOMY, "salary"), assignment(SPENDING_TAXONOMY, "food")],
    });
    expect(grid.activityType).toBe("FEE");
    expect(grid.categoryId).toBe("food");
    expect(grid._originalCategoryId).toBe("food");
  });

  it("leaves a split row's category to its lines", () => {
    const grid = row({
      assignments: [assignment(SPENDING_TAXONOMY, "food")],
      splits: [{ id: "s1" }, { id: "s2" }] as CashActivity["splits"],
    });
    expect(grid.categoryId).toBe("");
    expect(grid.splitCount).toBe(2);
  });
});

describe("getEditRejection", () => {
  it("sends a linked transfer's account or currency change to the transfer form", () => {
    const transfer = row({
      activityType: "TRANSFER_OUT",
      sourceGroupId: "g1",
      cashFlowBucket: "neutral",
    });
    expect(getEditRejection(transfer, { ...transfer, accountId: "card" }, transfer)).toBe(
      EDIT_REJECTIONS.transferPair,
    );
    expect(getEditRejection(transfer, { ...transfer, currency: "EUR" }, transfer)).toBe(
      EDIT_REJECTIONS.transferPair,
    );
    expect(getEditRejection(transfer, { ...transfer, amount: "30" }, transfer)).toBeNull();
  });

  it("makes and changes transfers only in the transfer form", () => {
    const transfer = row({ activityType: "TRANSFER_IN", cashFlowBucket: "neutral" });
    expect(
      getEditRejection(transfer, { ...transfer, activityType: ActivityType.DEPOSIT }, transfer),
    ).toBe(EDIT_REJECTIONS.transferType);
    const charge = row();
    expect(
      getEditRejection(charge, { ...charge, activityType: ActivityType.TRANSFER_OUT }, charge),
    ).toBe(EDIT_REJECTIONS.transferType);
  });

  it("keeps split lines and neutral rows out of category edits", () => {
    const split = row({ splits: [{ id: "s1" }] as CashActivity["splits"] });
    expect(getEditRejection(split, { ...split, categoryId: "food" }, split)).toBe(
      EDIT_REJECTIONS.split,
    );
    const neutral = row({ cashFlowBucket: "neutral" });
    expect(getEditRejection(neutral, { ...neutral, categoryId: "food" }, neutral)).toBe(
      EDIT_REJECTIONS.neutral,
    );
  });

  it("saves a category apart from a new type or account", () => {
    const original = row({ assignments: [assignment(SPENDING_TAXONOMY, "food")] });
    const retyped = { ...original, activityType: ActivityType.FEE };
    expect(getEditRejection(retyped, { ...retyped, categoryId: "rent" }, original)).toBe(
      EDIT_REJECTIONS.saveTypeFirst,
    );

    const recategorized = { ...original, categoryId: "rent" };
    expect(getEditRejection(recategorized, { ...recategorized, accountId: "card" }, original)).toBe(
      EDIT_REJECTIONS.saveCategoryFirst,
    );
    // Both in one paste.
    expect(
      getEditRejection(
        original,
        { ...original, categoryId: "rent", activityType: ActivityType.FEE },
        original,
      ),
    ).toBe(EDIT_REJECTIONS.saveCategoryFirst);
  });

  it("lets a new row take a type and a category together", () => {
    const draft = createSpendingDraft(undefined, "USD");
    expect(
      getEditRejection(
        draft,
        { ...draft, activityType: ActivityType.FEE, categoryId: "bank" },
        undefined,
      ),
    ).toBeNull();
  });
});

describe("applySpendingRules", () => {
  it("makes a new credit on a cash account a reimbursement, as the form does", () => {
    const previous = row();
    const credit = applySpendingRules(
      previous,
      { ...previous, activityType: ActivityType.CREDIT, subtype: undefined },
      accountTypeOf,
    );
    expect(credit.subtype).toBe("REIMBURSEMENT");
  });

  it("leaves a card credit's subtype alone", () => {
    const previous = row({ accountId: "card" });
    const credit = applySpendingRules(
      previous,
      { ...previous, activityType: ActivityType.CREDIT, subtype: undefined },
      accountTypeOf,
    );
    expect(credit.subtype).toBeUndefined();
  });

  it("drops a new row's category when its taxonomy changes", () => {
    const draft = {
      ...createSpendingDraft(undefined, "USD"),
      accountId: "cash",
      categoryId: "food",
    };
    const deposit = applySpendingRules(
      draft,
      { ...draft, activityType: ActivityType.DEPOSIT },
      accountTypeOf,
    );
    expect(deposit.categoryId).toBe("");
    const fee = applySpendingRules(
      draft,
      { ...draft, activityType: ActivityType.FEE },
      accountTypeOf,
    );
    expect(fee.categoryId).toBe("food");
  });
});

function payloadFor(rows: SpendingGridRow[]): SavePayloadResult {
  return {
    creates: rows
      .filter((r) => r.isNew)
      .map((r) => ({
        id: r.id,
        accountId: r.accountId,
        activityType: r.activityType,
        activityDate: "2026-10-01T12:00:00.000Z",
        subtype: r.subtype ?? undefined,
      })),
    updates: rows
      .filter((r) => !r.isNew)
      .map((r) => ({
        id: r.id,
        accountId: r.accountId,
        activityType: r.activityType,
        activityDate: "2026-10-01T12:00:00.000Z",
        subtype: r.subtype ?? "",
      })),
    deleteIds: [],
  };
}

describe("prepareSpendingPayload", () => {
  it("sends no activity update for a category-only change", () => {
    const original = row({ assignments: [assignment(SPENDING_TAXONOMY, "food")] });
    const edited = { ...original, categoryId: "rent" };
    const payload = prepareSpendingPayload(
      payloadFor([edited]),
      new Map<string, SpendingGridRow>([[edited.id, edited]]),
      new Map<string, SpendingGridRow>([[original.id, original]]),
    );
    expect(payload.updates).toEqual([]);
  });

  it("writes the form's flow metadata when a reimbursement changes type", () => {
    const original = row({
      activityType: "CREDIT",
      subtype: "REIMBURSEMENT",
      metadata: { flow: { is_external: true }, note: "kept" },
    });
    const edited = { ...original, activityType: ActivityType.WITHDRAWAL, subtype: undefined };
    const [update] = prepareSpendingPayload(
      payloadFor([edited]),
      new Map<string, SpendingGridRow>([[edited.id, edited]]),
      new Map<string, SpendingGridRow>([[original.id, original]]),
    ).updates;
    expect(JSON.parse(update.metadata ?? "{}")).toEqual({ note: "kept" });
  });

  it("marks a new reimbursement external and leaves transfers' metadata alone", () => {
    const original = row();
    const credit = { ...original, activityType: ActivityType.CREDIT, subtype: "REIMBURSEMENT" };
    const transferOriginal = row({
      id: "t1",
      activityType: "TRANSFER_OUT",
      metadata: { flow: { is_external: true } },
    });
    const transfer = { ...transferOriginal, amount: "40" };
    const payload = payloadFor([credit, transfer]);
    payload.updates[1].metadata = "unchanged";
    const { updates } = prepareSpendingPayload(
      payload,
      new Map<string, SpendingGridRow>([
        [credit.id, credit],
        [transfer.id, transfer],
      ]),
      new Map<string, SpendingGridRow>([
        [original.id, original],
        [transferOriginal.id, transferOriginal],
      ]),
    );
    expect(JSON.parse(updates[0].metadata ?? "{}")).toEqual({ flow: { is_external: true } });
    expect(updates[1].metadata).toBe("unchanged");
  });
});

describe("planCategoryWrites", () => {
  const outcome = (overrides: Partial<Parameters<typeof planCategoryWrites>[2]> = {}) => ({
    createdIds: new Map<string, string>(),
    failedIds: new Set<string>(),
    deletedIds: new Set<string>(),
    ...overrides,
  });

  it("assigns, clears, and maps created rows to their new ids", () => {
    const picked = { ...row({ id: "picked" }), categoryId: "rent" };
    const cleared = {
      ...row({ id: "cleared", assignments: [assignment(SPENDING_TAXONOMY, "food")] }),
      categoryId: "",
    };
    const income = { ...row({ id: "income", cashFlowBucket: "income" }), categoryId: "salary" };
    const draft = {
      ...createSpendingDraft(undefined, "USD"),
      accountId: "cash",
      categoryId: "food",
    };
    const writes = planCategoryWrites(
      [picked, cleared, income, draft],
      new Set(["picked", "cleared", "income", draft.id]),
      outcome({ createdIds: new Map([[draft.id, "saved-draft"]]) }),
      accountTypeOf,
    );
    expect(writes.assign).toEqual([
      { activityId: "picked", taxonomyId: SPENDING_TAXONOMY, categoryId: "rent" },
      { activityId: "income", taxonomyId: INCOME_TAXONOMY, categoryId: "salary" },
      { activityId: "saved-draft", taxonomyId: SPENDING_TAXONOMY, categoryId: "food" },
    ]);
    expect(writes.clear).toEqual([{ activityId: "cleared", taxonomyId: SPENDING_TAXONOMY }]);
  });

  it("writes nothing for rows the activity save rejected, deleted, or did not create", () => {
    const failed = { ...row({ id: "failed" }), categoryId: "rent" };
    const deleted = { ...row({ id: "deleted" }), categoryId: "rent" };
    const draft = {
      ...createSpendingDraft(undefined, "USD"),
      accountId: "cash",
      categoryId: "food",
    };
    const writes = planCategoryWrites(
      [failed, deleted, draft],
      new Set(["failed", "deleted", draft.id]),
      outcome({ failedIds: new Set(["failed"]), deletedIds: new Set(["deleted"]) }),
      accountTypeOf,
    );
    expect(writes).toEqual({ assign: [], clear: [] });
  });
});

describe("validateSpendingRows", () => {
  const messages = {
    typeNotForAccount: "type",
    amountNonNegative: "negative",
    amountRequired: "required",
  };

  it("checks the account's types, a new row's amount, and negative amounts", () => {
    const original = row({ accountId: "card" });
    const deposit = { ...original, activityType: ActivityType.DEPOSIT };
    const draft = { ...createSpendingDraft(undefined, "USD"), accountId: "cash" };
    const negative = { ...row({ id: "neg" }), amount: "-4" };
    const errors = validateSpendingRows(
      [deposit, draft, negative],
      new Set([deposit.id, draft.id, negative.id]),
      new Map<string, SpendingGridRow>([
        [original.id, original],
        [negative.id, row({ id: "neg" })],
      ]),
      accountTypeOf,
      messages,
    );
    expect(errors.map((error) => [error.transactionId, error.message])).toEqual([
      [deposit.id, "type"],
      [draft.id, "required"],
      ["neg", "negative"],
    ]);
  });

  it("does not flag a stored type the user left unchanged", () => {
    const original = row({ accountId: "card", activityType: "DEPOSIT" });
    const edited = { ...original, comment: "note" };
    expect(
      validateSpendingRows(
        [edited],
        new Set([edited.id]),
        new Map<string, SpendingGridRow>([[original.id, original]]),
        accountTypeOf,
        messages,
      ),
    ).toEqual([]);
  });
});

describe("duplicateSpendingRow", () => {
  it("copies a row as a new one, without its source identity", () => {
    const source = {
      ...row({
        sourceSystem: "PLAID",
        sourceRecordId: "rec",
        assignments: [assignment(SPENDING_TAXONOMY, "food")],
        metadata: { mapping_reasons: ["x"] },
      }),
    };
    const copy = duplicateSpendingRow(source, "CASH");
    expect(copy).toMatchObject({
      isNew: true,
      categoryId: "food",
      _originalCategoryId: "",
      sourceSystem: undefined,
      sourceRecordId: undefined,
      metadata: undefined,
    });
    expect(copy.id).not.toBe(source.id);
  });

  it("drops a category from another taxonomy than the copy's", () => {
    const saving = row({
      cashFlowBucket: "saving",
      assignments: [assignment(SAVINGS_TAXONOMY, "emergency")],
    });
    expect(duplicateSpendingRow(saving, "CASH").categoryId).toBe("");
  });
});
