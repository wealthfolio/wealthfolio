import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { installProfileSession } from "@/features/profiles/session";
import { parseCsv } from "./activities";
import { invoke } from "./core";

beforeEach(() => {
  installProfileSession({ profileId: "test", scopeId: "scope-test" });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("bounds multipart CSV parsing without changing its content or profile scope", async () => {
  installProfileSession({ profileId: "test", scopeId: "scope-test" });
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ headers: ["date"] })));
  vi.stubGlobal("fetch", fetch);
  const file = new File(["date\n2026-01-01"], "transactions.csv", { type: "text/csv" });
  const config = { delimiter: ",", hasHeaderRow: true, skipTopRows: 0 };
  await expect(parseCsv(file, config)).resolves.toEqual({ headers: ["date"] });
  expect(timeout).toHaveBeenCalledWith(300_000);
  const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
  expect(url).toBe("/api/v1/activities/import/parse");
  expect(init.signal).toBe(deadline.signal);
  expect(new Headers(init.headers).get("x-wf-profile-scope")).toBe("scope-test");
  const body = init.body as FormData;
  expect(body.get("file")).toBe(file);
  expect(JSON.parse(body.get("config") as string)).toEqual(config);
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
