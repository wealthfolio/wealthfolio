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
  /** A slide was added or removed: Embla re-initialises on the snap it had. */
  reInit: (slides: number) => void;
  on: (event: string, listener: (api: FakeCarousel) => void) => FakeCarousel;
  off: (event: string, listener: (api: FakeCarousel) => void) => FakeCarousel;
}
const carousels: FakeCarousel[] = [];
// The number of slides the next carousel starts with.
const carouselSlides = { initial: 3 };
vi.mock("../../../../packages/ui/node_modules/embla-carousel-react", async () => {
  const { useEffect, useRef, useState } = await import("react");
  function makeCarousel(startIndex: number): FakeCarousel {
    let slides = carouselSlides.initial;
    // Like Embla, a jump past the last slide it has stops on that slide.
    const clamp = (index: number) => Math.min(index, slides - 1);
    const snaps = () => Array.from({ length: slides }, (_, index) => index / (slides - 1));
    let selected = clamp(startIndex);
    let position = selected;
    const listeners = new Map<string, Set<(api: FakeCarousel) => void>>();
    const emit = (event: string) => listeners.get(event)?.forEach((listener) => listener(carousel));
    const carousel: FakeCarousel = {
      selectedScrollSnap: () => selected,
      scrollSnapList: snaps,
      scrollProgress: () => snaps()[position] ?? 0,
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
          position = clamp(index);
          emit("settle");
          selected = clamp(index);
          emit("select");
          return;
        }
        carousel.select(clamp(index));
        carousel.arrive();
      },
      reInit: (count) => {
        // Embla restarts on the snap it had selected, clamped to the slides it now has.
        slides = count;
        selected = clamp(selected);
        position = selected;
        emit("reInit");
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
  carouselSlides.initial = 3;
});

it("opens on the URL's view when that view joins the page after the first render", async () => {
  // The dashboard's Spending tab appears once settings load, after the carousel is built.
  carouselSlides.initial = 2;
  const { rerender } = render(
    <MemoryRouter initialEntries={["/?tab=gamma"]}>
      <SwipablePage views={views.slice(0, 2)} />
      <Search />
    </MemoryRouter>,
  );
  await waitFor(() => expect(carousels).toHaveLength(1));
  const carousel = carousels[0];

  rerender(
    <MemoryRouter initialEntries={["/?tab=gamma"]}>
      <SwipablePage views={views} />
      <Search />
    </MemoryRouter>,
  );
  // Gamma's slide mounts: Embla re-initialises, still on the last slide it had.
  act(() => carousel.reInit(3));

  expect(carousel.selectedScrollSnap()).toBe(2);
  expect(screen.getByTestId("search")).toHaveTextContent("?tab=gamma");
  expect(screen.getByRole("button", { name: "Gamma" })).toHaveAttribute("aria-current", "page");
});

it("keeps a swipe when the carousel re-initialises before it lands", async () => {
  render(
    <MemoryRouter initialEntries={["/?tab=alpha"]}>
      <SwipablePage views={views} />
      <Search />
    </MemoryRouter>,
  );
  await waitFor(() => expect(carousels).toHaveLength(1));
  const carousel = carousels[0];

  // A swipe released toward Beta, then a resize (a rotation) re-initialises Embla on Beta.
  act(() => carousel.select(1));
  act(() => carousel.reInit(3));

  expect(carousel.selectedScrollSnap()).toBe(1);
  expect(screen.getByTestId("search")).toHaveTextContent("?tab=beta");
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

it("keeps a tap on a third view while a swipe heads elsewhere", async () => {
  render(
    <MemoryRouter initialEntries={["/?tab=alpha"]}>
      <SwipablePage views={views} />
      <Search />
    </MemoryRouter>,
  );
  await waitFor(() => expect(carousels).toHaveLength(1));
  const carousel = carousels[0];

  // A swipe released toward Beta, then a tap on Gamma before it lands.
  act(() => carousel.select(1));
  fireEvent.click(screen.getByRole("button", { name: "Gamma" }));
  act(() => carousel.arrive());

  expect(carousel.selectedScrollSnap()).toBe(2);
  expect(screen.getByTestId("search")).toHaveTextContent("?tab=gamma");
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
