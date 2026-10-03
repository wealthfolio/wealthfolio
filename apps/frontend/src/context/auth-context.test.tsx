import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { reloadApplication } from "@/lib/reload-application";
import { notifyUnauthorized } from "@/lib/auth-token";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { revokeProfileSession, hasProfileSession } from "@/features/profiles/session";
import { LoginPage } from "@/pages/auth/login-page";
import { AuthGate, AuthProvider } from "./auth-context";

vi.mock("@/lib/reload-application", () => ({ reloadApplication: vi.fn() }));
vi.mock("@/adapters", () => ({ isWeb: true }));
vi.mock("@/features/profiles/session", () => ({
  revokeProfileSession: vi.fn(),
  hasProfileSession: vi.fn(),
}));
const fetchMock = vi.fn<typeof fetch>();
const status = (requiresPassword = true) => Response.json({ requiresPassword, oidcEnabled: false });
const mount = (queries = new QueryClient(), fallback = <div>Sign in</div>) =>
  render(
    <QueryClientProvider client={queries}>
      <AuthProvider>
        <AuthGate fallback={fallback}>
          <div>Private portfolio</div>
        </AuthGate>
      </AuthProvider>
    </QueryClientProvider>,
  );
beforeEach(() => {
  fetchMock.mockReset();
  vi.mocked(reloadApplication).mockClear();
  vi.mocked(revokeProfileSession).mockClear();
  vi.mocked(hasProfileSession).mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(["network", "server", "invalid JSON"])(
  "keeps financial content hidden when auth discovery fails: %s",
  async (failure) => {
    if (failure === "network") fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    else if (failure === "server") fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    else fetchMock.mockResolvedValue(Response.json({}));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
    expect(screen.queryByText("Private portfolio")).not.toBeInTheDocument();
    expect(screen.queryByText("Sign in")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reloadApplication).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  },
);

it("shows login only when the session check confirms a 401", async () => {
  fetchMock
    .mockResolvedValueOnce(status())
    .mockResolvedValueOnce(new Response(null, { status: 401 }));
  mount();
  expect(await screen.findByText("Sign in")).toBeInTheDocument();
  expect(screen.queryByText("Private portfolio")).not.toBeInTheDocument();
});

it("keeps a session check server failure recoverable without routing to login", async () => {
  fetchMock
    .mockResolvedValueOnce(status())
    .mockResolvedValueOnce(new Response(null, { status: 500 }));
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
  expect(screen.queryByText("Sign in")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(reloadApplication).toHaveBeenCalledOnce();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it.each(["status", "me"])(
  "does not accept proxy HTML as a successful %s response",
  async (endpoint) => {
    if (endpoint === "me") fetchMock.mockResolvedValueOnce(status());
    fetchMock.mockResolvedValueOnce(
      new Response("<html>Proxy sign in</html>", {
        headers: { "Content-Type": "text/html" },
      }),
    );
    mount();
    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("Private portfolio")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(reloadApplication).toHaveBeenCalledOnce();
  },
);

it("requires manual recovery when auth requirements may have changed", async () => {
  fetchMock.mockResolvedValueOnce(status(false));
  mount();
  await screen.findByText("Private portfolio");
  act(() => notifyUnauthorized());
  expect(screen.queryByText("Private portfolio")).not.toBeInTheDocument();
  expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("returns an expired instance session to login without another auth check", async () => {
  fetchMock
    .mockResolvedValueOnce(status())
    .mockResolvedValueOnce(Response.json({ authenticated: true }));
  mount();
  await screen.findByText("Private portfolio");
  act(() => notifyUnauthorized());
  expect(await screen.findByText("Sign in")).toBeInTheDocument();
  expect(screen.queryByText("Private portfolio")).not.toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("keeps the login form intact when another request reports expiry", async () => {
  fetchMock
    .mockResolvedValueOnce(status())
    .mockResolvedValueOnce(new Response(null, { status: 401 }));
  mount(undefined, <LoginPage />);
  const input = await screen.findByTestId("login-password-input");
  fireEvent.change(input, { target: { value: "synthetic-password" } });
  act(() => notifyUnauthorized());
  expect(screen.getByTestId("login-password-input")).toHaveValue("synthetic-password");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("does not start a competing auth check when expiry is reported during login", async () => {
  fetchMock
    .mockResolvedValueOnce(status())
    .mockResolvedValueOnce(new Response(null, { status: 401 }));
  mount(undefined, <LoginPage />);
  const input = await screen.findByTestId("login-password-input");
  fireEvent.change(input, { target: { value: "synthetic-password" } });
  let resolveLogin!: (response: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveLogin = resolve;
      }),
  );
  fireEvent.submit(input.closest("form")!);
  act(() => notifyUnauthorized());
  expect(fetchMock).toHaveBeenCalledTimes(3);
  await act(async () => resolveLogin(Response.json({ authenticated: true })));
  expect(screen.getByText("Private portfolio")).toBeInTheDocument();
});

it("treats a proxy 524 HTML error as a connection failure", async () => {
  fetchMock.mockResolvedValue(
    new Response("<html>Timeout</html>", {
      status: 524,
      headers: { "Content-Type": "text/html" },
    }),
  );
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
  expect(revokeProfileSession).not.toHaveBeenCalled();
});

it("accepts valid authentication JSON after a redirect", async () => {
  const response = status(false);
  Object.defineProperty(response, "redirected", { value: true });
  fetchMock.mockResolvedValueOnce(response);
  mount();
  expect(await screen.findByText("Private portfolio")).toBeInTheDocument();
});

it.each([502, 524])("keeps a redirected %s response a connection error", async (code) => {
  const response = new Response("<html>Unavailable</html>", {
    status: code,
    headers: { "Content-Type": "text/html" },
  });
  Object.defineProperty(response, "redirected", { value: true });
  fetchMock.mockResolvedValueOnce(response);
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
  expect(revokeProfileSession).not.toHaveBeenCalled();
  expect(revokeProfileSession).not.toHaveBeenCalled();
});

it("treats a redirected 401 as confirmed expiry", async () => {
  const response = new Response(null, { status: 401 });
  Object.defineProperty(response, "redirected", { value: true });
  fetchMock.mockResolvedValueOnce(status()).mockResolvedValueOnce(response);
  vi.mocked(hasProfileSession).mockReturnValue(true);
  mount();
  expect(await screen.findByText("Sign in")).toBeInTheDocument();
  expect(revokeProfileSession).toHaveBeenCalledOnce();
});

it("does not admit a successful session response with the wrong body", async () => {
  fetchMock.mockResolvedValueOnce(status()).mockResolvedValueOnce(Response.json({}));
  mount();
  expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
  expect(screen.queryByText("Private portfolio")).not.toBeInTheDocument();
});

it("clears profile authority and cached queries on confirmed instance expiry while the gate is unmounted", async () => {
  const queries = new QueryClient();
  vi.mocked(hasProfileSession).mockReturnValue(true);
  queries.setQueryData(["accounts"], "synthetic cached value");
  fetchMock
    .mockResolvedValueOnce(status())
    .mockResolvedValueOnce(new Response(null, { status: 401 }));
  mount(queries);
  expect(await screen.findByText("Sign in")).toBeInTheDocument();
  expect(revokeProfileSession).toHaveBeenCalledOnce();
  expect(queries.getQueryData(["accounts"])).toBeUndefined();
});

it("does not revoke a never-admitted profile on the first sign-in", async () => {
  fetchMock
    .mockResolvedValueOnce(status())
    .mockResolvedValueOnce(new Response(null, { status: 401 }));
  mount();
  await screen.findByText("Sign in");
  expect(revokeProfileSession).not.toHaveBeenCalled();
});

it("revokes immediately on confirmed expiry without rechecking authentication", async () => {
  const queries = new QueryClient();
  fetchMock.mockResolvedValueOnce(status(false));
  mount(queries);
  await screen.findByText("Private portfolio");
  vi.mocked(hasProfileSession).mockReturnValue(true);
  queries.setQueryData(["accounts"], "synthetic cached value");
  act(() => notifyUnauthorized());
  expect(revokeProfileSession).toHaveBeenCalledOnce();
  expect(queries.getQueryData(["accounts"])).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("retains profile authority and cached queries when a proxy requires navigation without confirming expiry", async () => {
  const queries = new QueryClient();
  fetchMock.mockResolvedValueOnce(status(false));
  mount(queries);
  await screen.findByText("Private portfolio");
  vi.mocked(hasProfileSession).mockReturnValue(true);
  queries.setQueryData(["accounts"], "synthetic cached value");
  act(() => notifyUnauthorized("signIn"));
  await screen.findByRole("button", { name: "Retry" });
  expect(revokeProfileSession).not.toHaveBeenCalled();
  expect(queries.getQueryData(["accounts"])).toBe("synthetic cached value");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("Private portfolio")).not.toBeInTheDocument();
});
