import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { SwipablePage } from "@/components/page/swipable-page";

// jsdom has no layout, so Embla finds no slides to snap to. Like Embla, this stand-in
// selects a snap first (a swipe's release), then scrolls there and settles.
interface FakeCarousel {
  selectedScrollSnap: () => number;
  scrollSnapList: () => number[];
  scrollProgress: () => number;
  select: (index: number) => void;
  arrive: () => void;
  scrollTo: (index: number, jump?: boolean) => void;
  on: (event: string, listener: (api: FakeCarousel) => void) => FakeCarousel;
  off: (event: string, listener: (api: FakeCarousel) => void) => FakeCarousel;
}
const carousels: FakeCarousel[] = [];
vi.mock("../../../../packages/ui/node_modules/embla-carousel-react", async () => {
  const { useEffect, useRef, useState } = await import("react");
  function makeCarousel(startIndex: number): FakeCarousel {
    let selected = startIndex;
    let position = startIndex;
    const listeners = new Map<string, Set<(api: FakeCarousel) => void>>();
    const emit = (event: string) => listeners.get(event)?.forEach((listener) => listener(carousel));
    const carousel: FakeCarousel = {
      selectedScrollSnap: () => selected,
      scrollSnapList: () => [0, 0.5, 1],
      scrollProgress: () => [0, 0.5, 1][position] ?? 0,
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
        if (jump) {
          position = index;
          emit("settle");
          selected = index;
          emit("select");
          return;
        }
        carousel.select(index);
        carousel.arrive();
      },
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
vi.mock("@/hooks", () => ({
  useIsMobileViewport: () => true,
  useHapticFeedback: () => ({ triggerHaptic: () => undefined }),
}));
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", NoopObserver);
vi.stubGlobal("ResizeObserver", NoopObserver);

const views = ["Alpha", "Beta", "Gamma"].map((label) => ({
  value: label.toLowerCase(),
  label,
  content: <p>{label} content</p>,
}));

function Search() {
  return <output data-testid="search">{useLocation().search}</output>;
}

beforeEach(() => {
  carousels.length = 0;
});

it("sends a pending swipe back when the current view's pill is tapped", async () => {
  render(
    <MemoryRouter initialEntries={["/?tab=alpha"]}>
      <SwipablePage views={views} />
      <Search />
    </MemoryRouter>,
  );
  await waitFor(() => expect(carousels).toHaveLength(1));
  const carousel = carousels[0];

  // A swipe released toward Beta: the header follows at once, the page on landing.
  act(() => carousel.select(1));
  expect(screen.getByRole("button", { name: "Beta" })).toHaveAttribute("aria-current", "page");

  // A tap on Alpha before the slide lands wins over the swipe.
  fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
  act(() => carousel.arrive());

  expect(carousel.selectedScrollSnap()).toBe(0);
  expect(screen.getByRole("button", { name: "Alpha" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByTestId("search")).toHaveTextContent("?tab=alpha");
});

it("switches the page once a swipe lands", async () => {
  render(
    <MemoryRouter initialEntries={["/?tab=alpha"]}>
      <SwipablePage views={views} />
      <Search />
    </MemoryRouter>,
  );
  await waitFor(() => expect(carousels).toHaveLength(1));

  act(() => {
    carousels[0].select(2);
    carousels[0].arrive();
  });

  expect(screen.getByTestId("search")).toHaveTextContent("?tab=gamma");
});
