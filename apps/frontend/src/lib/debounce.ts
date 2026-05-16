interface DebouncedFunction<TArgs extends unknown[]> {
  (...args: TArgs): void;
  cancel: () => void;
}

export function debounce<TArgs extends unknown[]>(
  callback: (...args: TArgs) => void,
  waitMs: number,
): DebouncedFunction<TArgs> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const debounced = (...args: TArgs) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      timeoutId = undefined;
      callback(...args);
    }, waitMs);
  };

  debounced.cancel = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };

  return debounced;
}
