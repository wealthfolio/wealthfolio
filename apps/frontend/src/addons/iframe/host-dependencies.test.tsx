import { act } from "@testing-library/react";
import type * as ReactDOMClient from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import "./host-dependencies";

afterEach(() => {
  globalThis.__wealthfolioWrapAddonReactNode = undefined;
  document.body.replaceChildren();
});

describe("sandbox React root", () => {
  it("wraps independently created addon roots with the host provider boundary", () => {
    const module = globalThis.__wealthfolioHostModules?.["react-dom/client"]?.module;
    const createRoot = module?.createRoot as typeof ReactDOMClient.createRoot;
    const container = document.createElement("div");
    document.body.append(container);
    globalThis.__wealthfolioWrapAddonReactNode = (children) => (
      <section data-testid="host-provider">{children}</section>
    );

    const root = createRoot(container);
    act(() => root.render(<span>Addon content</span>));

    expect(container.querySelector("[data-testid='host-provider']")?.textContent).toBe(
      "Addon content",
    );
    act(() => root.unmount());
  });
});
