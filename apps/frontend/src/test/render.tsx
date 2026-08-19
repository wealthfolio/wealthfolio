import {
  render as testingLibraryRender,
  renderHook as testingLibraryRenderHook,
  type RenderHookOptions,
  type RenderOptions,
} from "@testing-library/react";
import { FormattingProvider } from "@wealthfolio/ui";
import type { ComponentType, ReactElement, ReactNode } from "react";

export * from "@testing-library/react";

function withFormatting(Wrapper?: ComponentType<{ children: ReactNode }>) {
  return function TestProviders({ children }: { children: ReactNode }) {
    const content = Wrapper ? <Wrapper>{children}</Wrapper> : children;
    return <FormattingProvider locale="en-US">{content}</FormattingProvider>;
  };
}

export function render(ui: ReactElement, options: RenderOptions = {}) {
  const { wrapper, ...renderOptions } = options;
  return testingLibraryRender(ui, {
    ...renderOptions,
    wrapper: withFormatting(wrapper),
  });
}

export function renderHook<Result, Props>(
  callback: (props: Props) => Result,
  options: RenderHookOptions<Props> = {},
) {
  const { wrapper, ...renderOptions } = options;
  return testingLibraryRenderHook(callback, {
    ...renderOptions,
    wrapper: withFormatting(wrapper),
  });
}
