import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { Activity } from "react";
import { expect, it, vi } from "vitest";
import { AuditLogTable } from "./audit-log-table";

const mocks = vi.hoisted(() => ({ purge: vi.fn<() => Promise<number>>() }));
vi.mock("../hooks/use-access-tokens", () => ({ useAccessTokens: () => ({ tokens: [] }) }));
vi.mock("../hooks/use-agent-audit", () => ({
  useAgentAudit: () => ({
    items: [
      {
        id: "entry-1",
        createdAt: "2026-10-01T12:00:00Z",
        toolName: "get_holdings",
        outcome: "success",
        actorKind: "pat",
      },
    ],
    totalCount: 60,
    availableTools: ["get_holdings"],
    isLoading: false,
    purgeMutation: useMutation({ mutationFn: mocks.purge }),
  }),
}));

it("goes back to the first page once a purge ends while the screen is out of sight", async () => {
  // On a phone, a screen kept under another one is a hidden <Activity>.
  let finish: () => void = () => undefined;
  mocks.purge.mockReturnValue(new Promise<number>((resolve) => (finish = () => resolve(60))));
  const client = new QueryClient();
  const view = (hidden: boolean) => (
    <QueryClientProvider client={client}>
      <Activity mode={hidden ? "hidden" : "visible"}>
        <AuditLogTable />
      </Activity>
    </QueryClientProvider>
  );
  const purgeStatus = () => client.getMutationCache().getAll()[0]?.state.status;
  const { rerender } = render(view(false));
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  expect(screen.getByText(/^Page 3 of 3/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear log" }));
  // The open prompt hides the page behind it, so this finds the prompt's button.
  fireEvent.click(await screen.findByRole("button", { name: "Clear log" }));
  await waitFor(() => expect(purgeStatus()).toBe("pending"));

  rerender(view(true));
  act(() => finish());
  await waitFor(() => expect(purgeStatus()).toBe("success"));
  rerender(view(false));

  await waitFor(() => expect(screen.getByText(/^Page 1 of 3/)).toBeInTheDocument());
});
