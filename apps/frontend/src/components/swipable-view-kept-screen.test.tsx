import { act, render, waitFor } from "@testing-library/react";
import { SwipableView } from "@wealthfolio/ui";
import { Activity, useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";

// jsdom has no layout, so Embla finds no slides to snap to. This stand-in keeps
// what matters here: like Embla's React hook, it builds the carousel in an
// effect, on `startIndex`, and destroys it in the effect's cleanup. Like Embla,
// a scroll selects its snap first (a swipe's release), then scrolls there and settles;
// a jump settles before it selects.
interface FakeCarousel {
  selectedScrollSnap: () => number;
  scrollSnapList: () => number[];
  scrollProgress: () => number;
  select: (index: number) => void;
  arrive: () => void;
  scrollTo: (index: number, jump?: boolean) => void;
  emit: (event: string) => void;
  on: (event: string, listener: (api: FakeCarousel) => void) => FakeCarousel;
  off: (event: string, listener: (api: FakeCarousel) => void) => FakeCarousel;
}
const carousels: FakeCarousel[] = [];
const startIndexes: (number | undefined)[] = [];
// Embla is a dependency of @wealthfolio/ui only, so the copy it resolves is mocked.
vi.mock("../../../../packages/ui/node_modules/embla-carousel-react", async () => {
  const { useEffect, useRef, useState } = await import("react");
  function makeCarousel(startIndex: number): FakeCarousel {
    let selected = startIndex;
    let position = startIndex;
    const listeners = new Map<string, Set<(api: FakeCarousel) => void>>();
    const emit = (event: string) => listeners.get(event)?.forEach((listener) => listener(carousel));
    const carousel: FakeCarousel = {
      selectedScrollSnap: () => selected,
      scrollSnapList: () => [0, 1, 2],
      scrollProgress: () => position,
      select: (index) => {
        selected = index;
        emit("select");
      },
      arrive: () => {
        position = selected;
        emit("scroll");
        emit("settle");
      },
      scrollTo: (index, jump) => {
        if (!jump) {
          carousel.select(index);
          carousel.arrive();
          return;
        }
        // Like Embla, a jump settles before it selects the new snap.
        position = index;
        emit("settle");
        selected = index;
        emit("select");
      },
      emit,
      on: (event, listener) => {
        const set = listeners.get(event) ?? new Set();
        set.add(listener);
        listeners.set(event, set);
        return carousel;
      },
      off: (event, listener) => {
        listeners.get(event)?.delete(listener);
        return carousel;
      },
    };
    return carousel;
  }
  return {
    default: function useFakeCarousel(options: { startIndex?: number }) {
      startIndexes.push(options.startIndex);
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

const items = ["About", "Holdings", "Activities"].map((name) => ({
  name,
  content: <p>{name}</p>,
}));

beforeEach(() => {
  carousels.length = 0;
  startIndexes.length = 0;
});

it("stays on its view when its phone screen is shown again", async () => {
  // A phone screen kept under another one, or in a tab left for another, is a
  // hidden <Activity>: its carousel is built anew when it is shown again.
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

it("reports a swipe's view change when the slide lands, not on release", async () => {
  // The page re-renders for a new view, and doing that while the slide still
  // moved froze it halfway.
  const onViewChange = vi.fn();
  const onSelectView = vi.fn();
  render(<SwipableView items={items} onViewChange={onViewChange} onSelectView={onSelectView} />);
  await waitFor(() => expect(carousels).toHaveLength(1));

  // The header can follow on release; the page waits.
  act(() => carousels[0].select(1));
  expect(onSelectView).toHaveBeenLastCalledWith(1, "Holdings");
  expect(onViewChange).not.toHaveBeenCalled();

  act(() => carousels[0].arrive());
  expect(onViewChange).toHaveBeenCalledExactlyOnceWith(1, "Holdings");
});

it("keeps Embla's start index when the page's view changes", async () => {
  // Embla re-initialises when its options change, which jumps to the start
  // index and cuts the slide's settle animation short.
  const { rerender } = render(<SwipableView items={items} initialIndex={0} selectedIndex={0} />);
  await waitFor(() => expect(carousels).toHaveLength(1));

  rerender(<SwipableView items={items} initialIndex={1} selectedIndex={1} />);

  expect(new Set(startIndexes)).toEqual(new Set([0]));
});

it("reports the start of a swipe once, when a drag first moves the slide", async () => {
  const onSwipeStart = vi.fn();
  render(<SwipableView items={items} onSwipeStart={onSwipeStart} />);
  await waitFor(() => expect(carousels).toHaveLength(1));
  const carousel = carousels[0];

  // A tap or a vertical scroll presses without moving the slide.
  act(() => {
    carousel.emit("pointerDown");
    carousel.emit("pointerUp");
  });
  expect(onSwipeStart).not.toHaveBeenCalled();

  act(() => {
    carousel.emit("pointerDown");
    carousel.emit("scroll");
    carousel.emit("scroll");
  });
  expect(onSwipeStart).toHaveBeenCalledOnce();

  // The slide settling after release is not a new swipe.
  act(() => {
    carousel.emit("pointerUp");
    carousel.emit("scroll");
  });
  expect(onSwipeStart).toHaveBeenCalledOnce();
});

it("reports a swipe back after the page jumped to another view", async () => {
  // A tap on another view's pill jumps the carousel there. Unless that jump counts as
  // landed, swiping back to the first view looks like no change.
  const onViewChange = vi.fn();
  const { rerender } = render(
    <SwipableView items={items} selectedIndex={0} onViewChange={onViewChange} />,
  );
  await waitFor(() => expect(carousels).toHaveLength(1));

  rerender(<SwipableView items={items} selectedIndex={1} onViewChange={onViewChange} />);
  expect(carousels[0].selectedScrollSnap()).toBe(1);
  expect(onViewChange).not.toHaveBeenCalled();

  act(() => {
    carousels[0].select(0);
    carousels[0].arrive();
  });
  expect(onViewChange).toHaveBeenCalledExactlyOnceWith(0, "About");
});
