import { act, render, waitFor } from "@testing-library/react";
import { SwipableView } from "@wealthfolio/ui";
import { Activity, useState } from "react";
import { expect, it, vi } from "vitest";

// jsdom has no layout, so Embla finds no slides to snap to. This stand-in keeps
// what matters here: like Embla's React hook, it builds the carousel in an
// effect, on `startIndex`, and destroys it in the effect's cleanup.
interface FakeCarousel {
  selectedScrollSnap: () => number;
  scrollSnapList: () => number[];
  scrollTo: (index: number) => void;
  on: (event: string, listener: (api: FakeCarousel) => void) => FakeCarousel;
  off: (event: string, listener: (api: FakeCarousel) => void) => FakeCarousel;
}
const carousels: FakeCarousel[] = [];
// Embla is a dependency of @wealthfolio/ui only, so the copy it resolves is mocked.
vi.mock("../../../../packages/ui/node_modules/embla-carousel-react", async () => {
  const { useEffect, useRef, useState } = await import("react");
  function makeCarousel(startIndex: number): FakeCarousel {
    let selected = startIndex;
    const listeners = new Set<(api: FakeCarousel) => void>();
    const carousel: FakeCarousel = {
      selectedScrollSnap: () => selected,
      scrollSnapList: () => [0, 1, 2],
      scrollTo: (index) => {
        selected = index;
        listeners.forEach((listener) => listener(carousel));
      },
      on: (event, listener) => {
        if (event === "select") listeners.add(listener);
        return carousel;
      },
      off: (_event, listener) => {
        listeners.delete(listener);
        return carousel;
      },
    };
    return carousel;
  }
  return {
    default: function useFakeCarousel(options: { startIndex?: number }) {
      const startIndex = useRef(options.startIndex ?? 0);
      const [api, setApi] = useState<FakeCarousel>();
      useEffect(() => {
        const carousel = makeCarousel(startIndex.current);
        carousels.push(carousel);
        setApi(carousel);
      }, []);
      return [() => undefined, api];
    },
  };
});
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", NoopObserver);
vi.stubGlobal("ResizeObserver", NoopObserver);

it("stays on its view when its phone screen is shown again", async () => {
  // A phone screen kept under another one, or in a tab left for another, is a
  // hidden <Activity>: its carousel is built anew when it is shown again.
  const items = ["About", "Holdings", "Activities"].map((name) => ({
    name,
    content: <p>{name}</p>,
  }));
  const onViewChange = vi.fn();
  let setHidden: (hidden: boolean) => void = () => undefined;
  function AssetScreen() {
    const [hidden, setHiddenState] = useState(false);
    setHidden = setHiddenState;
    return (
      <Activity mode={hidden ? "hidden" : "visible"}>
        <SwipableView items={items} onViewChange={onViewChange} />
      </Activity>
    );
  }
  render(<AssetScreen />);
  await waitFor(() => expect(carousels).toHaveLength(1));
  act(() => carousels[0].scrollTo(2));
  expect(onViewChange).toHaveBeenCalledExactlyOnceWith(2, "Activities");

  act(() => setHidden(true));
  act(() => setHidden(false));

  await waitFor(() => expect(carousels).toHaveLength(2));
  expect(carousels[1].selectedScrollSnap()).toBe(2);
  expect(onViewChange).toHaveBeenCalledTimes(1);
});
