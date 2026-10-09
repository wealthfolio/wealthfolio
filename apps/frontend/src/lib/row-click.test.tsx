import { fireEvent, render, screen } from "@testing-library/react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isRowBodyClick } from "./row-click";

function renderRow(onRowBody: () => void, portalTarget?: HTMLElement) {
  return render(
    <table>
      <tbody>
        <tr data-testid="row" onClick={(e) => isRowBodyClick(e) && onRowBody()}>
          <td>Plain text</td>
          <td>
            <button type="button">Button</button>
            <a href="#holding">Link</a>
            <span role="presentation">
              <input aria-label="Input" />
            </span>
          </td>
          <td data-row-click-ignore>Ignored cell</td>
          <td>{portalTarget && createPortal(<div>Portalled menu</div>, portalTarget)}</td>
        </tr>
      </tbody>
    </table>,
  );
}

describe("isRowBodyClick", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
  });

  it("accepts a click on the row's own content", () => {
    const onRowBody = vi.fn();
    renderRow(onRowBody);

    fireEvent.click(screen.getByText("Plain text"));

    expect(onRowBody).toHaveBeenCalledTimes(1);
  });

  it("ignores clicks on controls and on cells that opt out", () => {
    const onRowBody = vi.fn();
    renderRow(onRowBody);

    fireEvent.click(screen.getByText("Button"));
    fireEvent.click(screen.getByText("Link"));
    fireEvent.click(screen.getByLabelText("Input"));
    fireEvent.click(screen.getByText("Ignored cell"));

    expect(onRowBody).not.toHaveBeenCalled();
  });

  it("ignores clicks inside portalled content that bubble through React", () => {
    const onRowBody = vi.fn();
    renderRow(onRowBody, document.body);

    fireEvent.click(screen.getByText("Portalled menu"));

    expect(onRowBody).not.toHaveBeenCalled();
  });

  it("ignores the click that ends a text selection", () => {
    const onRowBody = vi.fn();
    renderRow(onRowBody);
    const text = screen.getByText("Plain text");
    window.getSelection()?.selectAllChildren(text);

    fireEvent.click(text);

    expect(onRowBody).not.toHaveBeenCalled();
  });
});
