import { afterEach, expect, it, vi } from "vitest";
import { openUrlInBrowser } from "./files";

afterEach(() => vi.restoreAllMocks());

it("opens a new tab without an opener reference or referrer", async () => {
  const open = vi.spyOn(window, "open").mockReturnValue(null);

  await expect(openUrlInBrowser("https://example.com/docs")).resolves.toBeUndefined();

  expect(open).toHaveBeenCalledExactlyOnceWith(
    "https://example.com/docs",
    "_blank",
    "noopener,noreferrer",
  );
});
