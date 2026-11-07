import { installProfileSession } from "@/features/profiles/session";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "./core";

beforeEach(() => {
  installProfileSession({ profileId: "test", scopeId: "scope-test" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const stubFetch = () => {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
    new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

it.each([
  [undefined, "/api/v1/activities/suppressed"],
  [[], "/api/v1/activities/suppressed?accountIds="],
  [["acc-1", "acc-2"], "/api/v1/activities/suppressed?accountIds=acc-1%2Cacc-2"],
])("lists suppressed activities for account filter %j", async (accountIds, expected) => {
  const fetchMock = stubFetch();
  await invoke("list_suppressed_activities", { accountIds });
  expect(fetchMock.mock.calls[0][0]).toBe(expected);
});
