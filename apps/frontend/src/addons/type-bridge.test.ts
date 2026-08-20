// @vitest-environment node

import { vi, describe, it, expect } from "vitest";
import { createPermissionGuard, createSDKHostAPIBridge, type InternalHostAPI } from "./type-bridge";
import { getPermissionCategory, isBaselineCategory } from "@wealthfolio/addon-sdk";
import type { InternalTransferPairRequest } from "@wealthfolio/addon-sdk";

describe("Addon Type Bridge", () => {
  describe("createSDKHostAPIBridge", () => {
    it("should create logger with addon prefix", () => {
      // Mock the internal API logger functions
      const mockLogError = vi.fn();
      const mockLogInfo = vi.fn();
      const mockLogWarn = vi.fn();
      const mockLogTrace = vi.fn();
      const mockLogDebug = vi.fn();

      // Create a minimal mock internal API with just the logger functions
      const mockInternalAPI: Partial<InternalHostAPI> = {
        logError: mockLogError,
        logInfo: mockLogInfo,
        logWarn: mockLogWarn,
        logTrace: mockLogTrace,
        logDebug: mockLogDebug,
      };

      // Create the SDK bridge with a test addon ID
      const sdkAPI = createSDKHostAPIBridge(mockInternalAPI as InternalHostAPI, "test-addon");

      // Test that logger methods add the addon prefix
      sdkAPI.logger.error("test error message");
      sdkAPI.logger.info("test info message");
      sdkAPI.logger.warn("test warning message");
      sdkAPI.logger.trace("test trace message");
      sdkAPI.logger.debug("test debug message");

      // Verify the logger functions were called with prefixed messages
      expect(mockLogError).toHaveBeenCalledWith("[test-addon] test error message");
      expect(mockLogInfo).toHaveBeenCalledWith("[test-addon] test info message");
      expect(mockLogWarn).toHaveBeenCalledWith("[test-addon] test warning message");
      expect(mockLogTrace).toHaveBeenCalledWith("[test-addon] test trace message");
      expect(mockLogDebug).toHaveBeenCalledWith("[test-addon] test debug message");
    });

    it("should use default addon ID when none provided", () => {
      const mockLogInfo = vi.fn();

      const mockInternalAPI: Partial<InternalHostAPI> = {
        logInfo: mockLogInfo,
      };

      // Create the SDK bridge without addon ID
      const sdkAPI = createSDKHostAPIBridge(mockInternalAPI as InternalHostAPI);

      sdkAPI.logger.info("test message");

      // Should use default addon ID
      expect(mockLogInfo).toHaveBeenCalledWith("[unknown-addon] test message");
    });

    it("should handle empty addon ID", () => {
      const mockLogInfo = vi.fn();

      const mockInternalAPI: Partial<InternalHostAPI> = {
        logInfo: mockLogInfo,
      };

      // Create the SDK bridge with empty addon ID
      const sdkAPI = createSDKHostAPIBridge(mockInternalAPI as InternalHostAPI, "");

      sdkAPI.logger.info("test message");

      // Should fallback to default addon ID for empty string
      expect(mockLogInfo).toHaveBeenCalledWith("[unknown-addon] test message");
    });

    it("should enforce granted function permissions", () => {
      const mockGetHoldings = vi.fn();
      const mockUpdateSettings = vi.fn();
      const guard = createPermissionGuard("test-addon", [
        {
          category: "portfolio",
          purpose: "Portfolio access",
          functions: [{ name: "getHoldings", isDeclared: true, isDetected: false }],
        },
      ]);

      const sdkAPI = createSDKHostAPIBridge(
        {
          getHoldings: mockGetHoldings,
          updateSettings: mockUpdateSettings,
          logError: vi.fn(),
          logInfo: vi.fn(),
          logWarn: vi.fn(),
          logTrace: vi.fn(),
          logDebug: vi.fn(),
        } as unknown as InternalHostAPI,
        "test-addon",
        guard,
      );

      sdkAPI.portfolio.getHoldings("account-1");

      expect(mockGetHoldings).toHaveBeenCalledWith("account-1");
      expect(() => sdkAPI.settings.update({})).toThrow(
        "Addon 'test-addon' is not allowed to call settings.update",
      );
    });

    it("should guard and forward historical exchange-rate lookups", async () => {
      const getExchangeRatesForDates = vi.fn().mockResolvedValue([]);
      const guard = createPermissionGuard("test-addon", [
        {
          category: "currency",
          purpose: "Historical exchange rates",
          functions: [{ name: "getRatesForDates", isDeclared: true, isDetected: false }],
        },
      ]);
      const sdkAPI = createSDKHostAPIBridge(
        {
          getExchangeRatesForDates,
          logError: vi.fn(),
          logInfo: vi.fn(),
          logWarn: vi.fn(),
          logTrace: vi.fn(),
          logDebug: vi.fn(),
        } as unknown as InternalHostAPI,
        "test-addon",
        guard,
      );
      const pairs = [{ fromCurrency: "USD", toCurrency: "EUR", date: "2026-05-18" }];

      await sdkAPI.exchangeRates.getRatesForDates(pairs);

      expect(getExchangeRatesForDates).toHaveBeenCalledWith(pairs);
    });

    it("registers historical exchange-rate lookups in currency permissions", () => {
      expect(getPermissionCategory("currency")?.functions).toContain("getRatesForDates");
    });

    it("should not grant detected-only function permissions", () => {
      const guard = createPermissionGuard("test-addon", [
        {
          category: "secrets",
          purpose: "Secrets access",
          functions: [{ name: "use", isDeclared: false, isDetected: true }],
        },
      ]);

      expect(guard.canUse("secrets", "use")).toBe(false);
      expect(() => guard.assertCanUse("secrets", "use")).toThrow(
        "Addon 'test-addon' is not allowed to call secrets.use",
      );
    });

    it("marks permission denials with a distinguishable error name", () => {
      const guard = createPermissionGuard("test-addon", []);

      try {
        guard.assertCanUse("currency", "getAll");
        expect.unreachable("assertCanUse should throw");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe("AddonPermissionDenied");
      }
    });

    it("treats ui/query and other baseline capabilities as baseline categories", () => {
      expect(isBaselineCategory("ui")).toBe(true);
      expect(isBaselineCategory("query")).toBe(true);
      expect(isBaselineCategory("toast")).toBe(true);
      expect(isBaselineCategory("logger")).toBe(true);
      expect(isBaselineCategory("storage")).toBe(true);
      expect(isBaselineCategory("accounts")).toBe(false);
    });

    it("allows baseline capabilities without any declared permission", () => {
      const guard = createPermissionGuard("test-addon", []);

      // Baseline categories are implicit — allowed with no declaration and never throw.
      expect(guard.canUse("ui", "sidebar.addItem")).toBe(true);
      expect(guard.canUse("ui", "router.add")).toBe(true);
      expect(guard.canUse("ui", "navigation.navigate")).toBe(true);
      expect(guard.canUse("query", "invalidateQueries")).toBe(true);
      expect(guard.canUse("query", "refetchQueries")).toBe(true);
      expect(() => guard.assertCanUse("ui", "sidebar.addItem")).not.toThrow();
      expect(() => guard.assertCanUse("query", "invalidateQueries")).not.toThrow();
    });

    it("still allows baseline capabilities even when a legacy manifest declares them", () => {
      const guard = createPermissionGuard("test-addon", [
        {
          category: "ui",
          purpose: "Navigation",
          functions: ["sidebar.addItem", "router.add"],
        },
      ] as unknown as Parameters<typeof createPermissionGuard>[1]);

      expect(guard.canUse("ui", "sidebar.addItem")).toBe(true);
      expect(guard.canUse("ui", "router.add")).toBe(true);
      expect(guard.canUse("ui", "navigation.navigate")).toBe(true);
    });

    it("should not expose the raw QueryClient", () => {
      const sdkAPI = createSDKHostAPIBridge(
        {
          logError: vi.fn(),
          logInfo: vi.fn(),
          logWarn: vi.fn(),
          logTrace: vi.fn(),
          logDebug: vi.fn(),
        } as unknown as InternalHostAPI,
        "test-addon",
      );

      expect(() => sdkAPI.query.getClient()).toThrow(
        "Direct QueryClient access is not available to addons",
      );
    });

    it("should require secrets.use for network auth injection", async () => {
      const mockAddonNetworkRequest = vi.fn();
      const networkOnlyGuard = createPermissionGuard("test-addon", [
        {
          category: "network",
          purpose: "Network access",
          functions: [{ name: "request", isDeclared: true, isDetected: false }],
        },
      ]);

      const networkOnlyAPI = createSDKHostAPIBridge(
        {
          addonNetworkRequest: mockAddonNetworkRequest,
          logError: vi.fn(),
          logInfo: vi.fn(),
          logWarn: vi.fn(),
          logTrace: vi.fn(),
          logDebug: vi.fn(),
        } as unknown as InternalHostAPI,
        "test-addon",
        networkOnlyGuard,
      );

      expect(() =>
        networkOnlyAPI.network.request({
          url: "https://api.example.com/v1",
          auth: { type: "bearer", secretKey: "api-token" },
        }),
      ).toThrow("Addon 'test-addon' is not allowed to call secrets.use");
      expect(mockAddonNetworkRequest).not.toHaveBeenCalled();

      const authGuard = createPermissionGuard("test-addon", [
        {
          category: "network",
          purpose: "Network access",
          functions: [{ name: "request", isDeclared: true, isDetected: false }],
        },
        {
          category: "secrets",
          purpose: "Use network secrets",
          functions: [{ name: "use", isDeclared: true, isDetected: false }],
        },
      ]);
      const authAPI = createSDKHostAPIBridge(
        {
          addonNetworkRequest: mockAddonNetworkRequest,
          logError: vi.fn(),
          logInfo: vi.fn(),
          logWarn: vi.fn(),
          logTrace: vi.fn(),
          logDebug: vi.fn(),
        } as unknown as InternalHostAPI,
        "test-addon",
        authGuard,
      );

      await authAPI.network.request({
        url: "https://api.example.com/v1",
        auth: { type: "bearer", secretKey: "api-token" },
      });

      expect(mockAddonNetworkRequest).toHaveBeenCalledWith({
        url: "https://api.example.com/v1",
        auth: { type: "bearer", secretKey: "api-token" },
      });
    });

    it("wires activities.* transfer methods to their internal implementations", () => {
      const mockGetTransferPair = vi.fn().mockResolvedValue({ transferOut: {}, transferIn: {} });
      const mockFindCandidates = vi.fn().mockResolvedValue([]);
      const mockSaveTransferPair = vi.fn().mockResolvedValue({ transferOut: {}, transferIn: {} });
      const mockLinkTransfer = vi.fn().mockResolvedValue([{}, {}]);
      const mockUnlinkTransfer = vi.fn().mockResolvedValue([{}, {}]);

      const guard = createPermissionGuard("test-addon", [
        {
          category: "activities",
          purpose: "Transfer matching",
          functions: [
            { name: "getTransferPair", isDeclared: true, isDetected: false },
            { name: "findTransferMatchCandidates", isDeclared: true, isDetected: false },
            { name: "saveTransferPair", isDeclared: true, isDetected: false },
            { name: "linkTransfer", isDeclared: true, isDetected: false },
            { name: "unlinkTransfer", isDeclared: true, isDetected: false },
          ],
        },
      ]);

      const sdkAPI = createSDKHostAPIBridge(
        {
          getTransferPairForActivity: mockGetTransferPair,
          findTransferMatchCandidates: mockFindCandidates,
          saveInternalTransferPair: mockSaveTransferPair,
          linkTransferActivities: mockLinkTransfer,
          unlinkTransferActivities: mockUnlinkTransfer,
          logError: vi.fn(),
          logInfo: vi.fn(),
          logWarn: vi.fn(),
          logTrace: vi.fn(),
          logDebug: vi.fn(),
        } as unknown as InternalHostAPI,
        "test-addon",
        guard,
      );

      sdkAPI.activities.getTransferPair("activity-1");
      expect(mockGetTransferPair).toHaveBeenCalledWith("activity-1");

      sdkAPI.activities.findTransferMatchCandidates({ activityId: "activity-1" });
      expect(mockFindCandidates).toHaveBeenCalledWith({ activityId: "activity-1" });

      const request = {
        fromAccountId: "acct-a",
        toAccountId: "acct-b",
        activityDate: "2026-01-01",
        sourceAmount: 100,
        destinationAmount: 100,
        sourceCurrency: "USD",
        destinationCurrency: "USD",
      };
      sdkAPI.activities.saveTransferPair(request);
      expect(mockSaveTransferPair).toHaveBeenCalledWith(request);

      sdkAPI.activities.linkTransfer("activity-a", "activity-b");
      expect(mockLinkTransfer).toHaveBeenCalledWith("activity-a", "activity-b");

      sdkAPI.activities.unlinkTransfer("activity-a", "activity-b");
      expect(mockUnlinkTransfer).toHaveBeenCalledWith("activity-a", "activity-b");
    });

    it("passes a null transfer pair through to the addon unchanged", async () => {
      const mockGetTransferPair = vi.fn().mockResolvedValue(null);

      const guard = createPermissionGuard("test-addon", [
        {
          category: "activities",
          purpose: "Transfer matching",
          functions: [{ name: "getTransferPair", isDeclared: true, isDetected: false }],
        },
      ]);

      const sdkAPI = createSDKHostAPIBridge(
        {
          getTransferPairForActivity: mockGetTransferPair,
          logError: vi.fn(),
          logInfo: vi.fn(),
          logWarn: vi.fn(),
          logTrace: vi.fn(),
          logDebug: vi.fn(),
        } as unknown as InternalHostAPI,
        "test-addon",
        guard,
      );

      await expect(sdkAPI.activities.getTransferPair("activity-1")).resolves.toBeNull();
    });

    it("rejects a half-specified transfer pair update at compile time", () => {
      const legs = {
        fromAccountId: "acct-a",
        toAccountId: "acct-b",
        activityDate: "2026-01-01",
        sourceAmount: 100,
        destinationAmount: 100,
        sourceCurrency: "USD",
        destinationCurrency: "USD",
      };

      const create: InternalTransferPairRequest = legs;
      const update: InternalTransferPairRequest = {
        ...legs,
        transferOutId: "activity-out",
        transferInId: "activity-in",
      };

      // @ts-expect-error naming one leg without the other matches neither variant
      const partial: InternalTransferPairRequest = { ...legs, transferOutId: "activity-out" };

      expect([create, update, partial]).toHaveLength(3);
    });

    it("denies activities.* transfer methods without the activities permission", () => {
      const guard = createPermissionGuard("test-addon", []);

      const sdkAPI = createSDKHostAPIBridge(
        {
          getTransferPairForActivity: vi.fn(),
          findTransferMatchCandidates: vi.fn(),
          saveInternalTransferPair: vi.fn(),
          linkTransferActivities: vi.fn(),
          unlinkTransferActivities: vi.fn(),
          logError: vi.fn(),
          logInfo: vi.fn(),
          logWarn: vi.fn(),
          logTrace: vi.fn(),
          logDebug: vi.fn(),
        } as unknown as InternalHostAPI,
        "test-addon",
        guard,
      );

      expect(() => sdkAPI.activities.getTransferPair("activity-1")).toThrow(
        "Addon 'test-addon' is not allowed to call activities.getTransferPair",
      );
      expect(() => sdkAPI.activities.linkTransfer("activity-a", "activity-b")).toThrow(
        "Addon 'test-addon' is not allowed to call activities.linkTransfer",
      );
    });
  });
});
