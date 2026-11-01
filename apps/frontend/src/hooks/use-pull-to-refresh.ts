import { useUpdatePortfolioMutation } from "@/hooks/use-calculate-portfolio";
import { useHapticFeedback } from "@/hooks/use-haptic-feedback";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";

interface UsePullToRefreshOptions {
  threshold?: number;
  onRefresh?: () => Promise<void>;
  disabled?: boolean;
  activationThreshold?: number;
  startPullDistance?: number;
}

interface PullToRefreshHandlers {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
  onTouchCancel: (e: React.TouchEvent) => void;
}

interface PullToRefreshState {
  isPulling: boolean;
  pullDistance: number; // clamped 0..threshold
  progress: number; // 0..1
  isActivated: boolean; // user pulled beyond activation distance
}

export function usePullToRefresh({
  threshold = 80,
  onRefresh,
  disabled = false,
  activationThreshold,
  startPullDistance = 55,
}: UsePullToRefreshOptions = {}): [boolean, PullToRefreshHandlers, PullToRefreshState] {
  const queryClient = useQueryClient();
  const { mutateAsync: triggerPortfolioUpdate } = useUpdatePortfolioMutation();
  const { triggerHaptic: triggerHapticFeedback } = useHapticFeedback();
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);
  const [pullDistance, setPullDistance] = useState(0);
  const containerRef = useRef<HTMLElement | null>(null);
  const startYRef = useRef(0);
  const startXRef = useRef(0);
  const currentYRef = useRef(0);
  const activationDistance = activationThreshold ?? threshold * 2.5;
  const hasTriggeredHapticRef = useRef(false);
  const shouldCancelRef = useRef(false);
  const gestureRef = useRef<"PENDING" | "PULL" | "IGNORE">("PENDING");
  const [isActivated, setIsActivated] = useState(false);

  const handleRefresh = useCallback(async () => {
    if (isRefreshing || disabled) return;

    setIsRefreshing(true);
    try {
      if (onRefresh) {
        await onRefresh();
      } else {
        await triggerPortfolioUpdate();
        await queryClient.invalidateQueries();
      }
    } catch (error) {
      console.error("Pull to refresh failed:", error);
    } finally {
      setIsRefreshing(false);
      setIsPulling(false);
    }
  }, [queryClient, onRefresh, isRefreshing, disabled, triggerPortfolioUpdate]);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (disabled || isRefreshing) return;

      const touch = e.touches[0];
      if (!touch) return;

      const target = e.currentTarget as HTMLElement;

      containerRef.current = target;
      const touchY = touch.clientY;
      const touchX = touch.clientX;
      startYRef.current = touchY;
      startXRef.current = touchX;
      currentYRef.current = touchY;
      hasTriggeredHapticRef.current = false;
      shouldCancelRef.current = false;
      gestureRef.current = "PENDING";

      // Check if we are scrolling an inner container
      let element = e.target as HTMLElement;
      while (element && element !== target) {
        if (element.scrollTop > 0) {
          shouldCancelRef.current = true;
          break;
        }
        element = element.parentElement!;
      }
    },
    [disabled, isRefreshing],
  );

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (disabled || isRefreshing || !containerRef.current || shouldCancelRef.current) {
        return;
      }

      const target = containerRef.current;
      const content = target.querySelector<HTMLElement>("[data-ptr-content]") ?? null;
      const touch = e.touches[0];
      const touchY = touch?.clientY ?? startYRef.current;
      const touchX = touch?.clientX ?? startXRef.current;
      const deltaY = touchY - startYRef.current;
      const deltaX = Math.abs(touchX - startXRef.current);

      if (gestureRef.current === "IGNORE") {
        return;
      }

      if (gestureRef.current === "PENDING") {
        // Ignore small movements to avoid jitter
        if (Math.abs(deltaY) < 10 && deltaX < 10) {
          return;
        }

        // Determine gesture intent
        if (deltaY <= 0 || target.scrollTop > 0 || deltaX > deltaY) {
          gestureRef.current = "IGNORE";
          return;
        }

        gestureRef.current = "PULL";
      }

      if (gestureRef.current === "PULL") {
        e.preventDefault();
        target.style.touchAction = "none";
        currentYRef.current = touchY;

        const effectiveDelta = Math.max(deltaY - startPullDistance, 0);
        const distance = Math.min(effectiveDelta * 0.5, threshold);
        const isPastStartDistance = distance > 0;

        setIsPulling(isPastStartDistance);
        setPullDistance(distance);
        setIsActivated(deltaY > activationDistance);

        if (deltaY > activationDistance && !hasTriggeredHapticRef.current) {
          triggerHapticFeedback();
          hasTriggeredHapticRef.current = true;
        }

        if (content) {
          content.style.transition = "none";
          content.style.transform = `translateY(${distance}px)`;
        }
      }
    },
    [
      activationDistance,
      disabled,
      isRefreshing,
      startPullDistance,
      threshold,
      triggerHapticFeedback,
    ],
  );

  // A touch ends with touchend, or with touchcancel when the system takes it over (a
  // system gesture, a call): both put the content back, only touchend refreshes.
  const endGesture = useCallback(
    (refresh: boolean) => {
      if (disabled || !containerRef.current) return;

      const target = containerRef.current;
      const deltaY = currentYRef.current - startYRef.current;
      const pulled = gestureRef.current === "PULL";

      // Reset any container styles (defensive)
      target.style.transform = "";
      target.style.transition = "";

      // Trigger refresh if pulled far enough
      if (refresh && deltaY > activationDistance && isPulling) {
        handleRefresh();
      }

      // Reset state
      setIsPulling(false);
      setPullDistance(0);
      setIsActivated(false);
      startYRef.current = 0;
      currentYRef.current = 0;
      gestureRef.current = "PENDING";
      // Restore UA gesture handling
      target.style.touchAction = "";
      containerRef.current = null;
      hasTriggeredHapticRef.current = false;

      // Only a pull moved the content. Easing it back after a swipe or a scroll restyled
      // the whole page as the finger lifted, which stalled a sideways swipe.
      const content = pulled
        ? (target.querySelector<HTMLElement>("[data-ptr-content]") ?? null)
        : null;
      if (content) {
        content.style.transition = "transform 180ms ease-out";
        content.style.transform = "translateY(0px)";
        setTimeout(() => {
          content.style.transition = "";
          content.style.transform = "";
        }, 220);
      }
    },
    [activationDistance, disabled, handleRefresh, isPulling],
  );
  const onTouchEnd = useCallback(() => endGesture(true), [endGesture]);
  const onTouchCancel = useCallback(() => endGesture(false), [endGesture]);

  return [
    isRefreshing,
    {
      onTouchStart,
      onTouchMove,
      onTouchEnd,
      onTouchCancel,
    },
    {
      isPulling,
      pullDistance,
      progress: Math.min(1, pullDistance / threshold),
      isActivated,
    },
  ];
}
