import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { RawResponseViewer } from "./response-preview";

describe("RawResponseViewer", () => {
  it("selects Unicode JSON keys using quoted bracket notation", () => {
    const onPathClick = vi.fn();

    render(
      <RawResponseViewer
        rawResponse='[{"净值日期":"2026-07-11","单位净值":1.4018}]'
        format="json"
        onPathClick={onPathClick}
      />,
    );

    fireEvent.click(screen.getByText('"单位净值"').closest('[role="button"]')!);

    expect(onPathClick).toHaveBeenCalledWith('$[*]["单位净值"]');
  });
});
