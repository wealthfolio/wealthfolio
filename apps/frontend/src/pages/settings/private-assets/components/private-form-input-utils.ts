import type React from "react";

function resolveInput(event: React.SyntheticEvent<HTMLElement>) {
  if (event.target instanceof HTMLInputElement) {
    return event.target;
  }

  return event.currentTarget.querySelector("input");
}

function selectZeroValueInput(event: React.SyntheticEvent<HTMLElement>, value: number | undefined) {
  if (value !== 0) {
    return;
  }

  resolveInput(event)?.select();
}

export function getZeroValueSelectionProps(value: number | undefined) {
  return {
    onFocusCapture: (event: React.FocusEvent<HTMLElement>) => {
      selectZeroValueInput(event, value);
    },
    onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
      selectZeroValueInput(event, value);
    },
  };
}
