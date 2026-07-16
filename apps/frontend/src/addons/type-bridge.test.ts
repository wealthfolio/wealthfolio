// @vitest-environment node

import { vi, describe, it, expect } from "vitest";
import { createPermissionGuard, createSDKHostAPIBridge, type InternalHostAPI } from "./type-bridge";
import { isBaselineCategory } from "@wealthfolio/addon-sdk";

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
  });
});
