import i18n from "i18next";

export const DEFAULT_RETURN_SLIDER_MAX = 0.12;
export const RATE_SLIDER_INCREMENT = 0.02;
export const HIGH_RETURN_WARNING_THRESHOLD = DEFAULT_RETURN_SLIDER_MAX;

export function highReturnWarning(value: number) {
  return value > HIGH_RETURN_WARNING_THRESHOLD
    ? i18n.t("goals:save_up.highReturnWarning")
    : undefined;
}
