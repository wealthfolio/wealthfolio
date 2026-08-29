import { useEffect, useRef } from "react";

/**
 * Custom hook for intersection observer (infinite scroll trigger).
 */
export function useIntersectionObserver(
  callback: () => void,
  options?: {
    enabled?: boolean;
    rootMargin?: string;
  },
) {
  const ref = useRef<HTMLDivElement | null>(null);
  const { enabled = true, rootMargin = "100px" } = options ?? {};

  useEffect(() => {
    if (!enabled) return;

    const element = ref.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          callback();
        }
      },
      { rootMargin },
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [callback, enabled, rootMargin]);

  return ref;
}
