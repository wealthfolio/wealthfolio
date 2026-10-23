import { useEffect, useRef, type DependencyList } from "react";

/**
 * `useEffect` for work that belongs to a change of its dependencies, not to the
 * component being shown. React runs a component's effects again each time a
 * hidden `<Activity>` shows it (a phone screen kept under another one, or in a
 * tab left and come back to), and StrictMode does the same in development.
 * Resetting a form when its record changes or its dialog opens is the typical
 * case: run again on show, it would clear what the user typed before leaving.
 */
export function useEffectOnChange(effect: () => void, deps: DependencyList) {
  const ranWith = useRef<DependencyList | null>(null);
  useEffect(() => {
    const previous = ranWith.current;
    if (
      previous?.length === deps.length &&
      previous.every((dependency, position) => Object.is(dependency, deps[position]))
    ) {
      return;
    }
    ranWith.current = deps;
    effect();
    // The dependencies are the caller's, checked at its call site (`additionalHooks`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
