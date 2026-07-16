import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AddonRuntimeLoader } from "./addon-runtime-loader";

const authMock = vi.hoisted(() => ({
  state: {
    isAuthenticated: false,
    statusLoading: false,
  },
}));

const addonLoaderMock = vi.hoisted(() => ({
  loadAllAddons: vi.fn(),
}));

vi.mock("@/context/auth-context", () => ({
  useAuth: () => authMock.state,
}));

vi.mock("./addons-loader", () => ({
  loadAllAddons: addonLoaderMock.loadAllAddons,
}));

describe("AddonRuntimeLoader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.state = {
      isAuthenticated: false,
      statusLoading: false,
    };
    addonLoaderMock.loadAllAddons.mockResolvedValue(undefined);
  });

  it("loads once after auth status resolves and authentication is ready", async () => {
    const { rerender } = render(<AddonRuntimeLoader />);

    expect(addonLoaderMock.loadAllAddons).not.toHaveBeenCalled();

    authMock.state = {
      isAuthenticated: true,
      statusLoading: true,
    };
    rerender(<AddonRuntimeLoader />);

    expect(addonLoaderMock.loadAllAddons).not.toHaveBeenCalled();

    authMock.state = {
      isAuthenticated: false,
      statusLoading: false,
    };
    rerender(<AddonRuntimeLoader />);

    expect(addonLoaderMock.loadAllAddons).not.toHaveBeenCalled();

    authMock.state = {
      isAuthenticated: true,
      statusLoading: false,
    };
    rerender(<AddonRuntimeLoader />);

    await waitFor(() => {
      expect(addonLoaderMock.loadAllAddons).toHaveBeenCalledTimes(1);
    });

    authMock.state = {
      isAuthenticated: true,
      statusLoading: false,
    };
    rerender(<AddonRuntimeLoader />);

    expect(addonLoaderMock.loadAllAddons).toHaveBeenCalledTimes(1);
  });
});
