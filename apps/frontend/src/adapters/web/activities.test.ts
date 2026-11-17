import { afterEach, expect, it, vi } from "vitest";
import { installProfileSession } from "@/features/profiles/session";
import { parseCsv } from "./activities";

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

it("passes a spreadsheet refusal on as its code", async () => {
  installProfileSession({ profileId: "test", scopeId: "scope-test" });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          errorCode: "SPREADSHEET_PASSWORD_PROTECTED",
          message: "This spreadsheet is password-protected.",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    ),
  );
  const file = new File([new Uint8Array([0xd0, 0xcf, 0x11, 0xe0])], "statement.xlsx");

  await expect(parseCsv(file, {})).rejects.toMatchObject({
    errorCode: "SPREADSHEET_PASSWORD_PROTECTED",
  });
});
