import i18n, { createInstance } from "i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import zhAi from "@/i18n/locales/zh/ai.json";
import arAi from "@/i18n/locales/ar/ai.json";
import enAi from "@/i18n/locales/en/ai.json";
import zhSync from "@/i18n/locales/zh/sync.json";
import zhConnect from "@/i18n/locales/zh/connect.json";
import zhGoals from "@/i18n/locales/zh/goals.json";
import zhHealth from "@/i18n/locales/zh/health.json";
import zhActivity from "@/i18n/locales/zh/activity.json";
import { formatChatError, formatErrorMessage } from "./use-chat-runtime";
import {
  userFacingSyncErrorMessage,
  rawSyncErrorMessage,
} from "@/features/devices-sync/utils/error-messages";
import {
  getBrokerSyncIssueMessage,
  getBrokerSyncRunFailedMessage,
  getSpecificBrokerSyncIssueMessage,
} from "@/features/wealthfolio-connect/lib/broker-sync-messages";
import { highReturnWarning } from "@/features/goals/components/goal-lever-constants";
import { translateHealthAction } from "@/pages/health/translate-issue";

vi.mock("@/adapters", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/hooks", () => ({}));
vi.mock("../api", () => ({}));

beforeAll(() => {
  for (const [ns, resource] of Object.entries({
    ai: zhAi,
    sync: zhSync,
    connect: zhConnect,
    goals: zhGoals,
    health: zhHealth,
    activity: zhActivity,
  })) {
    i18n.addResourceBundle("zh", ns, resource, true, true);
  }
});
afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("localized built-in guidance and safe backend failures", () => {
  it.each([
    ["PROVIDER_RATE_LIMITED", "rateLimit"],
    ["PROVIDER_AUTH", "authentication"],
    ["PROVIDER_TIMEOUT", "timeout"],
  ] as const)(
    "translates the production provider code without consulting diagnostics (%s)",
    async (code, key) => {
      const translator = createInstance();
      await translator.init({
        lng: "en",
        resources: { en: { ai: enAi }, zh: { ai: zhAi }, ar: { ai: arAi } },
        interpolation: { escapeValue: false },
      });
      for (const language of ["en", "zh", "ar"]) {
        await translator.changeLanguage(language);
        const settingsLink = `[${translator.t("ai:runtimeErrors.settingsLink")}](/settings/ai-providers)`;
        const text = formatChatError(code, "FAKE-KEY-2531 /private/portfolio.db", translator.t);
        expect(text).toBe(translator.t(`ai:runtimeErrors.${key}`, { settingsLink }));
        expect(text).not.toContain("FAKE-KEY");
        expect(text).not.toContain("/private");
      }
    },
  );
  it.each([
    'Provider error with message: {"error":"FAKE-KEY-2531 /private/portfolio.db"}',
    '"FAKE-KEY-2531" does not support thinking',
    "model 'FAKE-KEY-2531' not found",
    "FAKE-KEY-2531 /private/portfolio.db",
  ])("does not interpolate sensitive provider diagnostics: %s", (message) => {
    const text = formatErrorMessage(message);
    expect(text).not.toContain("FAKE-KEY-2531");
    expect(text).not.toContain("/private");
  });
  it("translates AI guidance without displaying raw provider details", async () => {
    const translator = createInstance();
    await translator.init({
      lng: "zh",
      resources: { zh: { ai: zhAi }, en: { ai: enAi }, ar: { ai: arAi } },
      interpolation: { escapeValue: false },
    });
    const cases = [
      ['"Model-X" does not support thinking', "不支持思考模式"],
      ["model 'Model-X' not found", "模型不可用"],
      ["ECONNREFUSED", "无法连接 AI 提供方"],
      ["unauthorized 401", "身份验证失败"],
      ["429 rate limit", "请求过于频繁"],
      ["ETIMEDOUT", "请求超时"],
      ['Provider error with message: {"error":"Diagnostic XYZ"}', "提供方错误"],
      ["Diagnostic XYZ", "出现问题"],
    ];
    for (const [error, title] of cases) {
      expect(formatErrorMessage(error, translator.t)).toContain(`**${title}**`);
    }
    expect(formatErrorMessage(cases[0][0], translator.t)).not.toContain("Model-X");
    expect(formatErrorMessage(cases[0][0], translator.t)).toContain(
      "[AI 提供方设置](/settings/ai-providers)",
    );
    expect(formatErrorMessage(cases[6][0], translator.t)).not.toContain("Diagnostic XYZ");
    await translator.changeLanguage("ar");
    expect(formatErrorMessage("401", translator.t)).toContain("فشلت المصادقة");
    await translator.changeLanguage("en");
    expect(formatErrorMessage("429", translator.t)).toContain("**Rate limit exceeded**");
  });

  it("explains a chat too long for the model from its error code", async () => {
    const translator = createInstance();
    await translator.init({
      lng: "zh",
      resources: { zh: { ai: zhAi }, en: { ai: enAi } },
      interpolation: { escapeValue: false },
    });
    const overflow = formatChatError("CONTEXT_OVERFLOW", "prompt is too long", translator.t);
    expect(overflow).toContain("**对话过长**");
    expect(overflow).toContain("[AI 提供方设置](/settings/ai-providers)");
    expect(formatChatError("STREAM_ERROR", "429 rate limit", translator.t)).toContain(
      "**请求过于频繁**",
    );
  });

  it("uses the current language for sync messages and leaves logging details raw", async () => {
    const raw =
      'Portfolio "Family USD" contains a deleted account link. Open Settings > Portfolios.';
    await i18n.changeLanguage("zh");
    expect(userFacingSyncErrorMessage("invalid code")).toBe("代码无效，请检查后重试。");
    expect(userFacingSyncErrorMessage("sqlite constraint failed")).toBe(zhSync.errors.technical);
    expect(userFacingSyncErrorMessage(raw)).toContain("Family USD");
    expect(userFacingSyncErrorMessage(raw)).toContain("已删除账户");
    expect(rawSyncErrorMessage(new Error(raw))).toBe(raw);
    expect(userFacingSyncErrorMessage("unrecognized diagnostic", "custom fallback")).toBe(
      "custom fallback",
    );
    expect(userFacingSyncErrorMessage(null)).toBe(zhSync.errors.fallback);
    await i18n.changeLanguage("en");
    expect(userFacingSyncErrorMessage("invalid code")).toBe("Invalid code. Check and try again.");
  });

  it("localizes broker summaries on demand without altering partial-failure matching", async () => {
    await i18n.changeLanguage("zh");
    expect(getBrokerSyncRunFailedMessage()).toBe(zhConnect.syncMessages.runFailed);
    expect(getBrokerSyncIssueMessage("FAILED", null)).toBe(zhConnect.syncMessages.accountFailed);
    expect(getBrokerSyncIssueMessage("NEEDS_REVIEW", "holdings synced; activities failed")).toBe(
      zhConnect.syncMessages.holdingsSynced,
    );
    expect(getSpecificBrokerSyncIssueMessage("HOLDINGS SYNC DEFERRED: diagnostics")).toBe(
      zhConnect.syncMessages.holdingsDeferred,
    );
    expect(getSpecificBrokerSyncIssueMessage("unknown raw provider error")).toBeNull();
    await i18n.changeLanguage("en");
    expect(getBrokerSyncRunFailedMessage()).toContain("This sync run couldn't be completed");
  });

  it("keeps goal thresholds and health action payloads unchanged", async () => {
    await i18n.changeLanguage("zh");
    expect(highReturnWarning(0.12)).toBeUndefined();
    expect(highReturnWarning(0.121)).toBe(zhGoals.save_up.highReturnWarning);
    const action = {
      id: "rebuild_account_history",
      label: "Rebuild History",
      payload: ["account-1"],
    };
    const before = structuredClone(action);
    expect(translateHealthAction(i18n.t, action)).toBe("重建历史");
    expect(action).toEqual(before);
    const navigation = { route: "/holdings/asset-1", label: "Add Price", query: { tab: "quotes" } };
    expect(translateHealthAction(i18n.t, navigation)).toBe("添加价格");
    expect(navigation.route).toBe("/holdings/asset-1");
    expect(
      translateHealthAction(i18n.t, {
        ...navigation,
        label: "Update Value",
        query: { tab: "history" },
      }),
    ).toBe("更新估值");
    const snapshot = {
      route: "/accounts/account-1",
      label: "Review entry",
      query: { tab: "snapshots", healthContext: "invalidSnapshot", snapshotId: "record-1" },
    };
    const originalSnapshot = structuredClone(snapshot);
    expect(translateHealthAction(i18n.t, snapshot)).toBe("查看记录");
    expect(snapshot).toEqual(originalSnapshot);
    expect(translateHealthAction(i18n.t, { ...snapshot, query: { tab: "snapshots" } })).toBe(
      "Review entry",
    );
    expect(translateHealthAction(i18n.t, { ...snapshot, route: "/accounts/a/custom" })).toBe(
      "Review entry",
    );
    expect(translateHealthAction(i18n.t, { route: "/custom", label: "Custom Name" })).toBe(
      "Custom Name",
    );
    expect(
      translateHealthAction(i18n.t, { id: "future_action", label: "Future label", payload: null }),
    ).toBe("Future label");
  });
});
