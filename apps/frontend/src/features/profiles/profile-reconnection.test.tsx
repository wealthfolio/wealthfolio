import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { ProfileShell } from "./profile-shell";
import { matchesProfileScope, profileFetch, profileScope } from "./session";

const mocks = vi.hoisted(() => ({ command: vi.fn(), reload: vi.fn() }));
vi.mock("@/adapters", () => ({
  isWeb: true,
  listenPortfolioUpdateStart: async () => () => {},
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  profileCommand: mocks.command,
  profileChangesChannel: new EventTarget(),
}));
vi.mock("./auth-bridge", () => ({ isNativeAuthPending: () => false }));
vi.mock("@/lib/reload-application", () => ({ reloadApplication: mocks.reload }));

it("preserves authority through an outage but revokes it when a remounted shell confirms expiry", async () => {
  const active = {
    profiles: [{ id: "a", name: "Personal", avatarId: "clay-pebble-animated", lockEnabled: true }],
    session: { profileId: "a", scopeId: "original-grant" },
    starting: false,
  };
  mocks.command.mockResolvedValue(active);
  const queries = new QueryClient();
  const mount = () =>
    render(
      <QueryClientProvider client={queries}>
        <ProfileShell>
          <div>Private portfolio</div>
          <input aria-label="Unsubmitted edit" />
        </ProfileShell>
      </QueryClientProvider>,
    );
  const view = mount();
  await screen.findByText("Private portfolio");
  fireEvent.change(screen.getByLabelText("Unsubmitted edit"), { target: { value: "draft" } });
  mocks.command.mockRejectedValue(new TypeError("Failed to fetch"));
  await act(async () => window.dispatchEvent(new Event("wealthfolio:event-stream-error")));
  expect(screen.getByText("Private portfolio")).toBeInTheDocument();
  expect(profileScope()).toBe("original-grant");
  mocks.command.mockResolvedValue(active);
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(screen.getByText("Private portfolio")).toBeInTheDocument();
  expect(mocks.reload).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Unsubmitted edit")).toHaveValue("draft");

  let complete!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    ),
  );
  const pending = profileFetch("/api/v1/accounts");
  try {
    queries.setQueryData(["accounts"], "synthetic cached value");
    // AuthGate unmounts this shell during instance authentication checks.
    // Session authority and QueryClient outlive the component.
    view.unmount();
    mocks.command.mockResolvedValue({ ...active, session: null });
    mount();
    await screen.findByRole("heading", { name: "Who's using Wealthfolio?" });
    expect(screen.queryByText("Private portfolio")).not.toBeInTheDocument();
    expect(() => profileScope()).toThrow("PROFILE_LOCKED");
    expect(matchesProfileScope("original-grant")).toBe(false);
    expect(queries.getQueryData(["accounts"])).toBeUndefined();
    complete(new Response("private data"));
    await expect(pending).rejects.toThrow("PROFILE_LOCKED");
    expect(mocks.command).not.toHaveBeenCalledWith("lock_profile", expect.anything());
    // Rechecking an already-revoked grant must not repeatedly reset the unlock form.
    fireEvent.click(screen.getByRole("button", { name: "Personal" }));
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "unfinished password" },
    });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(screen.getByLabelText("Password")).toHaveValue("unfinished password");
  } finally {
    vi.unstubAllGlobals();
  }
});
